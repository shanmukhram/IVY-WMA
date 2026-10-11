using System.Text.Json;
using Ivy.Collectors.Common;
using Ivy.Collectors.Line;
using Ivy.Collectors.Tests.Support;
using Ivy.Core.Protocol;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Tests;

/// <summary>
/// A plain-SQLite LINE store fixture matching <see cref="LineStoreMap.ShippedDefault"/> (tables _message,
/// _chat, _contact, _groupChat). The file is named with the shipped db pattern (*.edb). Created plainly so
/// its header is the SQLite magic — the collector reads it directly, exactly as it would an older plain
/// LINE build; the shipped map's declared encryption only matters when the header is not SQLite.
/// </summary>
internal static class LineFixture
{
    public static string Create(string dir, string name = "chat.edb")
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name);
        using var c = Open(path);
        Exec(c, """
            CREATE TABLE _chat (_id TEXT PRIMARY KEY, _lastUpdatedTime INTEGER, _unreadCount INTEGER);
            CREATE TABLE _message (_id TEXT PRIMARY KEY, _chatId TEXT, _from TEXT, _createdTime INTEGER,
                                   _text TEXT, _contentType INTEGER, _contentMetadata TEXT);
            CREATE TABLE _contact (_mid TEXT PRIMARY KEY, _displayName TEXT, _displayNameOverridden TEXT, _type TEXT,
                                   _status TEXT, _settings INTEGER, _statusMessage TEXT, _picturePath TEXT, _thumbnailUrl TEXT,
                                   _targetProfileDetail TEXT, _blockDetail TEXT);
            CREATE TABLE _chatOption (_id TEXT PRIMARY KEY, _hidden INTEGER, _notification INTEGER, _pinnedTime INTEGER);
            CREATE TABLE _setting (_key TEXT PRIMARY KEY, _value TEXT);
            CREATE TABLE _groupChat (_chatMid TEXT PRIMARY KEY, _chatName TEXT);
            CREATE TABLE _profile (_mid TEXT PRIMARY KEY, _displayName TEXT, _picturePath TEXT);
            """);
        return path;
    }

    public static SqliteConnection Open(string path) =>
        OpenRaw(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());

    public static string CreateKeep(string dir, string name = "keep_abc.edb")
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name);
        using var c = Open(path);
        Exec(c, "CREATE TABLE _keep_content (_contentId TEXT PRIMARY KEY, _createdTime INTEGER, _name TEXT, _mainType TEXT, _size INTEGER, _messageId TEXT);");
        return path;
    }

    public static void Keep(SqliteConnection c, string id, long createdMs, string name, string mainType) =>
        Run(c, "INSERT INTO _keep_content(_contentId,_createdTime,_name,_mainType,_size) VALUES($i,$t,$n,$m,0)",
            ("$i", id), ("$t", createdMs), ("$n", name), ("$m", mainType));

    private static SqliteConnection OpenRaw(string cs)
    {
        var c = new SqliteConnection(cs);
        c.Open();
        return c;
    }

    public static void Chat(SqliteConnection c, string id, long updated = 0, int unread = 0) =>
        Run(c, "INSERT INTO _chat(_id,_lastUpdatedTime,_unreadCount) VALUES($i,$u,$n)",
            ("$i", id), ("$u", updated), ("$n", unread));

    public static void Group(SqliteConnection c, string chatMid, string name) =>
        Run(c, "INSERT INTO _groupChat(_chatMid,_chatName) VALUES($m,$n)", ("$m", chatMid), ("$n", name));

    public static void Contact(SqliteConnection c, string mid, string display) =>
        Run(c, "INSERT INTO _contact(_mid,_displayName) VALUES($m,$d)", ("$m", mid), ("$d", display));

    /// <summary>A LINE 26.x-shaped contact: plain columns NULL unless given, the profile in _targetProfileDetail JSON.</summary>
    public static void Contact26(SqliteConnection c, string mid, string? profileJson, string? display = null,
        string? overridden = null, string? blockJson = null) =>
        Run(c, "INSERT INTO _contact(_mid,_displayName,_displayNameOverridden,_targetProfileDetail,_blockDetail) VALUES($m,$d,$o,$p,$b)",
            ("$m", mid), ("$d", (object?)display ?? DBNull.Value), ("$o", (object?)overridden ?? DBNull.Value),
            ("$p", (object?)profileJson ?? DBNull.Value), ("$b", (object?)blockJson ?? DBNull.Value));

    public static void OwnProfile(SqliteConnection c, string mid, string display) =>
        Run(c, "INSERT INTO _profile(_mid,_displayName) VALUES($m,$d)", ("$m", mid), ("$d", display));

    public static void ContactFull(SqliteConnection c, string mid, string display, string status, int settings) =>
        Run(c, "INSERT INTO _contact(_mid,_displayName,_status,_settings) VALUES($m,$d,$s,$g)",
            ("$m", mid), ("$d", display), ("$s", status), ("$g", settings));

    public static void ChatOption(SqliteConnection c, string id, bool hidden) =>
        Run(c, "INSERT INTO _chatOption(_id,_hidden,_notification,_pinnedTime) VALUES($i,$h,1,0)", ("$i", id), ("$h", hidden ? 1 : 0));

    public static void Setting(SqliteConnection c, string key, string value) =>
        Run(c, "INSERT INTO _setting(_key,_value) VALUES($k,$v)", ("$k", key), ("$v", value));

    public static void Message(SqliteConnection c, string id, string chatId, string from, long createdMs, string text,
        int contentType = 0, string? meta = null) =>
        Run(c, """
            INSERT INTO _message(_id,_chatId,_from,_createdTime,_text,_contentType,_contentMetadata)
            VALUES($i,$c,$f,$t,$x,$ct,$m)
            """,
            ("$i", id), ("$c", chatId), ("$f", from), ("$t", createdMs), ("$x", text), ("$ct", contentType),
            ("$m", (object?)meta ?? DBNull.Value));

    public static void Exec(SqliteConnection c, string sql)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static void Run(SqliteConnection c, string sql, params (string, object)[] args)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (k, v) in args) cmd.Parameters.AddWithValue(k, v);
        cmd.ExecuteNonQuery();
    }
}

public class LineProbeTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Probe_classifies_sqlite_encrypted_and_json_and_lists_tables()
    {
        var root = _dir.Sub("LINE", "Data");
        var dbPath = LineFixture.Create(root, "good.edb");       // plain SQLite
        SqliteConnection.ClearAllPools();
        // A random-header .edb file (looks like an encrypted wxSQLite3 store).
        var rnd = new byte[4096];
        new Random(1).NextBytes(rnd);
        rnd[0] = 0x9f; // ensure not the SQLite magic and not printable-text heavy
        File.WriteAllBytes(Path.Combine(root, "cache.edb"), rnd);
        // A JSON config file.
        File.WriteAllText(Path.Combine(root, "settings.json"), "{\n  \"a\": 1\n}");

        var report = new LineStoreProbe(new[] { new LineProbeRoot("installer", root) }).Run("26.3", DateTimeOffset.UtcNow);

        Assert.Equal(3, report.Summary.TotalFiles);
        Assert.Equal(1, report.Summary.Readable);   // the plain SQLite file
        Assert.Equal(2, report.Summary.Databases);  // SQLite + encrypted .edb

        var files = report.Locations.Single().Files;
        var good = files.Single(f => f.RelativePath == "good.edb");
        Assert.Equal(nameof(LineFileKind.Sqlite), good.Kind);
        Assert.False(good.LooksEncrypted);
        Assert.NotNull(good.Tables);
        Assert.Contains(good.Tables!, t => t.Name == "_message" && t.Columns.Contains("_createdTime"));

        var enc = files.Single(f => f.RelativePath == "cache.edb");
        Assert.Equal(nameof(LineFileKind.Binary), enc.Kind);
        Assert.True(enc.LooksEncrypted);
        Assert.Null(enc.Tables);

        var json = files.Single(f => f.RelativePath == "settings.json");
        Assert.Equal(nameof(LineFileKind.Json), json.Kind);

        Assert.Equal("Probe complete: 3 files, 2 databases, 1 readable", report.HumanSummary());
        Assert.Contains(good.Tables!, t => t.Name == "_chat");
        Assert.EndsWith("good.edb", dbPath);
    }

    [Fact]
    public void Probe_with_a_decryptor_lists_the_encrypted_store_schema()
    {
        var root = _dir.Sub("line-dec");
        // A real encrypted LINE-shaped store.
        var dbPath = LineFixture.Create(root, "qwabc.edb");
        SqliteConnection.ClearAllPools();
        var plain = File.ReadAllBytes(dbPath);
        var pageSize = (plain[16] << 8) | (plain[17] << 16);
        var key = LineWxCipher.DeriveKey(System.Text.Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef"));
        File.WriteAllBytes(dbPath, LineWxCipher.Encrypt(plain, key, pageSize));

        Func<string, byte[]?> decryptor = path => LineWxCipher.Decrypt(File.ReadAllBytes(path), key);
        var report = new LineStoreProbe(new[] { new LineProbeRoot("installer", root) }).Run("26.5", DateTimeOffset.UtcNow, decryptor);

        var enc = report.Locations.Single().Files.Single(f => f.RelativePath == "qwabc.edb");
        Assert.True(enc.LooksEncrypted);
        Assert.NotNull(enc.Tables); // decrypted schema listed
        Assert.Contains(enc.Tables!, t => t.Name == "_message");
        Assert.Contains(enc.Tables!, t => t.Name == "_contact");
        Assert.Contains("decrypted schema", enc.Note);
    }

    [Fact]
    public void Probe_reports_missing_location_without_throwing()
    {
        var report = new LineStoreProbe(new[] { new LineProbeRoot("installer", _dir.Sub("nope")) })
            .Run("26.3", DateTimeOffset.UtcNow);
        Assert.False(report.Locations.Single().Exists);
        Assert.Equal(0, report.Summary.TotalFiles);
    }
}

