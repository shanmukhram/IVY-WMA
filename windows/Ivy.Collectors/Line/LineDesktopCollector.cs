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
    private volatile bool _resyncRequested;

    /// <summary>
    /// Ask the collector to re-read all chats, Keep and the account snapshot on its next tick (the one-time
    /// re-sync), so existing messages re-emit with sides and sender names. The Mac merges by platform message id.
    /// </summary>
    public void RequestResync() => _resyncRequested = true;
    private string? _verifiedVersion;

    private readonly ILineKeyStore? _keyStore;
    private string? _lastAccountHash;

    public LineDesktopCollector(
        CollectorContext context,
        LineSettings? settings = null,
        IReadOnlyList<LineProbeRoot>? roots = null,
        ILineStoreUnlocker? unlocker = null,
        Func<string, LineStoreMap>? mapFor = null,
        string? reportDir = null,
        string? tempRoot = null,
        ILineKeyStore? keyStore = null)
        : base(CollectorNames.Line, context, settings)
    {
        _rootsOverride = roots;
        _keyStore = keyStore;
        // With a key store, decrypt via the real wxSQLite3 scheme once a key is set; otherwise stay honest.
        _unlocker = unlocker ?? (keyStore is not null ? new KeyedLineUnlocker(keyStore) : NotImplementedUnlocker.Instance);
        _mapFor = mapFor ?? (_ => LineStoreMap.ShippedDefault);
        _reportDir = reportDir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "IVY");
        _tempRoot = tempRoot ?? Path.Combine(Path.GetTempPath(), "ivy-line");
    }

    public override TimeSpan Interval => TimeSpan.FromSeconds(Settings.PollSeconds);

    /// <summary>Last tick's state (for the UI/tests).</summary>
    public LineState State { get; private set; } = LineState.ProbeNeeded;

    /// <summary>Path of the last probe report written, surfaced in the UI with a button to open it.</summary>
    public string? LastReportPath { get; private set; }

    /// <summary>Whether a LINE key is set (UI: show "key set" vs the entry field). Only when a key store is wired.</summary>
    public bool HasKey => _keyStore?.HasKey ?? false;

    /// <summary>Store the LINE key (entered once in the app, kept in DPAPI, never uploaded — WX2).</summary>
    public void SetKey(ReadOnlySpan<byte> passphrase) => _keyStore?.StoreKey(passphrase);

    /// <summary>
    /// Try to read a working key from the running LINE process and store it. Scans LINE's memory for 32-hex
    /// candidates and keeps the one that actually decrypts this store's first page (so a wrong candidate is
    /// discarded, not stored). Windows only; returns false off Windows, with no key store, or if none fit.
    /// </summary>
    public bool TryDetectAndStoreKey()
    {
        if (_keyStore is null || !OperatingSystem.IsWindows()) return false;
        var dataFolder = ResolveDataFolder();
        if (dataFolder is null) return false;
        var dbPath = LineStore.FindDb(dataFolder, _mapFor(Settings.Version ?? "unknown").DbFilePattern);
        if (dbPath is null || !File.Exists(dbPath)) return false;

        // The first page (up to the max page size) is enough to confirm a key.
        byte[] page1;
        using (var fs = new FileStream(dbPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            page1 = new byte[(int)Math.Min(fs.Length, 65536)];
            _ = fs.Read(page1, 0, page1.Length);
        }

        var found = LineKeyFinder.FromRunningLine(cand =>
        {
            var key = LineWxCipher.DeriveKey(cand);
            try { return LineWxCipher.KeyFits(page1, key); }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(key); }
        });
        if (found is null) return false;
        try { _keyStore.StoreKey(found); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(found); }
        return true;
    }

    /// <summary>Forget the stored LINE key.</summary>
    public void ClearKey() => _keyStore?.Clear();

    protected override void Validate(LineSettings s)
    {
        if (s.PollSeconds < 5) throw new ArgumentException("pollSeconds must be >= 5");
        if (s.BatchSize is < 1 or > 100_000) throw new ArgumentException("batchSize must be 1..100000");
    }

    public override Task StartAsync(CancellationToken ct)
    {
        _cursors = LoadCursors();
        _verifiedVersion = null;
        // The last uploaded account snapshot's content hash survives restarts, so an unchanged snapshot is not re-sent.
        var savedHash = Context.Settings.LoadJson(Name, "accountHash") as JsonValue;
        _lastAccountHash = savedHash is not null && savedHash.TryGetValue<string>(out var h) && !string.IsNullOrEmpty(h) ? h : null;
        MigratePollSeconds();
        MigrateNamesV2();
        return Task.CompletedTask;
    }

    /// <summary>
    /// One-time: LINE 26.x keeps contact names in a JSON column rather than <c>_displayName</c>, so messages
    /// uploaded before that was handled went out with raw mids as sender names and chat titles. Request one
    /// re-sync so every chat re-emits with names; the Mac merges by platform message id (WX1), so this updates
    /// the existing rows rather than duplicating them. A fresh install (no saved cursors) has nothing to redo,
    /// so it records the flag at once. Otherwise the flag is saved only when a tick has actually applied the
    /// re-sync (cursors cleared and saved), so quitting before that tick asks again on the next start.
    /// </summary>
    private void MigrateNamesV2()
    {
        if (Context.Settings.LoadJson(Name, "namesV2") is not null) return;
        if (_cursors.Count == 0)
        {
            Context.Settings.SaveJson(Name, "namesV2", JsonValue.Create(true));
            return;
        }
        _namesMigrationPending = true;
        RequestResync();
        Activity(CollectorActivity.Config, "re-sending LINE chats once so existing messages gain contact names and chat titles (names now read from LINE 26.x profile data)");
    }

    private bool _namesMigrationPending;

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

        var store = LineStore.Open(snapshot.Directory, map, _unlocker, out var openReason);
        // Encrypted store without a working key: automatically read a key from the running LINE process and
        // retry, so capture starts on its own with no button press. Only runs while no key fits, so once a
        // working key is stored it is reused and no scanning happens.
        if (store is null && _keyStore is not null && !IsPlainSqlite(dbPath) && OperatingSystem.IsWindows() && TryDetectAndStoreKey())
            store = LineStore.Open(snapshot.Directory, map, _unlocker, out openReason);
        using var storeGuard = store;
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

        if (_resyncRequested)
        {
            _resyncRequested = false;
            _cursors.Clear();   // re-read every chat from the start
            SaveCursors();
            if (_namesMigrationPending)
            {
                // The names re-sync is now applied (cursors are cleared on disk), so it is never requested again.
                Context.Settings.SaveJson(Name, "namesV2", JsonValue.Create(true));
                _namesMigrationPending = false;
            }
            _lastKeepHash = null;    // re-emit Keep and the account snapshot too
            _lastAccountHash = null;
            Context.Settings.SaveJson(Name, "accountHash", JsonValue.Create(""));
            Activity(CollectorActivity.ScanStarted, "re-sync: re-reading all LINE chats, Keep and the account snapshot");
        }

        var chats = store.Chats();
        var newMessages = 0;
        foreach (var chat in chats)
        {
            if (ct.IsCancellationRequested) break;
            var cursor = _cursors.GetValueOrDefault(chat.ChatId, 0L);
            while (true)
            {
                var page = store.ReadMessages(chat, cursor, Settings.BatchSize);
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

        EmitAccount(sink, store);
        EmitKeep(sink);

        State = LineState.OkPartial;
        Cursor = $"chats={chats.Count}";
        // We read every chat and message this PC's LINE holds; "partial" only means the phone may hold older
        // history we cannot see from Windows, so it is confirmed complete only once the phone's import runs.
        Detail = $"Capturing all {chats.Count} chats on this PC ({newMessages} new this tick). Full history confirmed from the phone.";
        return Task.CompletedTask;
    }

    private string? _lastKeepHash;

    // Read LINE Keep (the user's own saved notes/media) from keep_*.edb and emit it as a "LINE Keep" conversation.
    private void EmitKeep(IRecordSink sink)
    {
        if (_keyStore is not { HasKey: true }) return;
        var dataFolder = ResolveDataFolder();
        if (dataFolder is null) return;
        var keepDb = LineKeep.FindKeepDb(dataFolder);
        if (keepDb is null) return;

        string plainPath;
        try
        {
            using var snap = LineSnapshot.TryCreate(keepDb, _tempRoot, out _);
            var src = snap is null ? keepDb : LineStore.FindDb(snap.Directory, "keep_*.edb") ?? keepDb;
            var passphrase = _keyStore.LoadKey();
            byte[] baseKey;
            try { baseKey = LineWxCipher.DeriveKey(passphrase); }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(passphrase); }
            byte[]? plain;
            try
            {
                plain = LineWxCipher.Decrypt(File.ReadAllBytes(src), baseKey);
                // Fold in Keep items LINE has not checkpointed yet, from the snapshot's copy of the WAL.
                // Without a snapshot copy (src is then the live file) skip it: the live -wal is never read in place.
                if (plain is not null && snap is not null && src != keepDb)
                {
                    var wal = LineWal.TryReadFile(src + "-wal");
                    if (wal is not null) plain = LineWal.Overlay(plain, wal, baseKey);
                }
            }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(baseKey); }
            if (plain is null) return;
            LineWal.MakeSelfContained(plain);
            plainPath = Path.Combine(_tempRoot, "keep-" + Guid.NewGuid().ToString("N")[..10] + ".db");
            Directory.CreateDirectory(_tempRoot);
            File.WriteAllBytes(plainPath, plain);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(plain);
        }
        catch { return; }

        try
        {
            var items = LineKeep.Read(plainPath);
            if (items.Count == 0) return;
            var messages = items.Select(it => new ChatMessage
            {
                MsgId = it.ContentId,
                Sender = "keep",
                FromMe = true,
                SenderName = "You",
                SentAt = IvyTime.Format(it.CreatedAt ?? DateTimeOffset.UnixEpoch),
                Text = string.IsNullOrEmpty(it.Name) ? "(Keep item)" : it.Name!,
                SourceStatus = MessageSourceStatus.Live,
                MediaKind = it.MainType,
            }).ToList();

            var record = new MessageBatchRecord
            {
                DeviceId = DeviceId(sink),
                EventTime = messages[messages.Count - 1].SentAt,
                CaptureTime = IvyTime.Format(Now),
                Platform = MessagePlatforms.Line,
                Account = Settings.Account,
                ConvKey = "keep",
                Peer = "LINE Keep",
                ConvKind = "group",
                SourceSession = SourceSessions.WindowsLineDesktop,
                Coverage = MessageCoverage.Partial,
                ChatMeta = new ChatMeta { Title = "LINE Keep", ChatType = "keep" },
                Messages = messages,
                Cursor = $"keep={items.Count}",
            };
            // Hash the content only: CaptureTime changes every tick and would defeat the change check.
            var hash = ContentHash(record with { CaptureTime = "" });
            if (hash == _lastKeepHash) return;
            Emit(sink, record);
            _lastKeepHash = hash;
        }
        finally { try { File.Delete(plainPath); } catch { } }
    }

    private void EmitAccount(IRecordSink sink, LineStore store)
    {
        LineAccount acct;
        try { acct = store.ReadAccount(); }
        catch { return; } // the account snapshot is best-effort; never block message capture

        var record = new LineAccountRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = IvyTime.Format(Now),
            CaptureTime = IvyTime.Format(Now),
            Account = Settings.Account,
            OwnProfile = acct.Profile is null ? null : new LineOwnProfileRecord
            {
                Mid = acct.Profile.Mid, DisplayName = acct.Profile.DisplayName, UserId = acct.Profile.UserId,
                StatusMessage = acct.Profile.StatusMessage, PicturePath = acct.Profile.PicturePath,
            },
            Contacts = acct.Contacts.Select(c => new LineContactRecord
            {
                Mid = c.Mid, DisplayName = c.DisplayName, Status = c.Status, Type = c.Type, Settings = c.Settings,
                StatusMessage = c.StatusMessage, PicturePath = c.PicturePath, ThumbnailUrl = c.ThumbnailUrl,
                // blocked is set only when the store states it as a plain boolean (26.x _blockDetail.notBlocked
                // = true/false). Otherwise it stays null: the meaning of _status/_settings is not confirmed, so
                // the settings page never shows a guessed blocked list (it shows the raw status meanwhile).
                Blocked = c.Blocked,
            }).ToList(),
            ChatOptions = acct.Options.Select(o => new LineChatOptionRecord
            {
                ChatId = o.Id, Hidden = o.Hidden, Notification = o.Notification, Pinned = o.Pinned,
            }).ToList(),
            Settings = acct.Settings.Select(s => new LineSettingKv { Key = s.Key, Value = s.Value }).ToList(),
        };

        // Only upload when the snapshot changed, so it does not re-send every tick.
        // The hash covers the content only (timestamps blanked), since EventTime/CaptureTime change every tick.
        var hash = ContentHash(record with { EventTime = "", CaptureTime = "" });
        if (hash == _lastAccountHash) return;
        Emit(sink, record);
        _lastAccountHash = hash;
        Context.Settings.SaveJson(Name, "accountHash", JsonValue.Create(hash));
    }

    private static string ContentHash(IvyRecord record) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(Ivy.Core.Protocol.IvyJson.Serialize(record))));

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
            // With a key set, let the probe list the decrypted store's table/column names (no row data) so the
            // settings/blocked/hidden layout can be mapped.
            Func<string, byte[]?>? decryptor = _keyStore is { HasKey: true }
                ? path =>
                {
                    var passphrase = _keyStore.LoadKey();
                    byte[] baseKey;
                    try { baseKey = LineWxCipher.DeriveKey(passphrase); }
                    finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(passphrase); }
                    // Main file only, on purpose: the probe lists table/column names, which do not need the WAL.
                    try { return LineWxCipher.Decrypt(File.ReadAllBytes(path), baseKey); }
                    finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(baseKey); }
                }
            : null;
            var report = new LineStoreProbe(roots).Run(version, Now, decryptor);
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

    /// <summary>
    /// One-time: installs that saved the old 300 s default keep it forever (saved settings are merged over the
    /// code defaults), so move exactly that value to 5 s. Any other user-chosen value is left alone.
    /// </summary>
    private void MigratePollSeconds()
    {
        if (Context.Settings.LoadJson(Name, "pollMigratedV1") is not null) return;
        if (Settings.PollSeconds == 300)
        {
            ApplySettings(Merge(GetSettingsJson(), new JsonObject { ["pollSeconds"] = 5 }));
            Context.Settings.SaveSettings(Name, GetSettingsJson());
            Activity(CollectorActivity.Config, "poll interval moved from 300 s to 5 s so new messages show up at once");
        }
        Context.Settings.SaveJson(Name, "pollMigratedV1", JsonValue.Create(true));
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
