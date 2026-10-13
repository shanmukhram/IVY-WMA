using Ivy.Core.Agent;
using Ivy.Core.Storage;
using Ivy.Core.Upload;

namespace Ivy.App.Core.Hosting;

/// <summary>Pending queue totals for one collector (or for <c>""</c>, items with no collector).</summary>
public sealed record QueueStats(int Objects, long Bytes, int Retrying);

/// <summary>Everything the window polls once a second: queue state and bucket reachability.</summary>
public sealed record AgentSnapshot
{
    public int PendingObjects { get; init; }
    public long PendingBytes { get; init; }
    /// <summary>Pending items that have failed at least once and are waiting on backoff.</summary>
    public int RetryingObjects { get; init; }
    public IReadOnlyDictionary<string, QueueStats> ByCollector { get; init; } = new Dictionary<string, QueueStats>();
    /// <summary>Latest <c>uploaded</c> activity per collector.</summary>
    public IReadOnlyDictionary<string, DateTimeOffset> LastUploadByCollector { get; init; } = new Dictionary<string, DateTimeOffset>();
    /// <summary>Latest <c>queued</c> activity per collector (a capture reached the encrypted queue).</summary>
    public IReadOnlyDictionary<string, DateTimeOffset> LastQueuedByCollector { get; init; } = new Dictionary<string, DateTimeOffset>();
    /// <summary>Last successful up-bucket put.</summary>
    public DateTimeOffset? LastUpPutAt { get; init; }
    /// <summary>Set when the most recent up-bucket attempt failed (newer than the last success).</summary>
    public string? UpError { get; init; }
    public DateTimeOffset? UpErrorAt { get; init; }
    /// <summary>Last successful cmd-bucket list (command poll).</summary>
    public DateTimeOffset? LastCmdListAt { get; init; }
    public string? CmdError { get; init; }

    public QueueStats For(string collector) => ByCollector.TryGetValue(collector, out var s) ? s : new QueueStats(0, 0, 0);
}

/// <summary>
/// The view models' window onto <see cref="VaultAgent"/>. Kept as an interface so the view models are
/// testable without R2; <see cref="VaultAgentView"/> is the real implementation.
/// </summary>
public interface IAgentView
{
    bool IsPaired { get; }
    string? DeviceFingerprint { get; }
    string? MacFingerprint { get; }

    Task<PairingResult> PairAsync(string pairingString, CancellationToken ct = default);

    /// <summary>Device fingerprint as soon as the keypair exists during pairing (worker thread).</summary>
    event EventHandler<string>? DeviceFingerprintAvailable;
    /// <summary>Every activity_log append (worker thread).</summary>
    event EventHandler<ActivityEntry>? ActivityAppended;
    /// <summary>Uploader per-object progress (worker thread).</summary>
    event EventHandler<UploadProgress>? UploadProgress;

    IReadOnlyList<ActivityEntry> RecentActivity(int limit);

    /// <summary>Uploader pause flag (persisted by the uploader). False before pairing.</summary>
    bool UploadsPaused { get; set; }
    /// <summary>Bandwidth cap in bytes/second, 0 = unlimited (persisted by the uploader).</summary>
    long BandwidthBytesPerSecond { get; set; }

    AgentSnapshot Snapshot();

    /// <summary>Poll commands, send a device report, drain the queue.</summary>
    Task SyncNowAsync(CancellationToken ct = default);

    /// <summary>
    /// The Mac sent an <c>unpair</c> command and the agent has already reset itself (keys, tokens, pairing state, queue
    /// and cursors cleared, collectors stopped). Raised on a worker thread.
    /// </summary>
    event EventHandler? Unpaired;

    /// <summary>
    /// Completes after the first command poll following start (or a 10 s timeout), so a pending unpair is handled
    /// before any collector runs. Already complete when not paired.
    /// </summary>
    Task WaitForFirstPollAsync();

    string? GetSetting(string key);
    void SetSetting(string key, string value);
}
