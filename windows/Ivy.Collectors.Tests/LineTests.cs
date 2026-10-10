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
            CREATE TABLE _contact (_mid TEXT PRIMARY KEY, _displayName TEXT, _displayNameOverridden TEXT, _type INTEGER);
            CREATE TABLE _groupChat (_chatMid TEXT PRIMARY KEY, _chatName TEXT);
            """);
        return path;
    }

    public static SqliteConnection Open(string path) =>
        OpenRaw(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());

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

    private static int CountMessages(IReadOnlyList<CapturedRecord> batches) =>
        batches.Sum(b => b.Root.GetProperty("messages").GetArrayLength());
}
