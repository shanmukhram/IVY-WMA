using Ivy.Core.Agent;
using Ivy.Core.Protocol;
using Ivy.Core.Storage;
using Ivy.Core.Upload;

namespace Ivy.App.Core.Hosting;

/// <summary>
/// <see cref="IAgentView"/> over a running <see cref="VaultAgent"/>. The uploader only exists once the
/// device is paired, so progress subscription and the pause/bandwidth settings are (re)attached after
/// <see cref="PairAsync"/>. Snapshot queries are aggregate SQL against vault-agent.db so the window can
/// refresh every second even with a large initial-index queue.
/// </summary>
public sealed class VaultAgentView : IAgentView, IDisposable
{
    private readonly VaultAgent _agent;
    private Uploader? _attached;
    private readonly object _lock = new();

    public VaultAgentView(VaultAgent agent)
    {
        _agent = agent;
        _agent.Activity.Appended += OnAppended;
        _agent.Pairing.DeviceFingerprintAvailable += OnFingerprint;
        Attach();
    }

    public VaultAgent Agent => _agent;

    public bool IsPaired => _agent.Pairing.IsPaired;
    public string? DeviceFingerprint => _agent.PairingState?.DeviceFingerprint ?? _agent.Keys.LoadPairingState()?.DeviceFingerprint;
    public string? MacFingerprint => _agent.PairingState?.MacFingerprint ?? _agent.Keys.LoadPairingState()?.MacFingerprint;

    public event EventHandler<string>? DeviceFingerprintAvailable;
    public event EventHandler<ActivityEntry>? ActivityAppended;
    public event EventHandler<UploadProgress>? UploadProgress;

    public async Task<PairingResult> PairAsync(string pairingString, CancellationToken ct = default)
    {
        var r = await _agent.PairAsync(pairingString, ct).ConfigureAwait(false);
        Attach();
        return r;
    }

    public IReadOnlyList<ActivityEntry> RecentActivity(int limit) => _agent.Activity.Recent(limit);

    public bool UploadsPaused
    {
        get => _agent.Uploader?.Paused ?? false;
        set
        {
            if (_agent.Uploader is { } u) u.Paused = value;
        }
    }

    public long BandwidthBytesPerSecond
    {
        get => _agent.Uploader?.BandwidthBytesPerSecond ?? 0;
        set
        {
            if (value < 0) throw new ArgumentOutOfRangeException(nameof(value));
            if (_agent.Uploader is { } u) u.BandwidthBytesPerSecond = value;
        }
    }

    public Task SyncNowAsync(CancellationToken ct = default) => _agent.SyncNowAsync(ct);

    public string? GetSetting(string key) => _agent.Db.GetSetting(key);
    public void SetSetting(string key, string value) => _agent.Db.SetSetting(key, value);

    public AgentSnapshot Snapshot()
    {
        var by = new Dictionary<string, QueueStats>(StringComparer.Ordinal);
        int objects = 0, retrying = 0;
        long bytes = 0;
        var lastUpload = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
        var lastQueued = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
        long okId = 0, failId = 0;
        DateTimeOffset? lastPut = null, failAt = null;
        string? failDetail = null;

        using (var c = _agent.Db.Open())
        {
            using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = """
                    SELECT COALESCE(collector, ''), COUNT(*), COALESCE(SUM(size), 0), SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END)
                    FROM pending_uploads WHERE status <> 'done' GROUP BY COALESCE(collector, '')
                    """;
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    var s = new QueueStats((int)r.GetInt64(1), r.GetInt64(2), (int)r.GetInt64(3));
                    by[r.GetString(0)] = s;
                    objects += s.Objects;
                    bytes += s.Bytes;
                    retrying += s.Retrying;
                }
            }
            using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = """
                    SELECT COALESCE(a.collector, ''), a.event, a.id, a.timestamp, a.detail FROM activity_log a
                    JOIN (SELECT COALESCE(collector, '') AS col, event, MAX(id) AS mid FROM activity_log
                          WHERE event IN ($up, $fail, $queued) GROUP BY COALESCE(collector, ''), event) m
                    ON a.id = m.mid
                    """;
                cmd.Parameters.AddWithValue("$up", ActivityEvents.Uploaded);
                cmd.Parameters.AddWithValue("$fail", ActivityEvents.UploadFailed);
                cmd.Parameters.AddWithValue("$queued", ActivityEvents.Queued);
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    var col = r.GetString(0);
                    var evt = r.GetString(1);
                    var id = r.GetInt64(2);
                    if (!TryParse(r.GetString(3), out var t)) continue;
                    switch (evt)
                    {
                        case ActivityEvents.Uploaded:
                            lastUpload[col] = t;
                            if (id > okId) { okId = id; lastPut = t; }
                            break;
                        case ActivityEvents.UploadFailed:
                            if (id > failId) { failId = id; failAt = t; failDetail = r.IsDBNull(4) ? null : r.GetString(4); }
                            break;
                        case ActivityEvents.Queued:
                            lastQueued[col] = t;
                            break;
                    }
                }
            }
        }

        var poller = _agent.Poller;
        var upFailing = failId > okId;
        return new AgentSnapshot
        {
            PendingObjects = objects,
            PendingBytes = bytes,
            RetryingObjects = retrying,
            ByCollector = by,
            LastUploadByCollector = lastUpload,
            LastQueuedByCollector = lastQueued,
            LastUpPutAt = lastPut,
            UpError = upFailing ? failDetail ?? "upload failed" : null,
            UpErrorAt = upFailing ? failAt : null,
            LastCmdListAt = poller?.LastPollAt,
            CmdError = poller?.LastPollError,
        };
    }

    private static bool TryParse(string s, out DateTimeOffset t)
    {
        try
        {
            t = IvyTime.Parse(s);
            return true;
        }
        catch (FormatException)
        {
            t = default;
            return false;
        }
    }

    private void Attach()
    {
        lock (_lock)
        {
            var u = _agent.Uploader;
            if (ReferenceEquals(u, _attached)) return;
            if (_attached is not null) _attached.Progress -= OnProgress;
            _attached = u;
            if (u is not null) u.Progress += OnProgress;
        }
    }

    private void OnAppended(object? sender, ActivityEntry e) => ActivityAppended?.Invoke(this, e);
    private void OnFingerprint(object? sender, string fp) => DeviceFingerprintAvailable?.Invoke(this, fp);
    private void OnProgress(object? sender, UploadProgress p) => UploadProgress?.Invoke(this, p);

    public void Dispose()
    {
        _agent.Activity.Appended -= OnAppended;
        _agent.Pairing.DeviceFingerprintAvailable -= OnFingerprint;
        lock (_lock)
        {
            if (_attached is not null) _attached.Progress -= OnProgress;
            _attached = null;
        }
    }
}
