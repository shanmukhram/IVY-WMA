using System.Text.Json.Nodes;
using Ivy.Collectors.Common;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Microsoft.Extensions.Logging;

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
    /// <summary>
    /// LINE is closed (no LINE.exe). Informational, not an error: the last store is still read if the stored
    /// key opens it, otherwise the collector just waits. Capture resumes on its own when LINE opens.
    /// </summary>
    NotRunning,
    /// <summary>
    /// LINE is running but the stored key does not open the store it is using (for example just after a
    /// switch to the other account) and no fitting key was found in LINE yet. Amber, retried every tick.
    /// </summary>
    WaitingForLine,
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

    // Per-chat cursors of the store that is open now (_storeKey). Each LINE account has its own store, saved
    // under "cursors:<storeKey>", so switching accounts never reuses another account's cursors.
    private Dictionary<string, long> _cursors = new(StringComparer.Ordinal);
    // Per-chat chatMeta.listing (hidden | normal) last sent for the open store, saved under "listings:<storeKey>"
    // next to the cursors, so a hide/unhide with no new messages is sent as a metadata-only batch.
    private Dictionary<string, string> _listings = new(StringComparer.Ordinal);
    private string? _storeKey;   // the open store's identity: its own mid, else the qw<hex> file name
    private string? _account;    // the label put on records: Settings.Account if set by the user, else _storeKey
    private volatile bool _resyncRequested;

    private const string DefaultAccount = "default";
    private const string LegacyCursorsKey = "cursors";        // one blob for every account, before accountKeyV1
    private const string LegacyAccountHashKey = "accountHash";
    private const string ResyncEpochKey = "resyncEpoch";
    private static string CursorsKey(string storeKey) => "cursors:" + storeKey;
    private static string ListingsKey(string storeKey) => "listings:" + storeKey;
    private static string AccountHashKey(string storeKey) => "accountHash:" + storeKey;
    private static string EpochKey(string storeKey) => "resyncEpoch:" + storeKey;

    /// <summary>The account label on the records of the store opened last (shown in the LINE row), or null before the first open.</summary>
    public string? CurrentAccount => _account;

    /// <summary>
    /// Ask the collector to re-read all chats, Keep and the account snapshot on its next tick (the one-time
    /// re-sync), so existing messages re-emit with sides and sender names. The Mac merges by platform message id.
    /// It applies to the account open now on the next tick, and to each other LINE account on this PC the next
    /// time its store is the open one.
    /// </summary>
    public void RequestResync() => _resyncRequested = true;
    private string? _verifiedVersion;

    private readonly ILineKeyStore? _keyStore;
    private string? _lastAccountHash;
    private readonly Func<bool> _isLineRunning;
    private readonly Func<Func<byte[], bool>, byte[]?> _findKey;

    // The qw<hex> name of the store last opened successfully, persisted as "lastStore", so that with LINE
    // closed (no -wal anywhere) the collector reads that account's store rather than the largest one.
    private const string LastStoreKey = "lastStore";
    // When a store was last read successfully (ISO 8601), shown while LINE is closed.
    private const string LastCapturedKey = "lastCaptured";
    private string? _lastStore;

    // Stamp of the inputs of the last tick that finished without needing a retry (see IdleStamp). While it
    // matches, a tick skips the snapshot and decrypt and keeps the previous state and Detail. Null forces a read.
    private string? _idleStamp;
    // Bumped whenever the stored key changes through this collector, so a key change is never skipped.
    private int _keyVersion;

    // Snapshot directories older than this are leftovers from a killed process or a locked file; swept on start.
    private static readonly TimeSpan LeftoverAge = TimeSpan.FromMinutes(5);

    /// <summary>How many chat-store snapshots ticks have taken (tests check that idle ticks take none).</summary>
    internal int SnapshotsTaken { get; private set; }

    public LineDesktopCollector(
        CollectorContext context,
        LineSettings? settings = null,
        IReadOnlyList<LineProbeRoot>? roots = null,
        ILineStoreUnlocker? unlocker = null,
        Func<string, LineStoreMap>? mapFor = null,
        string? reportDir = null,
        string? tempRoot = null,
        ILineKeyStore? keyStore = null,
        Func<bool>? isLineRunning = null,
        Func<Func<byte[], bool>, byte[]?>? keyFinder = null)
        : base(CollectorNames.Line, context, settings)
    {
        _rootsOverride = roots;
        _keyStore = keyStore;
        _isLineRunning = isLineRunning ?? LineKeyFinder.IsLineRunning;
        _findKey = keyFinder ?? (fits => OperatingSystem.IsWindows() ? LineKeyFinder.FromRunningLine(fits) : null);
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
    public void SetKey(ReadOnlySpan<byte> passphrase)
    {
        _keyStore?.StoreKey(passphrase);
        Interlocked.Increment(ref _keyVersion);
    }

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
        var dbPath = LineStore.FindDb(dataFolder, _mapFor(Settings.Version ?? "unknown").DbFilePattern, LoadLastStore());
        if (dbPath is null || !File.Exists(dbPath)) return false;
        return TryDetectAndStoreKey(dbPath);
    }

    // Look for a key that opens dbFile (a snapshot copy during a tick) in the running LINE and store it.
    private bool TryDetectAndStoreKey(string dbFile)
    {
        if (_keyStore is null) return false;
        var page1 = ReadFirstPage(dbFile);
        if (page1 is null) return false;

        var found = _findKey(cand =>
        {
            var key = LineWxCipher.DeriveKey(cand);
            try { return LineWxCipher.KeyFits(page1, key); }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(key); }
        });
        if (found is null) return false;
        try { _keyStore.StoreKey(found); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(found); }
        Interlocked.Increment(ref _keyVersion);
        return true;
    }

    // The first page (up to the max page size) is enough to confirm a key.
    private static byte[]? ReadFirstPage(string dbFile)
    {
        try
        {
            using var fs = new FileStream(dbFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var page1 = new byte[(int)Math.Min(fs.Length, 65536)];
            var got = 0;
            int read;
            while (got < page1.Length && (read = fs.Read(page1, got, page1.Length - got)) > 0) got += read;
            return page1;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    // Whether the stored key decrypts dbFile's first page (false with no key store or no key).
    private bool StoredKeyFits(string dbFile)
    {
        if (_keyStore is not { HasKey: true }) return false;
        var page1 = ReadFirstPage(dbFile);
        if (page1 is null) return false;
        var passphrase = _keyStore.LoadKey();
        byte[] key;
        try { key = LineWxCipher.DeriveKey(passphrase); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(passphrase); }
        try { return LineWxCipher.KeyFits(page1, key); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(key); }
    }

    /// <summary>Forget the stored LINE key.</summary>
    public void ClearKey()
    {
        _keyStore?.Clear();
        Interlocked.Increment(ref _keyVersion);
    }

    protected override void Validate(LineSettings s)
    {
        if (s.PollSeconds < 5) throw new ArgumentException("pollSeconds must be >= 5");
        if (s.BatchSize is < 1 or > 100_000) throw new ArgumentException("batchSize must be 1..100000");
    }

    public override Task StartAsync(CancellationToken ct)
    {
        // Cursors and the account-snapshot hash are per account; they load when the first tick opens a store
        // and learns which account it belongs to (SwitchAccount).
        _cursors = new Dictionary<string, long>(StringComparer.Ordinal);
        _listings = new Dictionary<string, string>(StringComparer.Ordinal);
        _storeKey = null;
        _account = null;
        _lastAccountHash = null;
        _lastKeepHash = null;
        _verifiedVersion = null;
        _idleStamp = null;
        _lastStore = null;
        _epochResyncApplied = false;
        // Snapshot directories a killed process or a still-locked file left behind (file times are real time).
        LineSnapshot.SweepLeftovers(_tempRoot, LeftoverAge, DateTimeOffset.UtcNow);
        MigratePollSeconds();
        // Decided from persisted state, not from memory: per-account cursors only load on the first tick
        // (SwitchAccount), so _cursors is always empty here.
        var captured = HasEverCaptured();
        MigrateNamesV2(captured);
        MigrateAccountKeyV1(captured);
        MigrateCallsV1(captured);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Whether this install has ever captured anything, from what is saved (never from memory): the legacy
    /// single <c>cursors</c> blob with any entry, any per-account <c>cursors:&lt;id&gt;</c> with any entry, or a
    /// saved <c>lastCaptured</c> time. Only an install with none of these is fresh; the one-time re-sends run
    /// unconditionally on every other install.
    /// </summary>
    private bool HasEverCaptured()
    {
        if (LoadCursors(LegacyCursorsKey).Count > 0) return true;
        if (Context.Settings.LoadJson(Name, LastCapturedKey) is not null) return true;
        // Per-account cursors are saved under "cursors:<storeKey>"; the store keys are not known before a store
        // is opened, so look for any such setting directly.
        var prefix = CollectorSettingsStore.Key(Name, "cursors:");
        try
        {
            using var c = Context.Db.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "SELECT value FROM agent_settings WHERE substr(key, 1, length($p)) = $p";
            cmd.Parameters.AddWithValue("$p", prefix);
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (r.IsDBNull(0)) continue;
                try
                {
                    if (JsonNode.Parse(r.GetString(0)) is JsonObject o && o.Count > 0) return true;
                }
                catch (System.Text.Json.JsonException) { }
            }
        }
        catch (Microsoft.Data.Sqlite.SqliteException e)
        {
            // Cannot tell: treat it as an existing install. An extra re-send is harmless (the Mac merges by
            // platform message id); a skipped one is not.
            Logger.LogWarning("{Collector}: could not read saved cursors, assuming an existing install: {Reason}", Name, e.Message);
            return true;
        }
        return false;
    }

    /// <summary>
    /// One-time: records uploaded before accounts were told apart carry account "default", so a second LINE
    /// account used on this PC would merge into the first on the Mac (WX1 merges by platform + account +
    /// conversation + message id). Request one re-sync so every chat is re-sent under the account's own id.
    /// Same pattern as <see cref="MigrateNamesV2"/>: a fresh install (<see cref="HasEverCaptured"/>) records the flag at once;
    /// otherwise the flag is saved only after a tick has applied the re-sync and emitted every chat. The Mac then holds those chats
    /// twice (under "default" and under the account id) until it removes its "default" LINE records.
    /// </summary>
    private void MigrateAccountKeyV1(bool captured)
    {
        if (Context.Settings.LoadJson(Name, "accountKeyV1") is not null) return;
        if (!captured)
        {
            Context.Settings.SaveJson(Name, "accountKeyV1", JsonValue.Create(true));
            return;
        }
        _accountKeyMigrationPending = true;
        RequestResync();
        Activity(CollectorActivity.Config, "re-sending LINE chats once under the LINE account's own id instead of \"default\", so two LINE accounts on this PC stay apart");
    }

    private bool _accountKeyMigrationPending;

    /// <summary>
    /// One-time: LINE 26.x keeps contact names in a JSON column rather than <c>_displayName</c>, so messages
    /// uploaded before that was handled went out with raw mids as sender names and chat titles. Request one
    /// re-sync so every chat re-emits with names; the Mac merges by platform message id (WX1), so this updates
    /// the existing rows rather than duplicating them. A fresh install (<see cref="HasEverCaptured"/>) has nothing to redo,
    /// so it records the flag at once. Otherwise the flag is saved only when a tick has actually applied the
    /// re-sync (cursors cleared and every chat emitted), so quitting before that asks again on the next start.
    /// </summary>
    private void MigrateNamesV2(bool captured)
    {
        if (Context.Settings.LoadJson(Name, "namesV2") is not null) return;
        if (!captured)
        {
            Context.Settings.SaveJson(Name, "namesV2", JsonValue.Create(true));
            return;
        }
        _namesMigrationPending = true;
        RequestResync();
        Activity(CollectorActivity.Config, "re-sending LINE chats once so existing messages gain contact names and chat titles (names now read from LINE 26.x profile data)");
    }

    private bool _namesMigrationPending;

    /// <summary>
    /// One-time: LINE call records (content type 6) went out before the message <c>call</c> field existed, so
    /// the Mac shows LINE's raw system text for them. Request one re-sync so they re-emit with <c>call</c>
    /// (kind, outcome, duration, direction); the Mac merges by platform message id and fills the call columns
    /// on the existing rows. Same pattern as <see cref="MigrateNamesV2"/>: a fresh install records the flag at
    /// once; otherwise the flag is saved only after a tick has applied the re-sync and emitted every chat.
    /// </summary>
    private void MigrateCallsV1(bool captured)
    {
        if (Context.Settings.LoadJson(Name, "callsV1") is not null) return;
        if (!captured)
        {
            Context.Settings.SaveJson(Name, "callsV1", JsonValue.Create(true));
            return;
        }
        _callsMigrationPending = true;
        RequestResync();
        Activity(CollectorActivity.Config, "re-sending LINE chats once so existing call records show as audio/video calls with outcome and duration");
    }

    private bool _callsMigrationPending;

    // A one-time re-send that has not been applied yet always forces a full read (never an idle skip).
    private bool MigrationPending => _namesMigrationPending || _accountKeyMigrationPending || _callsMigrationPending;

    public override Task TickAsync(CancellationToken ct)
    {
        var version = Settings.Version ?? "unknown";

        var probed = false;
        if (Settings.RunProbe)
        {
            RunProbe(version);
            ClearRunProbe();
            probed = true;
        }

        var dataFolder = ResolveDataFolder();
        if (dataFolder is null)
        {
            _idleStamp = null;
            State = LineState.NotInstalled;
            Detail = "LINE for Windows not found" + (LastReportPath is null ? "" : $"; report {LastReportPath}");
            return Task.CompletedTask;
        }

        var map = _mapFor(version);
        if (_verifiedVersion is not null && _verifiedVersion != version)
            Detail = $"LINE version changed {_verifiedVersion} -> {version}; re-verifying";

        // Only lists process names; no memory is read while LINE is closed.
        var running = _isLineRunning();
        var dbPath = LineStore.FindDb(dataFolder, map.DbFilePattern, LoadLastStore());
        if (dbPath is null)
        {
            _idleStamp = null;
            State = LineState.StoreNotFound;
            _verifiedVersion = null;
            SetError($"no file matching '{map.DbFilePattern}' in {dataFolder}" +
                     (LastReportPath is null ? " (run the probe to see the real layout)" : $"; see report {LastReportPath}"));
            return Task.CompletedTask;
        }

        // Cheap idle tick: nothing LINE writes has changed since the last tick that finished (a new message
        // always changes the -wal), so skip the snapshot and decrypt and keep the previous state and Detail.
        var stamp = IdleStamp(dataFolder, dbPath, version, running);
        if (!probed && !_resyncRequested && !MigrationPending && stamp == _idleStamp) return Task.CompletedTask;
        _idleStamp = null;   // set again below only when this tick finishes without needing a retry

        SnapshotsTaken++;
        using var snapshot = LineSnapshot.TryCreate(dbPath, _tempRoot, out var snapReason);
        if (snapshot is null)
        {
            if (!File.Exists(dbPath))
            {
                // The store vanished between finding and copying it: report it like a missing store.
                State = LineState.StoreNotFound;
                _verifiedVersion = null;
                SetError(snapReason ?? "could not snapshot the LINE store");
                return Task.CompletedTask;
            }
            // A locked or changing file is transient: keep the previous state, set no error, retry next tick.
            // TryCreate already removed its temp directory.
            Logger.LogInformation("{Collector}: no snapshot this tick, retrying next tick: {Reason}", Name, snapReason);
            return Task.CompletedTask;
        }

        LineStore? store;
        string? openReason;
        try
        {
            store = LineStore.Open(snapshot.Directory, map, _unlocker, out openReason);
            // Encrypted store the stored key does not open. With LINE closed there is no key to find: report
            // NotRunning and wait (never red). With LINE running, look for a fitting key in LINE once this tick
            // and retry; if none fits yet (LINE still signing in, or just switched account) wait in amber.
            if (store is null && _keyStore is not null && !IsPlainSqlite(snapshot.DbCopy) && !StoredKeyFits(snapshot.DbCopy))
            {
                if (!running)
                {
                    ReportNotRunning(null);
                    _idleStamp = stamp;   // nothing to retry until a file, the key or LINE's state changes
                    return Task.CompletedTask;
                }
                if (!TryDetectAndStoreKey(snapshot.DbCopy))
                {
                    State = LineState.WaitingForLine;
                    Detail = $"Waiting for LINE to finish signing in: the stored key does not open {Path.GetFileNameWithoutExtension(dbPath)} yet; retrying every {Settings.PollSeconds} s";
                    return Task.CompletedTask;
                }
                store = LineStore.Open(snapshot.Directory, map, _unlocker, out openReason);
            }
        }
        catch (Exception e) when (IsTransient(e))
        {
            // A failed decrypt or a read error on the copy: keep the previous state, retry next tick. The
            // snapshot (with any plaintext copy inside it) is deleted when it is disposed below.
            Logger.LogInformation("{Collector}: could not read the snapshot this tick, retrying next tick: {Reason}", Name, e.Message);
            return Task.CompletedTask;
        }
        using var storeGuard = store;
        if (store is null)
        {
            _verifiedVersion = null;
            var reason = openReason ?? "the LINE store could not be read";
            // Tell the cases apart for the UI state from the file itself, not the reason text: a plain SQLite
            // header, or an encrypted store the stored key does open, means the map did not verify (WL3);
            // otherwise it is an encrypted store with no way to open it (no key store wired).
            var plain = IsPlainSqlite(snapshot.DbCopy);
            State = plain || StoredKeyFits(snapshot.DbCopy) ? LineState.UnverifiedMap : LineState.EncryptedStore;
            SetError(reason);
            return Task.CompletedTask;
        }

        _verifiedVersion = version;
        // Which LINE account this store belongs to; load that account's own cursors and snapshot hash.
        SwitchAccount(store, dbPath);
        RememberStore(dbPath);
        var account = _account!;
        var sink = Sink;
        if (sink is null) return Task.CompletedTask; // not paired yet; verified, nothing to emit

        // A re-sync applied by SwitchAccount (requested while another account was open) counts too.
        var resyncing = _epochResyncApplied;
        _epochResyncApplied = false;
        if (_resyncRequested)
        {
            _resyncRequested = false;
            resyncing = true;
            _cursors.Clear();   // re-read every chat from the start
            SaveCursors();
            _listings.Clear();
            SaveListings();
            // Other accounts' stores are not open now; bumping the epoch makes each of them re-read from the
            // start too the next time it is opened (SwitchAccount compares its saved epoch).
            var epoch = LoadLong(ResyncEpochKey) + 1;
            Context.Settings.SaveJson(Name, ResyncEpochKey, JsonValue.Create(epoch));
            Context.Settings.SaveJson(Name, EpochKey(_storeKey!), JsonValue.Create(epoch));
            _lastKeepHash = null;    // re-emit Keep and the account snapshot too
            _lastAccountHash = null;
            Context.Settings.SaveJson(Name, AccountHashKey(_storeKey!), JsonValue.Create(""));
            Activity(CollectorActivity.ScanStarted, $"re-sync: re-reading all LINE chats, Keep and the account snapshot (account {account})");
        }

        // No content check here: every page read is emitted, so after a re-sync has cleared the cursors every
        // chat is sent again in full even if nothing changed since the last send.
        var chats = store.Chats();
        var hiddenIds = store.HiddenChatIds();   // null: the store does not say, so listing is left unknown
        var newMessages = 0;
        var batchesEmitted = 0;
        var chatsEmitted = 0;
        foreach (var chat in chats)
        {
            if (ct.IsCancellationRequested) break;
            var cursor = _cursors.GetValueOrDefault(chat.ChatId, 0L);
            var listing = hiddenIds is null ? null : hiddenIds.Contains(chat.ChatId) ? ChatListing.Hidden : ChatListing.Normal;
            var chatBatches = 0;
            while (true)
            {
                var page = store.ReadMessages(chat, cursor, Settings.BatchSize);
                if (page.Messages.Count > 0)
                {
                    EmitBatch(sink, account, chat, page.Messages, page.MaxRowId, listing);
                    newMessages += page.Messages.Count;
                    chatBatches++;
                }
                if (page.MaxRowId > cursor)
                {
                    cursor = page.MaxRowId;
                    _cursors[chat.ChatId] = cursor;
                    SaveCursors();
                }
                if (!page.HasMore) break;
            }
            // Hidden or unhidden since the last send, with no new messages: send the chat's metadata alone. A chat
            // never sent (cursor 0) gets its listing on its first batch instead. A chat sent before listings were
            // tracked (no saved listing) is sent only when hidden: the Mac already shows an unknown listing as normal.
            var sent = _listings.GetValueOrDefault(chat.ChatId);
            if (listing is not null && chatBatches == 0 && cursor > 0 && sent != listing && (sent is not null || listing != ChatListing.Normal))
            {
                EmitBatch(sink, account, chat, Array.Empty<ChatMessage>(), cursor, listing);
                chatBatches++;
            }
            if (listing is not null && (chatBatches > 0 || cursor > 0) && sent != listing)
            {
                _listings[chat.ChatId] = listing;
                SaveListings();
            }
            batchesEmitted += chatBatches;
            if (chatBatches > 0) chatsEmitted++;
        }

        EmitAccount(sink, store, account);
        EmitKeep(sink, account, dbPath);

        if (resyncing)
        {
            if (ct.IsCancellationRequested)
            {
                // Stopped part-way: chats not reached still have cleared cursors on disk and are read from the
                // start next time; the one-time flags stay unset, so the re-send is requested again on start.
                Activity(CollectorActivity.ScanCompleted, $"re-sync interrupted: {chatsEmitted} chats, {batchesEmitted} batches sent before stopping (account {account})");
            }
            else
            {
                // The re-sync is applied (cursors cleared) and every chat was emitted: record the one-time flags
                // that asked for it, so they are never requested again.
                if (_namesMigrationPending) { Context.Settings.SaveJson(Name, "namesV2", JsonValue.Create(true)); _namesMigrationPending = false; }
                if (_accountKeyMigrationPending) { Context.Settings.SaveJson(Name, "accountKeyV1", JsonValue.Create(true)); _accountKeyMigrationPending = false; }
                if (_callsMigrationPending) { Context.Settings.SaveJson(Name, "callsV1", JsonValue.Create(true)); _callsMigrationPending = false; }
                // The proof that the re-send happened, with what it actually emitted.
                Activity(CollectorActivity.ScanCompleted, $"re-sync done: {chatsEmitted} chats, {batchesEmitted} batches (account {account})");
            }
        }

        Cursor = $"chats={chats.Count}";
        var capturedAt = Now;
        Context.Settings.SaveJson(Name, LastCapturedKey, JsonValue.Create(IvyTime.Format(capturedAt)));
        if (!ct.IsCancellationRequested) _idleStamp = stamp;
        if (!running)
        {
            // LINE is closed but the stored key opened the last store (a checkpoint on quit is captured in full).
            ReportNotRunning(capturedAt);
            return Task.CompletedTask;
        }
        State = LineState.OkPartial;
        // We read every chat and message this PC's LINE holds; "partial" only means the phone may hold older
        // history we cannot see from Windows, so it is confirmed complete only once the phone's import runs.
        Detail = $"Capturing all {chats.Count} chats on this PC for LINE account {account} ({newMessages} new this tick). Full history confirmed from the phone.";
        return Task.CompletedTask;
    }

    /// <summary>
    /// LINE is closed: an informational state, never an error. Cursors and the account label are kept.
    /// <paramref name="capturedAt"/> is this tick's read, or null to show the last saved one.
    /// </summary>
    private void ReportNotRunning(DateTimeOffset? capturedAt)
    {
        State = LineState.NotRunning;
        var last = capturedAt ?? LoadLastCaptured();
        var when = last is null ? "nothing captured yet" : "last captured " + last.Value.ToLocalTime().ToString("yyyy-MM-dd HH:mm", System.Globalization.CultureInfo.InvariantCulture);
        var who = _account is null ? "" : $" (account {_account})";
        Detail = $"LINE is not running; {when}{who}; resumes when LINE opens";
    }

    private DateTimeOffset? LoadLastCaptured() =>
        Context.Settings.LoadJson(Name, LastCapturedKey) is JsonValue v && v.TryGetValue<string>(out var s)
        && DateTimeOffset.TryParse(s, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var t)
            ? t : null;

    private string? LoadLastStore()
    {
        if (_lastStore is not null) return _lastStore;
        _lastStore = Context.Settings.LoadJson(Name, LastStoreKey) is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s : null;
        return _lastStore;
    }

    // Persist the qw<hex> name of the store just opened, when it changed.
    private void RememberStore(string dbPath)
    {
        var name = Path.GetFileNameWithoutExtension(dbPath);
        if (string.Equals(LoadLastStore(), name, StringComparison.Ordinal)) return;
        _lastStore = name;
        Context.Settings.SaveJson(Name, LastStoreKey, JsonValue.Create(name));
    }

    /// <summary>
    /// Everything a tick's outcome depends on, as one string: the chosen store and its Keep store with the
    /// sizes and mtimes of their main, <c>-wal</c> and <c>-shm</c> files (<see cref="LineSnapshot.StampOf"/>),
    /// plus the LINE version, whether LINE is running, the account setting, pairing and the key version.
    /// </summary>
    private string IdleStamp(string dataFolder, string dbPath, string version, bool running)
    {
        var keep = LineKeep.FindKeepDb(dataFolder, dbPath);
        return string.Join("|",
            dbPath, LineSnapshot.StampOf(dbPath),
            keep ?? "-", keep is null ? "-" : LineSnapshot.StampOf(keep),
            version, running ? "running" : "closed", Settings.Account,
            Sink is null ? "unpaired" : "paired",
            Volatile.Read(ref _keyVersion).ToString(System.Globalization.CultureInfo.InvariantCulture),
            _keyStore?.HasKey == true ? "key" : "nokey");
    }

    private static bool IsTransient(Exception e) =>
        e is IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException
            or System.Security.Cryptography.CryptographicException;

    /// <summary>
    /// Work out which account the opened store belongs to and, when it differs from the last one, load that
    /// account's own state. The store key is the store's own mid, else its file name (<c>qw&lt;hex&gt;</c>), so
    /// two stores never share cursors. The record label is the user's explicit <c>account</c> setting if it is
    /// not "default", else the store key.
    /// </summary>
    private void SwitchAccount(LineStore store, string liveDbPath)
    {
        var mid = store.AccountId;
        var storeKey = !string.IsNullOrWhiteSpace(mid) ? mid! : Path.GetFileNameWithoutExtension(liveDbPath);
        var configured = Settings.Account;
        _account = !string.IsNullOrWhiteSpace(configured) && configured != DefaultAccount ? configured : storeKey;
        if (storeKey == _storeKey) return;

        var previous = _storeKey;
        _storeKey = storeKey;
        _cursors = LoadCursors(CursorsKey(storeKey));
        _listings = LoadListings(ListingsKey(storeKey));

        // One-time: cursors saved before accounts were told apart are a single blob. They were written by the
        // account open at the time, so they move to the account open now (once), and the blob is removed.
        if (Context.Settings.LoadJson(Name, LegacyCursorsKey) is not null)
        {
            if (_cursors.Count == 0)
            {
                _cursors = LoadCursors(LegacyCursorsKey);
                SaveCursors();
            }
            Context.Settings.SaveJson(Name, LegacyCursorsKey, null);
            Context.Settings.SaveJson(Name, LegacyAccountHashKey, null);
        }

        // A re-sync applied while another account was open still applies to this one: re-read it from the start.
        var epoch = LoadLong(ResyncEpochKey);
        if (LoadLong(EpochKey(storeKey)) < epoch)
        {
            _epochResyncApplied = true;   // the tick reports it like any re-sync
            _cursors.Clear();
            SaveCursors();
            _listings.Clear();
            SaveListings();
            Context.Settings.SaveJson(Name, AccountHashKey(storeKey), JsonValue.Create(""));
            Context.Settings.SaveJson(Name, EpochKey(storeKey), JsonValue.Create(epoch));
        }

        // The last uploaded account snapshot's content hash survives restarts, so an unchanged snapshot is not re-sent.
        var savedHash = Context.Settings.LoadJson(Name, AccountHashKey(storeKey)) as JsonValue;
        _lastAccountHash = savedHash is not null && savedHash.TryGetValue<string>(out var h) && !string.IsNullOrEmpty(h) ? h : null;
        _lastKeepHash = null;   // the Keep store is per account too

        if (previous is not null)
            Activity(CollectorActivity.Config, $"LINE account changed ({previous} -> {storeKey}); using that account's own cursors");
    }

    private bool _epochResyncApplied;

    private long LoadLong(string key) =>
        Context.Settings.LoadJson(Name, key) is JsonValue v && v.TryGetValue<long>(out var n) ? n : 0L;

    private string? _lastKeepHash;

    // Read LINE Keep (the user's own saved notes/media) from keep_*.edb and emit it as a "LINE Keep" conversation.
    // The Keep store read is the one named after the open chat store (keep_qw<hex>.edb), i.e. the same account.
    private void EmitKeep(IRecordSink sink, string account, string chatDbPath)
    {
        if (_keyStore is not { HasKey: true }) return;
        var dataFolder = ResolveDataFolder();
        if (dataFolder is null) return;
        var keepDb = LineKeep.FindKeepDb(dataFolder, chatDbPath);
        if (keepDb is null) return;

        string plainPath;
        try
        {
            using var snap = LineSnapshot.TryCreate(keepDb, _tempRoot, out _);
            // Read the snapshot copy (and its -wal copy below), never the live file.
            var src = snap?.DbCopy ?? keepDb;
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
                Account = account,
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

    private void EmitAccount(IRecordSink sink, LineStore store, string account)
    {
        LineAccount acct;
        try { acct = store.ReadAccount(); }
        catch { return; } // the account snapshot is best-effort; never block message capture

        var record = new LineAccountRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = IvyTime.Format(Now),
            CaptureTime = IvyTime.Format(Now),
            Account = account,
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
        Context.Settings.SaveJson(Name, AccountHashKey(_storeKey!), JsonValue.Create(hash));
    }

    private static string ContentHash(IvyRecord record) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(Ivy.Core.Protocol.IvyJson.Serialize(record))));

    /// <summary>
    /// Emit one batch for <paramref name="chat"/>. An empty <paramref name="messages"/> is a metadata-only batch
    /// (the chat's listing changed with no new messages), dated now.
    /// </summary>
    private void EmitBatch(IRecordSink sink, string account, LineChat chat, IReadOnlyList<ChatMessage> messages, long maxRowId, string? listing)
    {
        var batch = new MessageBatchRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = messages.Count > 0 ? messages[^1].SentAt : IvyTime.Format(Now),
            CaptureTime = IvyTime.Format(Now),
            Platform = MessagePlatforms.Line,
            Account = account,
            ConvKey = chat.ChatId,
            Peer = chat.ConvKind == "dm" ? chat.Title ?? chat.ChatId : null,
            ConvKind = chat.ConvKind,
            SourceSession = SourceSessions.WindowsLineDesktop,
            Coverage = MessageCoverage.Partial, // WL2: never above partial from Windows, whatever the store holds
            ChatMeta = new ChatMeta { Title = chat.Title, ChatType = chat.ChatType, Listing = listing },
            Messages = messages,
            Cursor = maxRowId.ToString(System.Globalization.CultureInfo.InvariantCulture),
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

    private Dictionary<string, long> LoadCursors(string key)
    {
        var node = Context.Settings.LoadJson(Name, key) as JsonObject;
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
        Context.Settings.SaveJson(Name, CursorsKey(_storeKey!), node);
    }

    private Dictionary<string, string> LoadListings(string key)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        if (Context.Settings.LoadJson(Name, key) is not JsonObject node) return map;
        foreach (var (k, v) in node)
            if (v is JsonValue jv && jv.TryGetValue<string>(out var s) && ChatListing.IsValid(s)) map[k] = s;
        return map;
    }

    private void SaveListings()
    {
        var node = new JsonObject();
        foreach (var (k, v) in _listings) node[k] = JsonValue.Create(v);
        Context.Settings.SaveJson(Name, ListingsKey(_storeKey!), node);
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
