using System.Text.Json.Nodes;
using Ivy.Collectors.Common;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;

namespace Ivy.Collectors.Line;

/// <summary>The states shown in the LINE row (PRD WL item 5), derived from the last tick.</summary>
public enum LineState
{
    /// <summary>LINE for Windows was not found on this machine.</summary>
    NotInstalled,
    /// <summary>LINE is present but we have never produced a probe report — run the probe first.</summary>
    ProbeNeeded,
    /// <summary>A data folder exists but holds no file matching the db pattern.</summary>
    StoreNotFound,
    /// <summary>The store is encrypted and no unlocker is implemented for this version (red, WL3).</summary>
    EncryptedStore,
    /// <summary>The map did not verify against the real store (schema drift, bad timestamp) — red, WL3.</summary>
    UnverifiedMap,
    /// <summary>Verified and capturing; coverage is always partial from Windows (WL2).</summary>
    OkPartial,
}

/// <summary>
/// LINE desktop collector (PRD WL1–WL3, PLAN task 1.12). Two layers: the <see cref="LineStoreProbe"/> tells
/// us the real layout, and this adapter pins a <see cref="LineStoreMap"/> per LINE version and re-verifies it
/// against the real store on start and after every detected version change. If verification fails nothing is
/// captured and the row is red with the reason (WL3). If it passes, it walks messages with a per-chat cursor
/// and emits <c>message_batch</c> records with <c>sourceSession = "windows:line-desktop"</c> and
/// <c>coverage = partial</c> always (WL2). Encrypted stores go through <see cref="ILineStoreUnlocker"/>, whose
/// default reports an honest red state rather than guessing a key.
/// </summary>
public sealed class LineDesktopCollector : Collector<LineSettings>
{
    private readonly IReadOnlyList<LineProbeRoot>? _rootsOverride;
    private readonly ILineStoreUnlocker _unlocker;
    private readonly Func<string, LineStoreMap> _mapFor;
    private readonly string _reportDir;
    private readonly string _tempRoot;

    private Dictionary<string, long> _cursors = new(StringComparer.Ordinal);
    private string? _verifiedVersion;