public class LineCollectorTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly string _dataFolder;
    private readonly string _dbPath;

    public LineCollectorTests()
    {
        _env = new TestEnv(_dir);
        _dataFolder = _dir.Sub("LINE", "Data");
        _dbPath = LineFixture.Create(_dataFolder);
        SqliteConnection.ClearAllPools();
    }

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private LineDesktopCollector NewCollector(LineSettings? settings = null, Func<string, LineStoreMap>? mapFor = null,
        ILineStoreUnlocker? unlocker = null, CollectorContext? ctx = null) =>
        new(ctx ?? _env.Context, settings,
            roots: new[] { new LineProbeRoot("test", _dataFolder) },
            unlocker: unlocker,
            mapFor: mapFor,
            reportDir: _dir.Sub("report"),
            tempRoot: _dir.Sub("line-tmp"));

    private void Seed(Action<SqliteConnection> seed)
    {
        using var c = LineFixture.Open(_dbPath);
        seed(c);
        c.Dispose();
        SqliteConnection.ClearAllPools();
    }

    private IReadOnlyList<CapturedRecord> Batches() => _env.Sink.Of(Kind.MessageBatch);

    [Fact]
    public async Task Walks_messages_and_emits_partial_batches_with_chatMeta_and_attachments()
    {
        Seed(c =>
        {
            LineFixture.Chat(c, "cGROUP", unread: 0);
            LineFixture.Chat(c, "uALICE");
            LineFixture.Group(c, "cGROUP", "Robotics Team");
            LineFixture.Contact(c, "uALICE", "Alice Chen");
            LineFixture.Message(c, "m1", "cGROUP", "uALICE", 1_760_000_000_000, "Are we still on?");
            LineFixture.Message(c, "m2", "cGROUP", "uALICE", 1_760_000_100_000, "photo.jpg", contentType: 1,
                meta: "{\"FILE_NAME\":\"photo.jpg\"}");
            LineFixture.Message(c, "m3", "uALICE", "uALICE", 1_760_000_200_000, "dm hello");
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.OkPartial, line.State);
        Assert.Null(line.LastError);
        var batches = Batches();
        Assert.Equal(2, batches.Count); // one per chat with new messages

        var group = batches.Single(b => b.Root.GetProperty("convKey").GetString() == "cGROUP");
        Assert.Equal("partial", group.Str("coverage"));
        Assert.Equal("windows:line-desktop", group.Str("sourceSession"));
        Assert.Equal("line", group.Str("platform"));
        Assert.Equal("group", group.Str("convKind"));
        Assert.Equal("Robotics Team", group.Root.GetProperty("chatMeta").GetProperty("title").GetString());
        Assert.Equal("group", group.Root.GetProperty("chatMeta").GetProperty("chatType").GetString());

        var msgs = group.Root.GetProperty("messages");
        Assert.Equal(2, msgs.GetArrayLength());
        var first = msgs[0];
        Assert.Equal("m1", first.GetProperty("msgId").GetString());
        Assert.Equal("uALICE", first.GetProperty("sender").GetString());        // stable id
        Assert.Equal("Alice Chen", first.GetProperty("senderName").GetString()); // resolved via _contact
        Assert.Equal("2025-10-09T08:53:20.000Z", first.GetProperty("sentAt").GetString());
        var media = msgs[1];
        Assert.Equal("image", media.GetProperty("mediaKind").GetString());
        var att = media.GetProperty("attachments")[0];
        Assert.Equal("image", att.GetProperty("kind").GetString());
        Assert.Equal("photo.jpg", att.GetProperty("filename").GetString());

        var dm = batches.Single(b => b.Root.GetProperty("convKey").GetString() == "uALICE");
        Assert.Equal("dm", dm.Str("convKind"));
        Assert.Equal("Alice Chen", dm.Str("peer"));
    }

    [Fact]
    public async Task Cursor_resumes_across_restart_and_only_new_messages_are_emitted()
    {
        Seed(c =>
        {
            LineFixture.Chat(c, "cGROUP");
            LineFixture.Message(c, "m1", "cGROUP", "u1", 1_760_000_000_000, "one");
            LineFixture.Message(c, "m2", "cGROUP", "u1", 1_760_000_100_000, "two");
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);
        Assert.Equal(2, CountMessages(Batches()));

        _env.Sink.Clear();
        // A second tick with nothing new emits no batch.
        await line.TickAsync(default);
        Assert.Empty(Batches());

        // A fresh collector on the same db (process restart) loads the saved cursors.
        Seed(c => LineFixture.Message(c, "m3", "cGROUP", "u1", 1_760_000_200_000, "three"));
        var restarted = NewCollector();
        await restarted.StartAsync(default);
        await restarted.TickAsync(default);
        var batches = Batches();
        Assert.Equal(1, CountMessages(batches));
        Assert.Equal("m3", batches.Single().Root.GetProperty("messages")[0].GetProperty("msgId").GetString());
    }

    [Fact]
    public async Task Missing_message_table_is_red_with_reason_and_captures_nothing()
    {
        Seed(c => LineFixture.Exec(c, "DROP TABLE _message;"));
        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.UnverifiedMap, line.State);
        Assert.Contains("_message", line.LastError);
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task Renamed_column_is_red_with_reason_and_captures_nothing()
    {
        Seed(c => LineFixture.Exec(c, "ALTER TABLE _message RENAME COLUMN _text TO _body;"));
        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.UnverifiedMap, line.State);
        Assert.Contains("_text", line.LastError);
        Assert.Contains("drift", line.LastError!);
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task Implausible_timestamp_is_red_with_reason()
    {
        Seed(c =>
        {
            LineFixture.Chat(c, "cG");
            // 1_760_000_000 (seconds) read as milliseconds → year 1970 → implausible.
            LineFixture.Message(c, "m1", "cG", "u1", 1_760_000_000, "oops");
        });
        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.UnverifiedMap, line.State);
        Assert.Contains("implausible", line.LastError!);
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task Encrypted_header_reports_encrypted_store_and_not_implemented_unlocker()
    {
        // Replace the plain fixture with a random-header file under the db pattern.
        File.Delete(_dbPath);
        foreach (var s in new[] { "-wal", "-shm" }) if (File.Exists(_dbPath + s)) File.Delete(_dbPath + s);
        var rnd = new byte[8192];
        new Random(2).NextBytes(rnd);
        rnd[0] = 0xd1;
        File.WriteAllBytes(Path.Combine(_dataFolder, "store.edb"), rnd);

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.EncryptedStore, line.State);
        Assert.Contains("is encrypted", line.LastError!);
        Assert.Contains("phone", line.LastError!);
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task Version_change_triggers_reverification_against_the_new_map()
    {
        Seed(c =>
        {
            LineFixture.Chat(c, "cG");
            LineFixture.Message(c, "m1", "cG", "u1", 1_760_000_000_000, "hi");
        });

        var good = LineStoreMap.ShippedDefault;
        // A map for version "27.0" that points the message table at a name that does not exist (as if a LINE
        // update moved it) — verification must run again after the version changes and go red.
        var bad = good with { Version = "27.0", Messages = good.Messages with { Table = "_message_v27" } };

        var line = NewCollector(settings: new LineSettings { Version = "26.3" },
            mapFor: v => v == "27.0" ? bad : good);
        await line.StartAsync(default);
        await line.TickAsync(default);
        Assert.Equal(LineState.OkPartial, line.State);

        // LINE "updates": the reported version changes, and the next tick re-verifies the new map.
        var updated = NewCollector(settings: new LineSettings { Version = "27.0" },
            mapFor: v => v == "27.0" ? bad : good, ctx: _env.Context);
        await updated.StartAsync(default);
        await updated.TickAsync(default);
        Assert.Equal(LineState.UnverifiedMap, updated.State);
        Assert.Contains("_message_v27", updated.LastError!);
    }

    [Fact]
    public async Task Run_probe_writes_a_report_and_clears_the_flag()
    {
        var line = NewCollector(settings: new LineSettings { RunProbe = true });
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.NotNull(line.LastReportPath);
        Assert.True(File.Exists(line.LastReportPath!));
        var json = JsonDocument.Parse(File.ReadAllText(line.LastReportPath!));
        Assert.Equal(1, json.RootElement.GetProperty("schema").GetInt32());
        // The flag is consumed, so a second tick does not re-run the probe.
        Assert.False(line.Settings.RunProbe);
    }

    [Fact]
    public void Poll_cadence_defaults_to_five_seconds() => Assert.Equal(5, new LineSettings().PollSeconds);

    private LineDesktopCollector CollectorWithSavedPoll(int seconds)
    {
        // The host merges saved settings over the defaults before StartAsync; mirror that here.
        var line = NewCollector();
        line.ApplySettings(Ivy.Collectors.Host.CollectorHost.Merge(line.GetSettingsJson(), new System.Text.Json.Nodes.JsonObject { ["pollSeconds"] = seconds }));
        return line;
    }

    [Fact]
    public async Task Saved_300_second_poll_is_migrated_to_5_once()
    {
        var line = CollectorWithSavedPoll(300);
        await line.StartAsync(default);
        Assert.Equal(TimeSpan.FromSeconds(5), line.Interval);
        Assert.Equal(5, (int)_env.Context.Settings.LoadSettings(CollectorNames.Line)!["pollSeconds"]!);

        // the user sets 300 again and restarts: not migrated a second time
        line.ApplySettings(Ivy.Collectors.Host.CollectorHost.Merge(line.GetSettingsJson(), new System.Text.Json.Nodes.JsonObject { ["pollSeconds"] = 300 }));
        var again = NewCollector();
        again.ApplySettings(line.GetSettingsJson());
        await again.StartAsync(default);
        Assert.Equal(TimeSpan.FromSeconds(300), again.Interval);
    }

    [Fact]
    public async Task Saved_custom_poll_is_left_alone()
    {
        var line = CollectorWithSavedPoll(60);
        await line.StartAsync(default);
        Assert.Equal(TimeSpan.FromSeconds(60), line.Interval);
    }

    [Fact]
    public async Task Not_installed_when_no_data_folder_exists()
    {
        var line = new LineDesktopCollector(_env.Context, new LineSettings(),
            roots: new[] { new LineProbeRoot("test", _dir.Sub("absent")) },
            reportDir: _dir.Sub("report"), tempRoot: _dir.Sub("line-tmp"));
        await line.StartAsync(default);
        await line.TickAsync(default);
        Assert.Equal(LineState.NotInstalled, line.State);
        Assert.Null(line.LastError);
        Assert.Empty(Batches());
    }

    [Fact]
    public void Shipped_map_records_the_real_store_magic_and_version()
    {
        var map = LineStoreMap.ShippedDefault;
        Assert.Equal("26.5", map.Version);
        Assert.Equal("ea8ac8444445429a", map.EncryptedHeaderMagicHex);
        Assert.False(map.Verified);
    }

    [Fact]
    public void Not_implemented_unlocker_reports_an_honest_reason_and_points_to_the_phone()
    {
        var result = NotImplementedUnlocker.Instance.TryOpen("ignored.edb", LineStoreMap.ShippedDefault);
        Assert.False(result.Ok);
        Assert.Null(result.Connection);
        Assert.Contains("phone", result.Reason);
        Assert.Contains("no LINE messages", result.Reason);
    }

    [Fact]
    public void FindDb_prefers_the_store_that_has_a_wal_sidecar_over_a_larger_one()
    {
        var dir = _dir.Sub("find-db");
        Directory.CreateDirectory(dir);
        // A large decoy with no sidecar (like AutoSuggest), and a smaller store that has a -wal (the chat store).
        File.WriteAllBytes(Path.Combine(dir, "AutoSuggest.edb"), new byte[10_000_000]);
        var store = Path.Combine(dir, "qwdeadbeef.edb");
        File.WriteAllBytes(store, new byte[500_000]);
        File.WriteAllBytes(store + "-wal", new byte[4_000_000]);

        Assert.Equal(store, LineStore.FindDb(dir, "*.edb"));
    }

    private static readonly byte[] LineKey = System.Text.Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");

    // Encrypt the fixture store in place with the wxSQLite3 scheme, as LINE for Windows stores it.
    private void EncryptStoreInPlace(string dbPath)
    {
        SqliteConnection.ClearAllPools();
        var plain = File.ReadAllBytes(dbPath);
        var pageSize = (plain[16] << 8) | (plain[17] << 16);
        var baseKey = LineWxCipher.DeriveKey(LineKey);
        File.WriteAllBytes(dbPath, LineWxCipher.Encrypt(plain, baseKey, pageSize));
    }

    [Fact]
    public async Task Decrypts_an_encrypted_store_with_the_key_and_reads_messages()
    {
        Seed(c =>
        {
            LineFixture.Chat(c, "c1", updated: 100);
            LineFixture.Message(c, "m1", "c1", "uA", 1_700_000_000_000, "hello from LINE");
            LineFixture.Message(c, "m2", "c1", "uB", 1_700_000_050_000, "second message");
        });
        EncryptStoreInPlace(_dbPath);

        var line = new LineDesktopCollector(_env.Context, new LineSettings(),
            roots: new[] { new LineProbeRoot("test", _dataFolder) },
            reportDir: _dir.Sub("rep"), tempRoot: _dir.Sub("tmp"),
            keyStore: new InMemoryLineKeyStore(LineKey));
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.OkPartial, line.State);
        Assert.True(line.HasKey);
        Assert.Equal(2, CountMessages(Batches()));
    }

    [Fact]
    public async Task A_wrong_line_key_is_red_and_captures_nothing()
    {
        Seed(c => { LineFixture.Chat(c, "c1"); LineFixture.Message(c, "m1", "c1", "uA", 1, "x"); });
        EncryptStoreInPlace(_dbPath);

        var wrong = System.Text.Encoding.ASCII.GetBytes("ffffffffffffffffffffffffffffffff");
        var line = new LineDesktopCollector(_env.Context, new LineSettings(),
            roots: new[] { new LineProbeRoot("test", _dataFolder) },
            reportDir: _dir.Sub("rep2"), tempRoot: _dir.Sub("tmp2"),
            keyStore: new InMemoryLineKeyStore(wrong));
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.EncryptedStore, line.State);
        Assert.Contains("does not fit", line.LastError);
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task Dm_marks_my_messages_from_me_and_resolves_sender_names()
    {
        Seed(c =>
        {
            LineFixture.Contact(c, "uBOB", "Bob");          // the peer
            LineFixture.Chat(c, "uBOB");                     // a 1:1 chat keyed by the peer mid
            LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "hi from Bob"); // peer -> theirs
            LineFixture.Message(c, "m2", "uBOB", "uME", 1_760_000_100_000, "hi from me");    // me -> mine
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        var dm = Batches().Single(b => b.Root.GetProperty("convKey").GetString() == "uBOB");
        var msgs = dm.Root.GetProperty("messages");
        var theirs = msgs[0]; var mine = msgs[1];
        Assert.False(theirs.GetProperty("fromMe").GetBoolean());
        Assert.Equal("Bob", theirs.GetProperty("senderName").GetString());
        Assert.True(mine.GetProperty("fromMe").GetBoolean());
        Assert.Equal("You", mine.GetProperty("senderName").GetString());
    }

    [Fact]
    public async Task Group_marks_my_messages_from_me_via_the_own_profile_mid()
    {
        Seed(c =>
        {
            LineFixture.OwnProfile(c, "uME", "Me");
            LineFixture.Contact(c, "uALICE", "Alice");
            LineFixture.Group(c, "cTEAM", "Team");
            LineFixture.Chat(c, "cTEAM");
            LineFixture.Message(c, "m1", "cTEAM", "uALICE", 1_760_000_000_000, "hi all");   // Alice -> theirs
            LineFixture.Message(c, "m2", "cTEAM", "uME", 1_760_000_100_000, "hi from me");  // me -> mine
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        var team = Batches().Single(b => b.Root.GetProperty("convKey").GetString() == "cTEAM");
        var msgs = team.Root.GetProperty("messages");
        Assert.False(msgs[0].GetProperty("fromMe").GetBoolean());
        Assert.Equal("Alice", msgs[0].GetProperty("senderName").GetString());
        Assert.True(msgs[1].GetProperty("fromMe").GetBoolean());
        Assert.Equal("You", msgs[1].GetProperty("senderName").GetString());
    }

    [Fact]
    public async Task Captures_the_account_snapshot_profile_contacts_hidden_and_settings()
    {
        Seed(c =>
        {
            LineFixture.OwnProfile(c, "uME", "Me");
            LineFixture.ContactFull(c, "uALICE", "Alice", status: "FRIEND", settings: 0);
            LineFixture.ContactFull(c, "uTROLL", "Troll", status: "FRIEND", settings: 1);  // raw status/settings kept
            LineFixture.Chat(c, "uALICE");
            LineFixture.ChatOption(c, "uALICE", hidden: false);
            LineFixture.ChatOption(c, "uTROLL", hidden: true);
            LineFixture.Setting(c, "notification.enabled", "true");
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        var acct = _env.Sink.Of(Kind.LineAccount).Single();
        Assert.Equal("uME", acct.Root.GetProperty("ownProfile").GetProperty("mid").GetString());
        var contacts = acct.Root.GetProperty("contacts");
        Assert.Equal(2, contacts.GetArrayLength());
        var troll = System.Linq.Enumerable.Range(0, 2).Select(i => contacts[i]).Single(x => x.GetProperty("mid").GetString() == "uTROLL");
        Assert.Equal(1, troll.GetProperty("settings").GetInt32());        // raw settings captured
        var opts = acct.Root.GetProperty("chatOptions");
        var hiddenOpt = System.Linq.Enumerable.Range(0, opts.GetArrayLength()).Select(i => opts[i]).Single(x => x.GetProperty("chatId").GetString() == "uTROLL");
        Assert.True(hiddenOpt.GetProperty("hidden").GetBoolean());        // hidden is reliable now
        Assert.Contains(System.Linq.Enumerable.Range(0, acct.Root.GetProperty("settings").GetArrayLength())
            .Select(i => acct.Root.GetProperty("settings")[i]), x => x.GetProperty("key").GetString() == "notification.enabled");
    }

    [Fact]
    public async Task Captures_line_keep_as_a_conversation()
    {
        // main chat store (encrypted, keyed) so the collector reaches the keep step
        Seed(c => { LineFixture.OwnProfile(c, "uME", "Me"); LineFixture.Chat(c, "uX"); LineFixture.Message(c, "m", "uX", "uX", 1_760_000_000_000, "hi"); });
        var key = System.Text.Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
        // Encrypt the main store too (the collector has a key, so it expects an encrypted store).
        SqliteConnection.ClearAllPools();
        var mplain = File.ReadAllBytes(_dbPath);
        var mps = (mplain[16] << 8) | (mplain[17] << 16);
        File.WriteAllBytes(_dbPath, LineWxCipher.Encrypt(mplain, LineWxCipher.DeriveKey(key), mps));

        // a keep store next to it, encrypted with the same key
        var keepPlain = LineFixture.CreateKeep(_dataFolder);
        using (var kc = LineFixture.Open(keepPlain))
        {
            LineFixture.Keep(kc, "k1", 1_760_000_000_000, "My note", "TEXT");
            LineFixture.Keep(kc, "k2", 1_760_000_100_000, "beach.jpg", "IMAGE");
        }
        SqliteConnection.ClearAllPools();
        var kplain = File.ReadAllBytes(keepPlain);
        var ps = (kplain[16] << 8) | (kplain[17] << 16);
        File.WriteAllBytes(keepPlain, LineWxCipher.Encrypt(kplain, LineWxCipher.DeriveKey(key), ps));

        var line = new LineDesktopCollector(_env.Context, new LineSettings(),
            roots: new[] { new LineProbeRoot("test", _dataFolder) },
            reportDir: _dir.Sub("rk"), tempRoot: _dir.Sub("tk"),
            keyStore: new InMemoryLineKeyStore(key));
        await line.StartAsync(default);
        await line.TickAsync(default);

        var keep = Batches().Single(b => b.Root.GetProperty("convKey").GetString() == "keep");
        Assert.Equal("LINE Keep", keep.Root.GetProperty("chatMeta").GetProperty("title").GetString());
        Assert.Equal(2, keep.Root.GetProperty("messages").GetArrayLength());
    }

    private void SeedAccount() => Seed(c =>
    {
        LineFixture.OwnProfile(c, "uME", "Me");
        LineFixture.ContactFull(c, "uALICE", "Alice", status: "FRIEND", settings: 0);
        LineFixture.Chat(c, "uALICE");
    });

    [Fact]
    public async Task Unchanged_account_snapshot_is_emitted_once_across_ticks()
    {
        SeedAccount();
        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);
        _env.Time.Advance(TimeSpan.FromSeconds(5));
        await line.TickAsync(default);
        _env.Time.Advance(TimeSpan.FromSeconds(5));
        await line.TickAsync(default);

        Assert.Single(_env.Sink.Of(Kind.LineAccount));
    }

    [Fact]
    public async Task Changed_contact_name_emits_a_second_account_snapshot()
    {
        SeedAccount();
        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);
        Seed(c =>
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = "UPDATE _contact SET _displayName='Alice B' WHERE _mid='uALICE'";
            cmd.ExecuteNonQuery();
        });
        _env.Time.Advance(TimeSpan.FromSeconds(5));
        await line.TickAsync(default);

        Assert.Equal(2, _env.Sink.Of(Kind.LineAccount).Count);
    }

    [Fact]
    public async Task Persisted_account_hash_skips_the_snapshot_after_restart_until_resync()
    {
        SeedAccount();
        var first = NewCollector();
        await first.StartAsync(default);
        await first.TickAsync(default);
        Assert.Single(_env.Sink.Of(Kind.LineAccount));

        _env.Time.Advance(TimeSpan.FromMinutes(1));
        var restarted = NewCollector(ctx: _env.Restart());
        await restarted.StartAsync(default);
        await restarted.TickAsync(default);
        Assert.Single(_env.Sink.Of(Kind.LineAccount));   // unchanged: not re-uploaded after a restart

        restarted.RequestResync();
        await restarted.TickAsync(default);
        Assert.Equal(2, _env.Sink.Of(Kind.LineAccount).Count);
    }

    // ---------------------------------------------------------------- LINE 26.x names (_targetProfileDetail)

    private static IEnumerable<JsonElement> Items(JsonElement array) =>
        System.Linq.Enumerable.Range(0, array.GetArrayLength()).Select(i => array[i]);

    [Fact]
    public async Task Null_displayName_resolves_from_profile_json_as_dm_title_and_sender_name()
    {
        Seed(c =>
        {
            LineFixture.OwnProfile(c, "uME", "Me");
            LineFixture.Contact26(c, "uBOB", """{"profileName":"Bob Lee","profileId":"x","picturePath":"/os/p/uBOB","pictureStatus":"0","hiddenFromList":false,"snapshotTimeMillis":1}""");
            LineFixture.Contact26(c, "uALICE", """{"profileName":"Alice","hiddenFromList":false}""");
            LineFixture.Group(c, "cTEAM", "Team");
            LineFixture.Chat(c, "uBOB");
            LineFixture.Chat(c, "cTEAM");
            LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "hi from Bob");
            LineFixture.Message(c, "m2", "uBOB", "uME", 1_760_000_100_000, "hi from me");
            LineFixture.Message(c, "m3", "cTEAM", "uALICE", 1_760_000_200_000, "hi team");
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        var dm = Batches().Single(b => b.Root.GetProperty("convKey").GetString() == "uBOB");
        Assert.Equal("dm", dm.Str("convKind"));
        Assert.Equal("Bob Lee", dm.Str("peer"));
        Assert.Equal("Bob Lee", dm.Root.GetProperty("chatMeta").GetProperty("title").GetString());
        var msgs = dm.Root.GetProperty("messages");
        Assert.Equal("uBOB", msgs[0].GetProperty("sender").GetString());      // the mid stays the merge key
        Assert.False(msgs[0].GetProperty("fromMe").GetBoolean());
        Assert.Equal("Bob Lee", msgs[0].GetProperty("senderName").GetString());
        Assert.True(msgs[1].GetProperty("fromMe").GetBoolean());
        Assert.Equal("You", msgs[1].GetProperty("senderName").GetString());

        var team = Batches().Single(b => b.Root.GetProperty("convKey").GetString() == "cTEAM");
        Assert.Equal("Team", team.Root.GetProperty("chatMeta").GetProperty("title").GetString());
        Assert.Equal("Alice", team.Root.GetProperty("messages")[0].GetProperty("senderName").GetString());
    }

    [Fact]
    public async Task DisplayNameOverridden_wins_over_displayName_and_profile_json()
    {
        Seed(c =>
        {
            LineFixture.Contact26(c, "uBOB", """{"profileName":"Bob Lee"}""", display: "Bob Plain", overridden: "Bobby (work)");
            LineFixture.Contact26(c, "uCARL", """{"profileName":"Carl JSON"}""", display: "Carl Plain");
            LineFixture.Chat(c, "uBOB");
            LineFixture.Chat(c, "uCARL");
            LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "hi");
            LineFixture.Message(c, "m2", "uCARL", "uCARL", 1_760_000_000_000, "yo");
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        var bob = Batches().Single(b => b.Root.GetProperty("convKey").GetString() == "uBOB");
        Assert.Equal("Bobby (work)", bob.Str("peer"));
        Assert.Equal("Bobby (work)", bob.Root.GetProperty("messages")[0].GetProperty("senderName").GetString());
        var carl = Batches().Single(b => b.Root.GetProperty("convKey").GetString() == "uCARL");
        Assert.Equal("Carl Plain", carl.Str("peer"));                          // plain column beats the JSON
    }

    [Theory]
    [InlineData("{not json")]
    [InlineData("[\"profileName\",\"Bob\"]")]
    [InlineData("\"Bob\"")]
    [InlineData("{\"profileName\":42}")]
    [InlineData("{\"profileName\":\"\"}")]
    public async Task Malformed_or_unusable_profile_json_yields_no_name_and_no_exception(string json)
    {
        Seed(c =>
        {
            LineFixture.Contact26(c, "uBOB", json);
            LineFixture.Chat(c, "uBOB");
            LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "hi");
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.OkPartial, line.State);
        Assert.Null(line.LastError);
        var dm = Batches().Single();
        Assert.Equal("uBOB", dm.Str("peer"));                                  // falls back to the mid, as before
        Assert.False(dm.Root.GetProperty("messages")[0].TryGetProperty("senderName", out var sn) && sn.ValueKind == JsonValueKind.String);
        var acct = _env.Sink.Of(Kind.LineAccount).Single();
        var bob = Items(acct.Root.GetProperty("contacts")).Single();
        Assert.False(bob.TryGetProperty("displayName", out var dn) && dn.ValueKind == JsonValueKind.String);
    }

    [Fact]
    public async Task Account_snapshot_fills_contact_name_picture_status_and_blocked_from_json()
    {
        Seed(c =>
        {
            LineFixture.OwnProfile(c, "uME", "Me");
            LineFixture.Contact26(c, "uBOB",
                """{"profileName":"Bob Lee","picturePath":"/os/p/uBOB","statusMessage":"at work","hiddenFromList":false}""",
                blockJson: """{"bot":null,"notBlocked":true,"user":null}""");
            LineFixture.Contact26(c, "uTROLL", """{"profileName":"Troll","picturePath":"/os/p/uTROLL"}""",
                blockJson: """{"notBlocked":false}""");
            LineFixture.Contact26(c, "uODD", """{"profileName":"Odd"}""",
                blockJson: """{"bot":{},"notBlocked":{},"user":{}}""");        // not a plain boolean: unknown
            LineFixture.Chat(c, "uBOB");
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        var contacts = Items(_env.Sink.Of(Kind.LineAccount).Single().Root.GetProperty("contacts")).ToList();
        var bob = contacts.Single(x => x.GetProperty("mid").GetString() == "uBOB");
        Assert.Equal("Bob Lee", bob.GetProperty("displayName").GetString());
        Assert.Equal("/os/p/uBOB", bob.GetProperty("picturePath").GetString());
        Assert.Equal("at work", bob.GetProperty("statusMessage").GetString());
        Assert.False(bob.GetProperty("blocked").GetBoolean());
        var troll = contacts.Single(x => x.GetProperty("mid").GetString() == "uTROLL");
        Assert.True(troll.GetProperty("blocked").GetBoolean());
        var odd = contacts.Single(x => x.GetProperty("mid").GetString() == "uODD");
        Assert.False(odd.TryGetProperty("blocked", out var ob) && ob.ValueKind is JsonValueKind.True or JsonValueKind.False);
    }

    [Fact]
    public async Task NamesV2_migration_resends_all_chats_exactly_once()
    {
        Seed(c =>
        {
            LineFixture.Contact26(c, "uBOB", """{"profileName":"Bob Lee"}""");
            LineFixture.Chat(c, "uBOB");
            LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "one");
            LineFixture.Message(c, "m2", "uBOB", "uBOB", 1_760_000_100_000, "two");
        });
        // An install from before the fix: its cursors already cover every message, and the flag is unset.
        _env.Context.Settings.SaveJson(CollectorNames.Line, "cursors", new System.Text.Json.Nodes.JsonObject { ["uBOB"] = 1_000_000 });

        var line = NewCollector();
        await line.StartAsync(default);
        Assert.Null(_env.Context.Settings.LoadJson(CollectorNames.Line, "namesV2"));   // not yet applied
        await line.TickAsync(default);
        Assert.NotNull(_env.Context.Settings.LoadJson(CollectorNames.Line, "namesV2")); // applied by the tick
        var resent = Batches().Single();
        Assert.Equal(2, CountMessages(Batches()));                               // cursors were cleared
        Assert.Equal("Bob Lee", resent.Root.GetProperty("messages")[0].GetProperty("senderName").GetString());
        Assert.Contains(_env.Activity.Recent(), e => e.Event == CollectorActivity.Config && e.Collector == CollectorNames.Line);

        _env.Sink.Clear();
        var restarted = NewCollector(ctx: _env.Restart());
        await restarted.StartAsync(default);
        await restarted.TickAsync(default);
        Assert.Empty(Batches());                                                 // not re-sent on the next start
    }

    [Fact]
    public async Task NamesV2_resync_is_requested_again_if_the_app_quits_before_the_first_tick()
    {
        Seed(c =>
        {
            LineFixture.Contact26(c, "uBOB", """{"profileName":"Bob Lee"}""");
            LineFixture.Chat(c, "uBOB");
            LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "one");
            LineFixture.Message(c, "m2", "uBOB", "uBOB", 1_760_000_100_000, "two");
        });
        _env.Context.Settings.SaveJson(CollectorNames.Line, "cursors", new System.Text.Json.Nodes.JsonObject { ["uBOB"] = 1_000_000 });

        var first = NewCollector();
        await first.StartAsync(default);                                         // quits here, no tick
        Assert.Null(_env.Context.Settings.LoadJson(CollectorNames.Line, "namesV2"));

        var restarted = NewCollector(ctx: _env.Restart());
        await restarted.StartAsync(default);
        await restarted.TickAsync(default);
        Assert.Equal(2, CountMessages(Batches()));                               // cursors cleared on its first tick
        Assert.Equal("Bob Lee", Batches().Single().Root.GetProperty("messages")[0].GetProperty("senderName").GetString());
        Assert.NotNull(_env.Context.Settings.LoadJson(CollectorNames.Line, "namesV2"));
    }

    [Fact]
    public async Task Fresh_install_sets_namesV2_without_a_resync()
    {
        Seed(c => { LineFixture.Chat(c, "uBOB"); LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "one"); });
        var line = NewCollector();
        await line.StartAsync(default);
        Assert.NotNull(_env.Context.Settings.LoadJson(CollectorNames.Line, "namesV2"));
        await line.TickAsync(default);
        Assert.Equal(1, CountMessages(Batches()));
        Assert.DoesNotContain(_env.Activity.Recent(), e => e.Event == CollectorActivity.ScanStarted && e.Collector == CollectorNames.Line);
    }

    [Fact]
    public async Task Call_records_are_emitted_with_a_call_object_and_the_store_text()
    {
        const string sysText = "system call text from the store";
        Seed(c =>
        {
            LineFixture.Chat(c, "uBOB");
            // Outgoing (sender is not the 1:1 peer), completed video call of 155.4 s.
            LineFixture.Message(c, "k1", "uBOB", "uME", 1_760_000_000_000, sysText, contentType: 6,
                meta: """{"TYPE":"V","RESULT":"NORMAL","CAUSE":"16","VERSION":"M","DURATION":"155400"}""");
            // Incoming missed audio call.
            LineFixture.Message(c, "k2", "uBOB", "uBOB", 1_760_000_100_000, sysText, contentType: 6,
                meta: """{"TYPE":"A","RESULT":"NO_RESPONSE","CAUSE":"18","VERSION":"M","DURATION":"0"}""");
            // Malformed metadata: still a call, but no call object.
            LineFixture.Message(c, "k3", "uBOB", "uBOB", 1_760_000_200_000, sysText, contentType: 6, meta: "{not json");
        });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        var msgs = Batches().Single().Root.GetProperty("messages");
        var k1 = msgs[0];
        Assert.Equal("call", k1.GetProperty("mediaKind").GetString());
        Assert.Equal(sysText, k1.GetProperty("text").GetString());               // text kept as the store has it
        Assert.Equal("""{"kind":"video","outcome":"completed","durationSec":155,"direction":"outgoing"}""", k1.GetProperty("call").GetRawText());
        Assert.Equal(0, k1.GetProperty("attachments").GetArrayLength());
        Assert.Equal("""{"kind":"audio","outcome":"missed","direction":"incoming"}""", msgs[1].GetProperty("call").GetRawText());
        Assert.Equal("call", msgs[2].GetProperty("mediaKind").GetString());
        Assert.False(msgs[2].TryGetProperty("call", out _));
    }

    [Fact]
    public async Task CallsV1_migration_resends_all_chats_once_with_the_call_field()
    {
        Seed(c =>
        {
            LineFixture.Chat(c, "uBOB");
            LineFixture.Message(c, "k1", "uBOB", "uBOB", 1_760_000_000_000, "call", contentType: 6,
                meta: """{"TYPE":"A","RESULT":"NORMAL","DURATION":"6000"}""");
        });
        // An install from before the call field: cursors cover everything, the earlier one-time flags are done.
        _env.Context.Settings.SaveJson(CollectorNames.Line, "cursors", new System.Text.Json.Nodes.JsonObject { ["uBOB"] = 1_000_000 });
        _env.Context.Settings.SaveJson(CollectorNames.Line, "namesV2", System.Text.Json.Nodes.JsonValue.Create(true));
        _env.Context.Settings.SaveJson(CollectorNames.Line, "accountKeyV1", System.Text.Json.Nodes.JsonValue.Create(true));

        var line = NewCollector();
        await line.StartAsync(default);
        Assert.Null(_env.Context.Settings.LoadJson(CollectorNames.Line, "callsV1"));   // not applied before a tick
        await line.TickAsync(default);
        Assert.NotNull(_env.Context.Settings.LoadJson(CollectorNames.Line, "callsV1"));
        var call = Batches().Single().Root.GetProperty("messages")[0].GetProperty("call");
        Assert.Equal(6, call.GetProperty("durationSec").GetInt64());

        _env.Sink.Clear();
        var restarted = NewCollector(ctx: _env.Restart());
        await restarted.StartAsync(default);
        await restarted.TickAsync(default);
        Assert.Empty(Batches());                                                  // only once
    }

    [Fact]
    public async Task Fresh_install_sets_callsV1_without_a_resync()
    {
        Seed(c => { LineFixture.Chat(c, "uBOB"); LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "one"); });
        var line = NewCollector();
        await line.StartAsync(default);
        Assert.NotNull(_env.Context.Settings.LoadJson(CollectorNames.Line, "callsV1"));
    }

    [Fact]
    public async Task Unchanged_keep_is_emitted_once_across_ticks()
    {
        Seed(c => { LineFixture.OwnProfile(c, "uME", "Me"); LineFixture.Chat(c, "uX"); LineFixture.Message(c, "m", "uX", "uX", 1_760_000_000_000, "hi"); });
        var key = System.Text.Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
        SqliteConnection.ClearAllPools();
        var mplain = File.ReadAllBytes(_dbPath);
        File.WriteAllBytes(_dbPath, LineWxCipher.Encrypt(mplain, LineWxCipher.DeriveKey(key), (mplain[16] << 8) | (mplain[17] << 16)));
        var keepPlain = LineFixture.CreateKeep(_dataFolder);
        using (var kc = LineFixture.Open(keepPlain))
            LineFixture.Keep(kc, "k1", 1_760_000_000_000, "My note", "TEXT");
        SqliteConnection.ClearAllPools();
        var kplain = File.ReadAllBytes(keepPlain);
        File.WriteAllBytes(keepPlain, LineWxCipher.Encrypt(kplain, LineWxCipher.DeriveKey(key), (kplain[16] << 8) | (kplain[17] << 16)));

        var line = new LineDesktopCollector(_env.Context, new LineSettings(),
            roots: new[] { new LineProbeRoot("test", _dataFolder) },
            reportDir: _dir.Sub("rk2"), tempRoot: _dir.Sub("tk2"),
            keyStore: new InMemoryLineKeyStore(key));
        await line.StartAsync(default);
        await line.TickAsync(default);
        _env.Time.Advance(TimeSpan.FromSeconds(5));
        await line.TickAsync(default);

        Assert.Single(Batches(), b => b.Root.GetProperty("convKey").GetString() == "keep");
        Assert.Single(_env.Sink.Of(Kind.LineAccount));
    }

    // ---- WAL: rows LINE has committed to the -wal file but not yet checkpointed into the main file ----

    private const long T0 = 1_760_000_000_000;

    private static void MainRows(SqliteConnection c)
    {
        LineFixture.Chat(c, "c1");
        LineFixture.Message(c, "m0", "c1", "uA", T0, "in the main file");
    }

    private static List<string> MessageIds(IReadOnlyList<CapturedRecord> batches) =>
        batches.SelectMany(b => b.Root.GetProperty("messages").EnumerateArray())
            .Select(m => m.GetProperty("msgId").GetString()!).OrderBy(s => s, StringComparer.Ordinal).ToList();

    /// <summary>Write the encrypted main file and the (already encrypted) WAL over the collector's store.</summary>
    private void PlaceEncrypted(byte[] plainMain, byte[] encryptedWal, int pageSize)
    {
        SqliteConnection.ClearAllPools();
        File.WriteAllBytes(_dbPath, LineWxCipher.Encrypt(plainMain, LineWxCipher.DeriveKey(LineKey), pageSize));
        File.WriteAllBytes(_dbPath + "-wal", encryptedWal);
    }

    private async Task<List<string>> RunKeyed(string tag)
    {
        var line = new LineDesktopCollector(_env.Context, new LineSettings(),
            roots: new[] { new LineProbeRoot("test", _dataFolder) },
            reportDir: _dir.Sub("rep-" + tag), tempRoot: _dir.Sub("tmp-" + tag),
            keyStore: new InMemoryLineKeyStore(LineKey));
        await line.StartAsync(default);
        await line.TickAsync(default);
        Assert.Equal(LineState.OkPartial, line.State);
        return MessageIds(Batches());
    }

    [Fact]
    public async Task Encrypted_store_reads_committed_rows_that_exist_only_in_the_wal()
    {
        using var store = LineWalStore.Create(_dir.Sub("live1"), MainRows);
        LineFixture.Message(store.Writer, "m1", "c1", "uA", T0 + 1000, "wal one");
        LineFixture.Chat(store.Writer, "c2");                        // a chat that exists only in the WAL
        LineFixture.Message(store.Writer, "m2", "c2", "uB", T0 + 2000, "wal two");
        LineFixture.Message(store.Writer, "m3", "c2", "uB", T0 + 3000, "wal three");

        // The main file on its own holds only the pre-WAL row.
        Assert.Equal(new[] { "m0" }, store.MainOnlyMessageIds(_dir.Sub("mainonly1")));

        var (main, wal) = store.ReadFiles();
        Assert.True(LineWalBytes.ValidFrameCount(wal, store.PageSize) > 0);
        LineWalBytes.EncryptFrames(wal, store.PageSize, LineWxCipher.DeriveKey(LineKey));
        PlaceEncrypted(main, wal, store.PageSize);

        Assert.Equal(new[] { "m0", "m1", "m2", "m3" }, await RunKeyed("w1"));
        Assert.Equal(new[] { "c1", "c2" },
            Batches().Select(b => b.Root.GetProperty("convKey").GetString()).OrderBy(s => s, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public async Task Encrypted_store_ignores_a_trailing_wal_transaction_without_a_commit_frame()
    {
        using var store = LineWalStore.Create(_dir.Sub("live2"), MainRows);
        LineFixture.Message(store.Writer, "m1", "c1", "uA", T0 + 1000, "committed one");
        LineFixture.Message(store.Writer, "m2", "c1", "uA", T0 + 2000, "committed two");
        var framesBefore = store.FrameCount;
        LineFixture.Message(store.Writer, "m3", "c1", "uA", T0 + 3000, "half written");
        var framesAfter = store.FrameCount;
        Assert.True(framesAfter > framesBefore);

        var (main, wal) = store.ReadFiles();
        var ps = store.PageSize;
        LineWalBytes.EncryptFrames(wal, ps, LineWxCipher.DeriveKey(LineKey));
        var last = framesAfter - 1;
        Assert.NotEqual(0u, LineWalBytes.CommitSize(wal, last, ps));
        // Turn m3's transaction into an unfinished one: its final frame loses its commit marker, but salts and
        // checksum stay valid, so only the missing commit makes the reader drop it.
        LineWalBytes.SetCommitSize(wal, last, ps, 0);
        LineWalBytes.Rechain(wal, ps, last);
        for (var i = framesBefore; i < framesAfter; i++) Assert.Equal(0u, LineWalBytes.CommitSize(wal, i, ps));
        Assert.NotEqual(0u, LineWalBytes.CommitSize(wal, framesBefore - 1, ps));
        PlaceEncrypted(main, wal, ps);

        Assert.Equal(new[] { "m0", "m1", "m2" }, await RunKeyed("w2"));
    }

    [Fact]
    public async Task Encrypted_store_stops_reading_the_wal_at_a_frame_with_a_bad_checksum()
    {
        using var store = LineWalStore.Create(_dir.Sub("live3"), MainRows);
        LineFixture.Message(store.Writer, "m1", "c1", "uA", T0 + 1000, "one");
        LineFixture.Message(store.Writer, "m2", "c1", "uA", T0 + 2000, "two");
        var firstFrameOfM3 = store.FrameCount;
        LineFixture.Message(store.Writer, "m3", "c1", "uA", T0 + 3000, "three");
        LineFixture.Message(store.Writer, "m4", "c1", "uA", T0 + 4000, "four");
        Assert.True(store.FrameCount > firstFrameOfM3 + 1); // frames exist after the one we break

        var (main, wal) = store.ReadFiles();
        var ps = store.PageSize;
        LineWalBytes.EncryptFrames(wal, ps, LineWxCipher.DeriveKey(LineKey));
        wal[LineWalBytes.FrameOffset(firstFrameOfM3, ps) + LineWalBytes.FrameHeaderSize + 100] ^= 0x01; // checksum not updated
        PlaceEncrypted(main, wal, ps);

        Assert.Equal(new[] { "m0", "m1", "m2" }, await RunKeyed("w3"));
    }

    [Fact]
    public async Task Plain_store_reads_committed_rows_that_exist_only_in_the_wal()
    {
        using var store = LineWalStore.Create(_dir.Sub("live4"), MainRows);
        LineFixture.Message(store.Writer, "m1", "c1", "uA", T0 + 1000, "wal one");
        LineFixture.Chat(store.Writer, "c2");
        LineFixture.Message(store.Writer, "m2", "c2", "uB", T0 + 2000, "wal two");
        Assert.Equal(new[] { "m0" }, store.MainOnlyMessageIds(_dir.Sub("mainonly4")));

        SqliteConnection.ClearAllPools();
        store.CopyTo(_dbPath); // db, -wal and -shm, unencrypted

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.OkPartial, line.State);
        Assert.Equal(new[] { "m0", "m1", "m2" }, MessageIds(Batches()));
    }

    private static int CountMessages(IReadOnlyList<CapturedRecord> batches) =>
        batches.Sum(b => b.Root.GetProperty("messages").GetArrayLength());
}

/// <summary>
/// Two LINE accounts used in turn on one PC: LINE keeps one store per account (<c>qw&lt;hex&gt;.edb</c>), the
/// logged-in one marked by its <c>-wal</c> sidecar. Records carry that account's own mid, and cursors, the
/// account-snapshot hash and Keep are kept per account.
/// </summary>
public class LineMultiAccountTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly string _dataFolder;
    private static readonly byte[] Key = System.Text.Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");

    public LineMultiAccountTests()
    {
        _env = new TestEnv(_dir);
        _dataFolder = _dir.Sub("LINE", "Data", "db");
    }

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private LineDesktopCollector NewCollector(LineSettings? settings = null, ILineKeyStore? keyStore = null, CollectorContext? ctx = null) =>
        new(ctx ?? _env.Context, settings ?? new LineSettings(),
            roots: new[] { new LineProbeRoot("test", _dataFolder) },
            reportDir: _dir.Sub("report"),
            tempRoot: _dir.Sub("line-tmp"),
            keyStore: keyStore);

    private string Store(string name, Action<SqliteConnection> seed)
    {
        var path = LineFixture.Create(_dataFolder, name);
        Seed(path, seed);
        return path;
    }

    private static void Seed(string path, Action<SqliteConnection> seed)
    {
        using (var c = LineFixture.Open(path)) seed(c);
        SqliteConnection.ClearAllPools();
    }

    private static void EncryptInPlace(string path)
    {
        SqliteConnection.ClearAllPools();
        var plain = File.ReadAllBytes(path);
        File.WriteAllBytes(path, LineWxCipher.Encrypt(plain, LineWxCipher.DeriveKey(Key), (plain[16] << 8) | (plain[17] << 16)));
    }

    // Mark which store is the logged-in one, the way LINE does: only that store has a -wal beside it.
    private static void MakeActive(string active, params string[] others)
    {
        File.WriteAllBytes(active + "-wal", Array.Empty<byte>());
        foreach (var o in others) if (File.Exists(o + "-wal")) File.Delete(o + "-wal");
    }

    private IReadOnlyList<CapturedRecord> Batches() => _env.Sink.Of(Kind.MessageBatch);

    private static string Account(CapturedRecord r) => r.Root.GetProperty("account").GetString()!;

    private static List<string> MessageIds(IEnumerable<CapturedRecord> batches) =>
        batches.SelectMany(b => b.Root.GetProperty("messages").EnumerateArray())
            .Select(m => m.GetProperty("msgId").GetString()!).OrderBy(s => s, StringComparer.Ordinal).ToList();

    // An encrypted chat store with an own profile and a Keep store named after it, as LINE lays them out.
    private void EncryptedStoreWithKeep(string storeName, string ownMid)
    {
        var store = Store(storeName, c =>
        {
            LineFixture.OwnProfile(c, ownMid, "Me");
            LineFixture.Chat(c, "uX");
            LineFixture.Message(c, "m1", "uX", "uX", 1_760_000_000_000, "hi");
        });
        EncryptInPlace(store);
        var keep = LineFixture.CreateKeep(_dataFolder, "keep_" + Path.GetFileNameWithoutExtension(storeName) + ".edb");
        Seed(keep, kc => LineFixture.Keep(kc, "k1", 1_760_000_000_000, "My note", "TEXT"));
        EncryptInPlace(keep);
    }

    [Fact]
    public async Task Batches_keep_and_account_records_carry_the_own_profile_mid_as_account()
    {
        EncryptedStoreWithKeep("qwaaa.edb", "uME");

        var line = NewCollector(keyStore: new InMemoryLineKeyStore(Key));
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal(LineState.OkPartial, line.State);
        Assert.Equal("uME", line.CurrentAccount);
        Assert.Contains("uME", line.Detail);
        var batches = Batches();
        Assert.Contains(batches, b => b.Root.GetProperty("convKey").GetString() == "keep");
        Assert.Contains(batches, b => b.Root.GetProperty("convKey").GetString() == "uX");
        Assert.All(batches, b => Assert.Equal("uME", Account(b)));
        Assert.Equal("uME", Account(_env.Sink.Of(Kind.LineAccount).Single()));
    }

    [Fact]
    public async Task An_explicit_account_setting_overrides_the_mid()
    {
        EncryptedStoreWithKeep("qwaaa.edb", "uME");

        var line = NewCollector(new LineSettings { Account = "work" }, new InMemoryLineKeyStore(Key));
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal("work", line.CurrentAccount);
        Assert.Contains(Batches(), b => b.Root.GetProperty("convKey").GetString() == "keep");
        Assert.All(Batches(), b => Assert.Equal("work", Account(b)));
        Assert.Equal("work", Account(_env.Sink.Of(Kind.LineAccount).Single()));
        // Cursors are still kept per store (by its mid), not under the label.
        Assert.NotNull(_env.Context.Settings.LoadJson(CollectorNames.Line, "cursors:uME"));
    }

    [Fact]
    public async Task Without_a_readable_mid_the_store_file_name_is_the_account()
    {
        Store("qwfeed.edb", c => { LineFixture.Chat(c, "uX"); LineFixture.Message(c, "m1", "uX", "uX", 1_760_000_000_000, "hi"); });

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Equal("qwfeed", line.CurrentAccount);
        Assert.Equal("qwfeed", Account(Batches().Single()));
    }

    [Fact]
    public async Task Switching_the_active_store_changes_the_account_and_uses_its_own_cursors()
    {
        // Both accounts have a chat with the same id, so a shared cursor would hide account B's message.
        var a = Store("qwaaa.edb", c =>
        {
            LineFixture.OwnProfile(c, "uA", "Work me");
            LineFixture.Chat(c, "uSAME");
            LineFixture.Message(c, "a1", "uSAME", "uSAME", 1_760_000_000_000, "work one");
            LineFixture.Message(c, "a2", "uSAME", "uSAME", 1_760_000_100_000, "work two");
        });
        var b = Store("qwbbb.edb", c =>
        {
            LineFixture.OwnProfile(c, "uB", "Personal me");
            LineFixture.Chat(c, "uSAME");
            LineFixture.Message(c, "b1", "uSAME", "uSAME", 1_760_000_000_000, "personal one");
        });

        MakeActive(a, b);
        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);
        Assert.Equal("uA", line.CurrentAccount);
        Assert.Equal(new[] { "a1", "a2" }, MessageIds(Batches()));
        Assert.All(Batches(), r => Assert.Equal("uA", Account(r)));
        Assert.Equal("uA", Account(_env.Sink.Of(Kind.LineAccount).Single()));

        // Log in with the other account: B is read from its own start, under its own mid.
        _env.Sink.Clear();
        Seed(a, c => LineFixture.Message(c, "a3", "uSAME", "uSAME", 1_760_000_200_000, "work three"));
        MakeActive(b, a);
        await line.TickAsync(default);
        Assert.Equal("uB", line.CurrentAccount);
        Assert.Contains("uB", line.Detail);
        Assert.Equal(new[] { "b1" }, MessageIds(Batches()));
        Assert.All(Batches(), r => Assert.Equal("uB", Account(r)));
        Assert.Equal("uB", Account(_env.Sink.Of(Kind.LineAccount).Single()));
        Assert.Contains(_env.Activity.Recent(), e => e.Event == CollectorActivity.Config && e.Detail != null && e.Detail.Contains("uA -> uB"));

        // Back to the first account: its own cursors are reused, so only the new message goes out.
        _env.Sink.Clear();
        MakeActive(a, b);
        await line.TickAsync(default);
        Assert.Equal("uA", line.CurrentAccount);
        Assert.Equal(new[] { "a3" }, MessageIds(Batches()));
        Assert.All(Batches(), r => Assert.Equal("uA", Account(r)));
        Assert.Empty(_env.Sink.Of(Kind.LineAccount));   // A's snapshot is unchanged since it was last sent

        var ca = (System.Text.Json.Nodes.JsonObject)_env.Context.Settings.LoadJson(CollectorNames.Line, "cursors:uA")!;
        var cb = (System.Text.Json.Nodes.JsonObject)_env.Context.Settings.LoadJson(CollectorNames.Line, "cursors:uB")!;
        Assert.Equal(3, (long)ca["uSAME"]!);
        Assert.Equal(1, (long)cb["uSAME"]!);
    }

    [Fact]
    public async Task A_resync_while_one_account_is_open_also_rereads_the_other_when_it_returns()
    {
        var a = Store("qwaaa.edb", c => { LineFixture.OwnProfile(c, "uA", "A"); LineFixture.Chat(c, "c1"); LineFixture.Message(c, "a1", "c1", "c1", 1_760_000_000_000, "x"); });
        var b = Store("qwbbb.edb", c => { LineFixture.OwnProfile(c, "uB", "B"); LineFixture.Chat(c, "c2"); LineFixture.Message(c, "b1", "c2", "c2", 1_760_000_000_000, "y"); });
        var line = NewCollector();
        await line.StartAsync(default);
        MakeActive(a, b); await line.TickAsync(default);
        MakeActive(b, a); await line.TickAsync(default);
        MakeActive(a, b); await line.TickAsync(default);

        _env.Sink.Clear();
        line.RequestResync();
        await line.TickAsync(default);                       // applied to A, which is open
        Assert.Equal(new[] { "a1" }, MessageIds(Batches()));

        _env.Sink.Clear();
        MakeActive(b, a);
        await line.TickAsync(default);                       // B re-reads from the start when it is next open
        Assert.Equal(new[] { "b1" }, MessageIds(Batches()));

        _env.Sink.Clear();
        await line.TickAsync(default);                       // and only once
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task AccountKeyV1_resends_once_under_the_mid_and_moves_the_legacy_cursors()
    {
        var store = Store("qwaaa.edb", c =>
        {
            LineFixture.OwnProfile(c, "uME", "Me");
            LineFixture.Chat(c, "uBOB");
            LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "one");
            LineFixture.Message(c, "m2", "uBOB", "uBOB", 1_760_000_100_000, "two");
        });
        // An install from before accounts were told apart: one cursors blob covering everything, names already done.
        _env.Context.Settings.SaveJson(CollectorNames.Line, "cursors", new System.Text.Json.Nodes.JsonObject { ["uBOB"] = 1_000_000 });
        _env.Context.Settings.SaveJson(CollectorNames.Line, "namesV2", System.Text.Json.Nodes.JsonValue.Create(true));

        var line = NewCollector();
        await line.StartAsync(default);
        Assert.Null(_env.Context.Settings.LoadJson(CollectorNames.Line, "accountKeyV1"));   // not applied before a tick
        await line.TickAsync(default);

        Assert.NotNull(_env.Context.Settings.LoadJson(CollectorNames.Line, "accountKeyV1"));
        Assert.Equal(new[] { "m1", "m2" }, MessageIds(Batches()));                      // every chat re-sent
        Assert.All(Batches(), b => Assert.Equal("uME", Account(b)));                    // under the mid
        Assert.Null(_env.Context.Settings.LoadJson(CollectorNames.Line, "cursors"));    // legacy blob gone
        var moved = (System.Text.Json.Nodes.JsonObject)_env.Context.Settings.LoadJson(CollectorNames.Line, "cursors:uME")!;
        Assert.Equal(2, (long)moved["uBOB"]!);

        _env.Sink.Clear();
        var restarted = NewCollector(ctx: _env.Restart());
        await restarted.StartAsync(default);
        await restarted.TickAsync(default);
        Assert.Empty(Batches());                                                        // only once
        Assert.True(File.Exists(store));
    }

    [Fact]
    public async Task Legacy_cursors_move_to_the_open_account_without_a_resend_once_the_flag_is_set()
    {
        Store("qwaaa.edb", c =>
        {
            LineFixture.OwnProfile(c, "uME", "Me");
            LineFixture.Chat(c, "uBOB");
            LineFixture.Message(c, "m1", "uBOB", "uBOB", 1_760_000_000_000, "one");
        });
        _env.Context.Settings.SaveJson(CollectorNames.Line, "cursors", new System.Text.Json.Nodes.JsonObject { ["uBOB"] = 1_000_000 });
        _env.Context.Settings.SaveJson(CollectorNames.Line, "namesV2", System.Text.Json.Nodes.JsonValue.Create(true));
        _env.Context.Settings.SaveJson(CollectorNames.Line, "accountKeyV1", System.Text.Json.Nodes.JsonValue.Create(true));
        _env.Context.Settings.SaveJson(CollectorNames.Line, "callsV1", System.Text.Json.Nodes.JsonValue.Create(true));

        var line = NewCollector();
        await line.StartAsync(default);
        await line.TickAsync(default);

        Assert.Empty(Batches());
        Assert.Null(_env.Context.Settings.LoadJson(CollectorNames.Line, "cursors"));
        var moved = (System.Text.Json.Nodes.JsonObject)_env.Context.Settings.LoadJson(CollectorNames.Line, "cursors:uME")!;
        Assert.Equal(1_000_000, (long)moved["uBOB"]!);
    }

    [Fact]
    public void Keep_db_selection_follows_the_open_chat_store()
    {
        var a = LineFixture.Create(_dataFolder, "qwaaa.edb");
        var b = LineFixture.Create(_dataFolder, "qwbbb.edb");
        var keepA = LineFixture.CreateKeep(_dataFolder, "keep_qwaaa.edb");   // sorts first
        var keepB = LineFixture.CreateKeep(_dataFolder, "keep_qwbbb.edb");
        SqliteConnection.ClearAllPools();
        File.WriteAllBytes(keepB + "-wal", new byte[1_000_000]);            // a sidecar is never picked

        Assert.Equal(keepA, LineKeep.FindKeepDb(_dataFolder, a));
        Assert.Equal(keepB, LineKeep.FindKeepDb(_dataFolder, b));
        // Several Keep stores and none named after the chat store: none is guessed.
        Assert.Null(LineKeep.FindKeepDb(_dataFolder, Path.Combine(_dataFolder, "qwccc.edb")));
        Assert.Null(LineKeep.FindKeepDb(_dataFolder));

        // A single Keep store is used even if its name does not match (one account, other naming).
        var solo = _dir.Sub("solo");
        var chat = LineFixture.Create(solo, "chat.edb");
        var keep = LineFixture.CreateKeep(solo, "keep_abc.edb");
        SqliteConnection.ClearAllPools();
        Assert.Equal(keep, LineKeep.FindKeepDb(solo, chat));
    }

    [Fact]
    public async Task Keep_for_the_second_account_is_read_from_its_own_keep_store()
    {
        EncryptedStoreWithKeep("qwaaa.edb", "uA");
        EncryptedStoreWithKeep("qwbbb.edb", "uB");
        var a = Path.Combine(_dataFolder, "qwaaa.edb");
        var b = Path.Combine(_dataFolder, "qwbbb.edb");
        // Give B's Keep a different item so the two are told apart.
        var keepB = Path.Combine(_dataFolder, "keep_qwbbb.edb");
        File.Delete(keepB);
        LineFixture.CreateKeep(_dataFolder, "keep_qwbbb.edb");
        Seed(keepB, kc => LineFixture.Keep(kc, "kB", 1_760_000_000_000, "Personal note", "TEXT"));
        EncryptInPlace(keepB);

        var line = NewCollector(keyStore: new InMemoryLineKeyStore(Key));
        await line.StartAsync(default);
        MakeActive(b, a);
        await line.TickAsync(default);

        var keep = Batches().Single(r => r.Root.GetProperty("convKey").GetString() == "keep");
        Assert.Equal("uB", Account(keep));
        Assert.Equal(new[] { "kB" }, MessageIds(new[] { keep }));
    }
}

/// <summary><see cref="LineWal.ReadCommitted"/> on hand-built WAL bytes.</summary>
public class LineWalReadCommittedTests
{
    private const int Ps = 1024;

    private static byte[] CommittedWal()
    {
        var wal = LineWalBytes.Header(Ps);
        wal = LineWalBytes.AppendFrame(wal, Ps, pageNumber: 2, commitSize: 0);
        return LineWalBytes.AppendFrame(wal, Ps, pageNumber: 3, commitSize: 3);
    }

    [Fact]
    public void A_valid_hand_built_wal_returns_its_committed_pages()
    {
        var r = LineWal.ReadCommitted(CommittedWal(), Ps);
        Assert.NotNull(r);
        Assert.Equal(3u, r!.DbSizePages);
        Assert.Equal(LineWalBytes.FrameOffset(0, Ps) + LineWalBytes.FrameHeaderSize, r.PageOffsets[2]);
        Assert.Equal(LineWalBytes.FrameOffset(1, Ps) + LineWalBytes.FrameHeaderSize, r.PageOffsets[3]);
    }

    [Fact]
    public void Wrong_magic_returns_null()
    {
        var wal = CommittedWal();
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(wal, 0x12345678);
        Assert.Null(LineWal.ReadCommitted(wal, Ps));
    }

    [Fact]
    public void Page_size_other_than_the_store_returns_null()
    {
        Assert.Null(LineWal.ReadCommitted(CommittedWal(), Ps * 2));
        var otherSize = LineWalBytes.AppendFrame(LineWalBytes.Header(Ps * 2), Ps * 2, pageNumber: 2, commitSize: 2);
        Assert.Null(LineWal.ReadCommitted(otherSize, Ps));
    }

    [Fact]
    public void A_wal_with_no_commit_frame_returns_null()
    {
        var wal = LineWalBytes.Header(Ps);
        wal = LineWalBytes.AppendFrame(wal, Ps, pageNumber: 2, commitSize: 0);
        wal = LineWalBytes.AppendFrame(wal, Ps, pageNumber: 3, commitSize: 0);
        Assert.Null(LineWal.ReadCommitted(wal, Ps));
        Assert.Null(LineWal.ReadCommitted(LineWalBytes.Header(Ps), Ps)); // header only, no frames
    }
}

/// <summary><see cref="LineCalls"/>: LINE's content-type-6 call record metadata to the protocol call object.</summary>
public class LineCallsTests
{
    [Fact]
    public void Completed_video_call_with_duration()
    {
        var c = LineCalls.FromContentMetadata(6, """{"TYPE":"V","RESULT":"NORMAL","CAUSE":"16","VERSION":"M","DURATION":"31649000"}""", false)!;
        Assert.Equal("video", c.Kind);
        Assert.Equal("completed", c.Outcome);
        Assert.Equal(31649, c.DurationSec);
        Assert.Equal("incoming", c.Direction);
        Assert.Equal(155, LineCalls.FromContentMetadata(6, """{"TYPE":"V","RESULT":"NORMAL","DURATION":154500}""", true)!.DurationSec); // numeric, rounds half up
    }

    [Fact]
    public void Missed_audio_call_has_no_duration()
    {
        var c = LineCalls.FromContentMetadata(6, """{"TYPE":"A","RESULT":"NO_RESPONSE","CAUSE":"18","DURATION":"0"}""", false)!;
        Assert.Equal(("audio", "missed", (long?)null, "incoming"), (c.Kind, c.Outcome, c.DurationSec, c.Direction));
        Assert.Equal("declined", LineCalls.FromContentMetadata(6, """{"TYPE":"A","RESULT":"REJECTED","DURATION":"0"}""", false)!.Outcome);
    }

    [Fact]
    public void Cancelled_outgoing_call()
    {
        var c = LineCalls.FromContentMetadata(6, """{"TYPE":"V","RESULT":"CANCELED","CAUSE":"77","DURATION":"0"}""", true)!;
        Assert.Equal(("video", "cancelled", (long?)null, "outgoing"), (c.Kind, c.Outcome, c.DurationSec, c.Direction));
    }

    [Fact]
    public void Unknown_codes_become_unknown()
    {
        var c = LineCalls.FromContentMetadata(6, """{"TYPE":"X","RESULT":"BUSY","DURATION":"5000"}""", null)!;
        Assert.Equal(("unknown", "unknown", (long?)null, (string?)null), (c.Kind, c.Outcome, c.DurationSec, c.Direction));
        var empty = LineCalls.FromContentMetadata(6, "{}", null)!;
        Assert.Equal(("unknown", "unknown"), (empty.Kind, empty.Outcome));
    }

    [Fact]
    public void Malformed_or_missing_metadata_gives_no_call_but_the_kind_stays_call()
    {
        Assert.Null(LineCalls.FromContentMetadata(6, "{not json", true));
        Assert.Null(LineCalls.FromContentMetadata(6, "[1,2]", true));
        Assert.Null(LineCalls.FromContentMetadata(6, null, true));
        Assert.Equal("call", LineStoreMap.MediaKindFor(6));
    }

    [Fact]
    public void Other_content_types_are_not_calls()
    {
        Assert.Null(LineCalls.FromContentMetadata(0, """{"TYPE":"V","RESULT":"NORMAL"}""", true));
        Assert.Null(LineCalls.FromContentMetadata(17, """{"SPEC_REV":"1"}""", true));
        Assert.Null(LineCalls.FromContentMetadata(null, """{"TYPE":"V"}""", true));
    }
}
