using System.Text.Json.Nodes;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Collectors.Files;
using Ivy.Collectors.Host;
using Ivy.Collectors.Line;
using Ivy.Collectors.Notifications;
using Ivy.Collectors.Screenshots;
using Ivy.Collectors.Telegram;
using Ivy.Collectors.Tests.Support;
using Ivy.Collectors.Usage;
using Ivy.Core.Storage;

namespace Ivy.Collectors.Tests;

/// <summary>
/// ClearProgressAsync (re-pairing after an unpair): capture progress kept in agent_settings and the collectors'
/// own tables is forgotten, user settings written alongside it are kept.
/// </summary>
public class ClearProgressTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;

    public ClearProgressTests() => _env = new TestEnv(_dir);

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private string? Raw(string collector, string key) => _env.Db.GetSetting(CollectorSettingsStore.Key(collector, key));

    private void Put(string collector, string key) => _env.Context.Settings.SaveJson(collector, key, JsonValue.Create("x"));

    private void Exec(string sql)
    {
        using var c = _env.Db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private long Rows(string table)
    {
        using var c = _env.Db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM " + table;
        return (long)cmd.ExecuteScalar()!;
    }

    private void AssertGone(string collector, params string[] keys)
    {
        foreach (var k in keys) Assert.Null(Raw(collector, k));
    }

    private void AssertKept(string collector, params string[] keys)
    {
        foreach (var k in keys) Assert.NotNull(Raw(collector, k));
    }

    private static INotificationDbReader MissingReader(NotificationSettings s, TempDir dir) =>
        new WpnDatabaseReader(s.DatabasePath ?? dir.Sub("missing", "wpndatabase.db"), dir.Sub("wpn"));

    [Fact]
    public async Task Telegram_clears_diff_state_and_chat_cursors_and_keeps_settings()
    {
        var c = new TelegramCollector(_env.Context);
        Put("telegram", "diffState");
        _env.Context.Settings.SaveSettings("telegram", new JsonObject { ["includeChannels"] = true });
        Exec("INSERT INTO tg_chat_state(conv_key, account, conv_kind, newest_seen_id) VALUES ('tg:1', 'a', 'dm', 99)");
        Exec("INSERT INTO tg_attachments(att_ref, conv_key, msg_id, kind, filename, size, blob_oid, status) VALUES ('r', 'tg:1', 5, 'doc', 'f', 1, 'oid', 'uploaded')");

        await c.ClearProgressAsync();

        AssertGone("telegram", "diffState");
        AssertKept("telegram", "settings");
        Assert.Equal(0, Rows("tg_chat_state"));
        Assert.Equal(0, Rows("tg_attachments"));
    }

    [Fact]
    public async Task Screenshots_clears_baseline_and_seen_tables_and_keeps_settings()
    {
        var c = new ScreenshotCollector(_env.Context);
        Put("screenshots", "baseline");
        _env.Context.Settings.SaveSettings("screenshots", new JsonObject { ["uploadExisting"] = false });
        Exec("INSERT INTO screenshot_seen(sha256, blob_oid, first_path, captured_at) VALUES ('h', 'o', 'p', 't')");
        Exec("INSERT INTO screenshot_files(path, size, mtime, sha256) VALUES ('p', 1, 't', 'h')");

        await c.ClearProgressAsync();

        AssertGone("screenshots", "baseline");
        AssertKept("screenshots", "settings");
        Assert.Equal(0, Rows("screenshot_seen"));
        Assert.Equal(0, Rows("screenshot_files"));
    }

    [Fact]
    public async Task Line_clears_every_account_cursor_and_keeps_settings_and_migration_flags()
    {
        var c = new LineDesktopCollector(_env.Context);
        string[] progress = { "cursors", "accountHash", "resyncEpoch", "lastCaptured",
            "cursors:u1", "cursors:qw2", "listings:u1", "accountHash:u1", "resyncEpoch:u1", "resyncEpoch:qw2" };
        foreach (var k in progress) Put("line", k);
        string[] kept = { "settings", "lastStore", "accountKeyV1", "namesV2", "callsV1", "pollMigratedV1" };
        foreach (var k in kept) Put("line", k);
        Put("telegram", "cursors:u1");   // another collector's rows are never touched

        await c.ClearProgressAsync();

        AssertGone("line", progress);
        AssertKept("line", kept);
        AssertKept("telegram", "cursors:u1");
    }

    [Fact]
    public async Task Usage_clears_the_open_interval_and_keeps_settings()
    {
        var c = new UsageCollector(_env.Context, probe: null);
        Put("usage", "open");
        _env.Context.Settings.SaveSettings("usage", new JsonObject { ["captureTitles"] = true });

        await c.ClearProgressAsync();

        AssertGone("usage", "open");
        AssertKept("usage", "settings");
        Assert.Null(c.Current);
    }

    [Fact]
    public async Task Files_clears_scan_state_and_dedupe_tables_and_keeps_settings()
    {
        var c = new FileIndexCollector(_env.Context);
        Put("files", "scan");
        Put("files", "lastFullScan");
        Put("files", "autoScoped");
        _env.Context.Settings.SaveSettings("files", new JsonObject { ["roots"] = new JsonArray("C:/x") });
        Exec("INSERT INTO file_tombstones(path, deleted_at, reason) VALUES ('p', 't', 'deleted')");
        Exec("INSERT INTO file_thumbs(path, quick_hash, thumb_oid) VALUES ('p', 'h', 'o')");
        Exec("INSERT INTO file_originals(quick_hash, size, payload_kind, blob_oid, source_path, status, queued_at) VALUES ('h', 1, 'photo', 'o', 'p', 'uploaded', 't')");
        Exec("INSERT INTO file_original_links(path, quick_hash, blob_oid) VALUES ('p', 'h', 'o')");

        await c.ClearProgressAsync();

        AssertGone("files", "scan", "lastFullScan");
        AssertKept("files", "settings", "autoScoped");
        foreach (var t in new[] { "file_tombstones", "file_thumbs", "file_originals", "file_original_links" })
            Assert.Equal(0, Rows(t));
        Assert.Null(c.LastFullScan);
        Assert.Null(c.CurrentScan);
    }

    [Fact]
    public async Task Catalog_clears_scan_state_and_entries_and_keeps_settings()
    {
        var c = new FileCatalogCollector(_env.Context);
        Put("catalog", "scan");
        Put("catalog", "lastScanCompletedAt");
        Put("catalog", "lastScanScope");
        Put("catalog", "autoScoped");
        Put("catalog", "rebatchV1");
        _env.Context.Settings.SaveSettings("catalog", new JsonObject { ["roots"] = new JsonArray("C:/x") });
        Exec("INSERT INTO catalog_entry(path, size, mtime, scan_gen) VALUES ('p', 1, 't', 1)");

        await c.ClearProgressAsync();

        AssertGone("catalog", "scan", "lastScanCompletedAt", "lastScanScope");
        AssertKept("catalog", "settings", "autoScoped", "rebatchV1");
        Assert.Equal(0, Rows("catalog_entry"));
        Assert.Null(c.CurrentScan);
    }

    [Fact]
    public async Task Notifications_resets_the_in_memory_id_and_leaves_settings()
    {
        var c = new NotificationCollector(_env.Context, s => MissingReader(s, _dir));
        _env.Context.Settings.SaveSettings("notifications", new JsonObject { ["batchSize"] = 50 });
        _env.States.Register("notifications", enabled: true);
        _env.States.RecordRun("notifications", _env.Time.GetUtcNow(), "42");
        await c.StartAsync(default);
        Assert.Equal(42, c.LastId);

        await c.ClearProgressAsync();

        Assert.Equal(0, c.LastId);
        Assert.Null(c.Cursor);
        AssertKept("notifications", "settings");
    }

    // ---------------------------------------------------------------- host

    private sealed class ProbeCfg { }

    private sealed class Probe : Collector<ProbeCfg>
    {
        public int Cleared;
        private readonly bool _fail;
        public Probe(string name, CollectorContext ctx, bool fail = false) : base(name, ctx) => _fail = fail;
        public override TimeSpan Interval => TimeSpan.FromSeconds(60);
        public override Task TickAsync(CancellationToken ct) => Task.CompletedTask;
        public override Task ClearProgressAsync()
        {
            Cleared++;
            return _fail ? throw new InvalidOperationException("boom") : Task.CompletedTask;
        }
    }

    [Fact]
    public async Task Host_ClearProgress_reaches_every_collector_even_when_one_fails()
    {
        var a = new Probe("a", _env.Context);
        var bad = new Probe("b", _env.Context, fail: true);
        var c = new Probe("c", _env.Context);
        var host = new CollectorHost(_env.Context, new CollectorBase[] { a, bad, c });

        await host.ClearProgressAsync();

        Assert.Equal(1, a.Cleared);
        Assert.Equal(1, bad.Cleared);
        Assert.Equal(1, c.Cleared);
    }

    [Fact]
    public async Task Host_ClearProgress_reaches_the_default_collectors()
    {
        var host = CollectorHost.Create(_env.Context, new CollectorHostOptions
        {
            UsePlatformDefaults = false,
            Time = _env.Time,
            NotificationReader = s => MissingReader(s, _dir),
        });
        Put("telegram", "diffState");
        Put("screenshots", "baseline");
        Put("line", "cursors:u1");
        Put("usage", "open");
        Put("files", "scan");
        Put("catalog", "scan");

        await host.ClearProgressAsync();

        AssertGone("telegram", "diffState");
        AssertGone("screenshots", "baseline");
        AssertGone("line", "cursors:u1");
        AssertGone("usage", "open");
        AssertGone("files", "scan");
        AssertGone("catalog", "scan");
    }
}