    public LineDesktopCollector(
        CollectorContext context,
        LineSettings? settings = null,
        IReadOnlyList<LineProbeRoot>? roots = null,
        ILineStoreUnlocker? unlocker = null,
        Func<string, LineStoreMap>? mapFor = null,
        string? reportDir = null,
        string? tempRoot = null)
        : base(CollectorNames.Line, context, settings)
    {
        _rootsOverride = roots;
        _unlocker = unlocker ?? NotImplementedUnlocker.Instance;
        _mapFor = mapFor ?? (_ => LineStoreMap.ShippedDefault);
        _reportDir = reportDir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "IVY");
        _tempRoot = tempRoot ?? Path.Combine(Path.GetTempPath(), "ivy-line");
    }

    public override TimeSpan Interval => TimeSpan.FromSeconds(Settings.PollSeconds);

    /// <summary>Last tick's state (for the UI/tests).</summary>
    public LineState State { get; private set; } = LineState.ProbeNeeded;

    /// <summary>Path of the last probe report written, surfaced in the UI with a button to open it.</summary>
    public string? LastReportPath { get; private set; }

    protected override void Validate(LineSettings s)
    {
        if (s.PollSeconds < 5) throw new ArgumentException("pollSeconds must be >= 5");
        if (s.BatchSize is < 1 or > 100_000) throw new ArgumentException("batchSize must be 1..100000");
    }

    public override Task StartAsync(CancellationToken ct)
    {
        _cursors = LoadCursors();
        _verifiedVersion = null;
        return Task.CompletedTask;
    }

    public override Task TickAsync(CancellationToken ct)
    {
        var version = Settings.Version ?? "unknown";

        if (Settings.RunProbe)
        {
            RunProbe(version);
            ClearRunProbe();
        }

        var dataFolder = ResolveDataFolder();
        if (dataFolder is null)
        {
            State = LineState.NotInstalled;
            Detail = "LINE for Windows not found" + (LastReportPath is null ? "" : $"; report {LastReportPath}");
            return Task.CompletedTask;
        }

        var map = _mapFor(version);
        if (_verifiedVersion is not null && _verifiedVersion != version)
            Detail = $"LINE version changed {_verifiedVersion} -> {version}; re-verifying";

        var dbPath = LineStore.FindDb(dataFolder, map.DbFilePattern);
        if (dbPath is null)
        {
            State = LineState.StoreNotFound;
            _verifiedVersion = null;
            SetError($"no file matching '{map.DbFilePattern}' in {dataFolder}" +
                     (LastReportPath is null ? " (run the probe to see the real layout)" : $"; see report {LastReportPath}"));
            return Task.CompletedTask;
        }

        using var snapshot = LineSnapshot.TryCreate(dbPath, _tempRoot, out var snapReason);
        if (snapshot is null)
        {
            State = LineState.StoreNotFound;
            _verifiedVersion = null;
            SetError(snapReason ?? "could not snapshot the LINE store");
            return Task.CompletedTask;
        }

        using var store = LineStore.Open(snapshot.Directory, map, _unlocker, out var openReason);
        if (store is null)
        {
            _verifiedVersion = null;
            var reason = openReason ?? "the LINE store could not be read";
            // Tell the encrypted case apart for the UI state from the file's own header, not the reason text:
            // a store whose header is not "SQLite format 3" is encrypted; otherwise the map did not verify (WL3).
            State = IsPlainSqlite(dbPath) ? LineState.UnverifiedMap : LineState.EncryptedStore;
            SetError(reason);
            return Task.CompletedTask;
        }

        _verifiedVersion = version;
        var sink = Sink;
        if (sink is null) return Task.CompletedTask; // not paired yet; verified, nothing to emit

        var chats = store.Chats();
        var newMessages = 0;
        foreach (var chat in chats)
        {
            if (ct.IsCancellationRequested) break;
            var cursor = _cursors.GetValueOrDefault(chat.ChatId, 0L);
            while (true)
            {
                var page = store.ReadMessages(chat.ChatId, cursor, Settings.BatchSize);
                if (page.Messages.Count > 0)
                {
                    EmitBatch(sink, map, chat, page);
                    newMessages += page.Messages.Count;
                }
                if (page.MaxRowId > cursor)
                {
                    cursor = page.MaxRowId;
                    _cursors[chat.ChatId] = cursor;
                    SaveCursors();
                }
                if (!page.HasMore) break;
            }
        }

        State = LineState.OkPartial;
        Cursor = $"chats={chats.Count}";
        Detail = $"ok partial: {chats.Count} chats, {newMessages} new this tick (coverage partial, mirror of the phone)";
        return Task.CompletedTask;
    }

    private void EmitBatch(IRecordSink sink, LineStoreMap map, LineChat chat, LineMessagePage page)
    {
        var last = page.Messages[^1];
        var batch = new MessageBatchRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = last.SentAt,
            CaptureTime = IvyTime.Format(Now),
            Platform = MessagePlatforms.Line,
            Account = Settings.Account,
            ConvKey = chat.ChatId,
            Peer = chat.ConvKind == "dm" ? chat.Title ?? chat.ChatId : null,
            ConvKind = chat.ConvKind,
            SourceSession = SourceSessions.WindowsLineDesktop,
            Coverage = MessageCoverage.Partial, // WL2: never above partial from Windows, whatever the store holds
            ChatMeta = new ChatMeta { Title = chat.Title, ChatType = chat.ChatType },
            Messages = page.Messages,
            Cursor = page.MaxRowId.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };
        Emit(sink, batch);
    }

    private void RunProbe(string version)
    {
        try
        {
            var roots = _rootsOverride ?? (Settings.DataPath is { } p
                ? new[] { new LineProbeRoot("override", p) }
                : LineStoreProbe.DefaultRoots());
            var report = new LineStoreProbe(roots).Run(version, Now);
            System.IO.Directory.CreateDirectory(_reportDir);
            var path = Path.Combine(_reportDir, $"line-probe-{Sanitize(version)}.json");
            File.WriteAllText(path, report.ToJson());
            LastReportPath = path;
            Detail = report.HumanSummary() + $"; report {path}";
            Activity(CollectorActivity.Config, report.HumanSummary());
        }
        catch (IOException e) { SetError($"probe failed to write report: {e.Message}"); }
        catch (UnauthorizedAccessException e) { SetError($"probe failed to write report: {e.Message}"); }
    }

    private string? ResolveDataFolder()
    {
        if (Settings.DataPath is { } p) return Directory.Exists(p) ? p : null;
        if (_rootsOverride is not null)
            return _rootsOverride.Select(r => r.Path).FirstOrDefault(Directory.Exists);
        return LineStoreProbe.DefaultRoots().Select(r => r.Path).FirstOrDefault(Directory.Exists);
    }

    // ---------------------------------------------------------------- cursors

    private Dictionary<string, long> LoadCursors()
    {
        var node = Context.Settings.LoadJson(Name, "cursors") as JsonObject;
        var map = new Dictionary<string, long>(StringComparer.Ordinal);
        if (node is null) return map;
        foreach (var (k, v) in node)
            if (v is not null && long.TryParse(v.ToString(), out var n)) map[k] = n;
        return map;
    }

    private void SaveCursors()
    {
        var node = new JsonObject();
        foreach (var (k, v) in _cursors) node[k] = JsonValue.Create(v);
        Context.Settings.SaveJson(Name, "cursors", node);
    }

    private void ClearRunProbe()
    {
        ApplySettings(Merge(GetSettingsJson(), new JsonObject { ["runProbe"] = false }));
        Context.Settings.SaveSettings(Name, GetSettingsJson());
    }

    private static JsonObject Merge(JsonObject current, JsonObject patch)
    {
        var result = (JsonObject)current.DeepClone();
        foreach (var (k, v) in patch) result[k] = v?.DeepClone();
        return result;
    }

    private static string Sanitize(string version)
    {
        var chars = version.Select(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_' ? c : '_').ToArray();
        return new string(chars);
    }

    // A plain SQLite file starts with the 16-byte text "SQLite format 3\0". Anything else at a store that
    // could not be opened is treated as an encrypted store for the UI state.
    private static readonly byte[] SqliteMagic = System.Text.Encoding.ASCII.GetBytes("SQLite format 3\0");

    private static bool IsPlainSqlite(string path)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            Span<byte> head = stackalloc byte[16];
            return fs.Read(head) == 16 && head.SequenceEqual(SqliteMagic);
        }
        catch { return false; }
    }
}
