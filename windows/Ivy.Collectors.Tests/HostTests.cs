using System.Text;
using System.Text.Json;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Collectors.Files;
using Ivy.Collectors.Host;
using Ivy.Collectors.Notifications;
using Ivy.Collectors.Tests.Support;
using Ivy.Collectors.Usage;
using Ivy.Core.Agent;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;

namespace Ivy.Collectors.Tests;

public class HostTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly FakeProbe _probe = new();
    private readonly ManualChangeSource _changes = new();
    private readonly string _root;

    public HostTests()
    {
        _env = new TestEnv(_dir);
        _root = _dir.Sub("docs");
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private CollectorHost NewHost(CollectorContext? ctx = null) => CollectorHost.Create(ctx ?? _env.Context, new CollectorHostOptions
    {
        ChangeSources = _changes,
        ForegroundProbe = _probe,
        UsePlatformDefaults = false,
        NotificationReader = s => new WpnDatabaseReader(s.DatabasePath ?? _dir.Sub("missing", "wpndatabase.db"), _dir.Sub("wpn")),
        Time = _env.Time,
    });

    private static CommandRecord Command(CommandParams p) => new()
    {
        DeviceId = "dev-test",
        EventTime = "2026-10-10T00:00:00.000Z",
        CaptureTime = "2026-10-10T00:00:00.000Z",
        CommandId = Guid.NewGuid().ToString(),
        IssuedAt = "2026-10-10T00:00:00.000Z",
        Params = p,
    };

    private static Task<Ivy.Core.Commands.CommandOutcome> Config(CollectorHost h, CollectorConfigParams p) => h.HandleCollectorConfigAsync(Command(p), p, default);

    private static Task<Ivy.Core.Commands.CommandOutcome> Rescan(CollectorHost h, RescanParams p) => h.HandleRescanAsync(Command(p), p, default);

    private static Dictionary<string, JsonElement> Settings(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    private static async Task Eventually(Func<bool> cond, string what)
    {
        var until = DateTime.UtcNow.AddSeconds(10);
        while (!cond())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException(what);
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task Collector_config_command_applies_persists_and_survives_restart()
    {
        await using var host = NewHost();
        await host.StartAsync();
        Assert.Equal(CollectorNames.All.OrderBy(n => n), _env.States.All().Select(r => r.Name));

        var outcome = await Config(host, (new CollectorConfigParams
        {
            Collector = "files",
            Settings = Settings($$"""{"roots":[{{JsonSerializer.Serialize(_root)}}],"thumbnails":false,"FullRescanHours":12}"""),
        }));
        Assert.Equal(CommandStatusValues.Done, outcome.Status);
        var files = host.Get<FileIndexCollector>();
        Assert.Equal(new[] { _root }, files.Settings.Roots);
        Assert.False(files.Settings.Thumbnails);
        Assert.Equal(12, files.Settings.FullRescanHours);
        Assert.Contains(_root, _changes.Watched);              // restarted with the new folder (the screenshots collector shares this source and watches its default folder when it exists)
        Assert.NotNull(_env.Db.GetSetting("collector.files.settings"));

        // Invalid settings are rejected with a reason and change nothing.
        var bad = await Config(host, (new CollectorConfigParams { Collector = "files", Settings = Settings("""{"rootz":[]}""") }));
        Assert.Equal(CommandStatusValues.Error, bad.Status);
        var bad2 = await Config(host, (new CollectorConfigParams { Collector = "usage", Settings = Settings("""{"sampleSeconds":-1}""") }));
        Assert.Equal(CommandStatusValues.Error, bad2.Status);
        Assert.Contains("sampleSeconds", bad2.Detail);
        Assert.Equal(CommandStatusValues.Error, (await Config(host, (new CollectorConfigParams { Collector = "nope" }))).Status);
        Assert.Equal(new[] { _root }, files.Settings.Roots);

        // Disable usage by command.
        var off = await Config(host, (new CollectorConfigParams { Collector = "usage", Enabled = false }));
        Assert.Equal(CommandStatusValues.Done, off.Status);
        Assert.False(_env.States.Get("usage")!.Enabled);
        Assert.Equal(CollectorState.Disabled, host.Status("usage").State);
        await host.StopAsync();

        // A new host on the same database loads the persisted settings and the enabled flags.
        await using var host2 = NewHost(_env.Restart());
        await host2.StartAsync();
        Assert.Equal(new[] { _root }, host2.Get<FileIndexCollector>().Settings.Roots);
        Assert.False(host2.Get<FileIndexCollector>().Settings.Thumbnails);
        var usage = host2.Status("usage");
        Assert.False(usage.Enabled);
        Assert.False(usage.Running);
        Assert.Contains(_env.Activity.Recent(), e => e.Event == CollectorActivity.Config && e.Collector == "files");
    }

    [Fact]
    public async Task Rescan_command_is_routed_and_unsupported_ones_fail_honestly()
    {
        _dir.Write("docs/a.txt", "a");
        await using var host = NewHost();
        await host.StartAsync();
        Assert.Equal(CommandStatusValues.Error, (await Rescan(host, (new RescanParams { Collector = "files" }))).Status); // no folders yet
        await host.UpdateSettingsAsync("files", null, Settings($$"""{"roots":[{{JsonSerializer.Serialize(_root)}}]}"""));
        await host.TickNowAsync("files");
        Assert.Single(_env.Sink.Of(Kind.FileMeta));

        File.Delete(Path.Combine(_root, "a.txt"));
        _dir.Write("docs/b.txt", "b");
        var r = await Rescan(host, (new RescanParams { Collector = "files" }));
        Assert.Equal(CommandStatusValues.Done, r.Status);
        await host.TickNowAsync("files");
        var fileMetas = _env.Sink.Of(Kind.FileMeta);
        bool IsDeletion(CapturedRecord r) => r.Has("deleted") && r.Root.GetProperty("deleted").GetBoolean();
        Assert.Equal("b.txt", fileMetas.Last(r => !IsDeletion(r)).Str("name"));
        Assert.Equal("a.txt", Assert.Single(fileMetas.Where(IsDeletion)).Str("name")); // the removed file reaches the Mac as a deletion
        Assert.True(host.Get<FileIndexCollector>().IsTombstoned(Path.Combine(_root, "a.txt")));

        Assert.Equal(CommandStatusValues.Done, (await Rescan(host, (new RescanParams { Collector = "all" }))).Status);
        Assert.Equal(CommandStatusValues.Error, (await Rescan(host, (new RescanParams { Collector = "usage" }))).Status);
        Assert.Equal(CommandStatusValues.Error, (await Rescan(host, (new RescanParams { Collector = "bogus" }))).Status);
    }

    [Fact]
    public async Task Status_reflects_pairing_pause_errors_and_unsupported()
    {
        _env.Paired = false;
        await using var host = NewHost();
        await host.StartAsync();
        Assert.All(host.Statuses().Where(s => s.Name != "usage"), s => Assert.Equal(CollectorState.WaitingForPairing, s.State));
        _env.Paired = true;

        // Notifications: the database does not exist → Error with the reason, never "running fine".
        await host.TickNowAsync("notifications");
        var n = host.Status("notifications");
        Assert.Equal(CollectorState.Error, n.State);
        Assert.Contains("not found", n.LastError);

        _probe.Current = new ForegroundSample("Notepad", "notepad.exe", "todo.txt");
        await host.PauseAsync("usage");
        await host.TickNowAsync("usage");
        Assert.Equal(CollectorState.Paused, host.Status("usage").State);
        Assert.Null(host.Get<UsageCollector>().Current);
        host.Resume("usage");
        await host.TickNowAsync("usage");
        Assert.NotNull(host.Get<UsageCollector>().Current);
        var u = host.Status("usage");
        Assert.Equal(CollectorState.Running, u.State);
        Assert.NotNull(u.LastRunAt);
        Assert.NotNull(u.Cursor);

        // Unsupported (no probe on this platform).
        var ctx = _env.Restart();
        await using var bare = CollectorHost.Create(ctx, new CollectorHostOptions { UsePlatformDefaults = false, ChangeSources = _changes, Time = _env.Time });
        await bare.StartAsync();
        var s = bare.Status("usage");
        Assert.Equal(CollectorState.Unsupported, s.State);
        Assert.Contains("Windows", s.LastError);
        await bare.StopAsync();

        // The collector_state row carries lastRunAt and cursor for the device report.
        await host.StopAsync();
        var row = _env.States.Get("usage")!;
        Assert.NotNull(row.LastRunAt);
        Assert.Equal(u.Cursor, row.Cursor);
    }

    [Fact]
    public async Task Background_loop_samples_on_the_interval()
    {
        _probe.Current = new ForegroundSample("Notepad", "notepad.exe", "a");
        await using var host = NewHost();
        var changed = 0;
        host.StatusChanged += (_, _) => Interlocked.Increment(ref changed);
        await host.StartAsync();
        var usage = host.Get<UsageCollector>();
        await Eventually(() => usage.Current is not null, "first sample");
        _probe.Current = new ForegroundSample("Paint", "mspaint.exe", "b");
        await Eventually(() =>
        {
            _env.Time.Advance(TimeSpan.FromSeconds(30));
            return _env.Sink.Of(Kind.UsageEvent).Count > 0;
        }, "usage event after a switch");
        Assert.Equal("Notepad", _env.Sink.Of(Kind.UsageEvent)[0].Str("app"));
        Assert.True(changed > 0);
        await host.StopAsync();
        Assert.Equal(2, _env.Sink.Of(Kind.UsageEvent).Count);     // stop flushed the open Paint interval
    }

    [Fact]
    public async Task End_to_end_with_the_real_sink_queue_and_activity_log()
    {
        // Real RecordSink → UploadQueue: records are encrypted to the Mac key, counted per collector, logged.
        var (macSecret, macPublic) = X25519.GenerateKeyPair();
        var sink = new RecordSink(_env.Queue, macPublic, "dev-real", _env.Activity, time: _env.Time);
        var ctx = new CollectorContext(_env.Db, () => sink, _env.Activity, _env.States, _env.Queue, _env.Time);
        await using var host = CollectorHost.Create(ctx, new CollectorHostOptions { UsePlatformDefaults = false, ChangeSources = _changes, Time = _env.Time });
        await host.StartAsync();
        _dir.Write("docs/one.txt", "1");
        _dir.Write("docs/two.txt", "2");
        await host.UpdateSettingsAsync("files", null, Settings($$"""{"roots":[{{JsonSerializer.Serialize(_root)}}]}"""));
        await host.TickNowAsync("files");

        Assert.Equal(2, _env.Queue.DepthByCollector()["files"]);
        Assert.Equal(2, host.Status("files").QueueDepth);
        Assert.Equal(2, host.Status("files").CapturesThisSession);
        var item = _env.Queue.All().First(i => i.Collector == "files");
        var plain = Envelope.Decrypt(macSecret, item.ObjectKey, File.ReadAllBytes(_env.Queue.FullPathOf(item)), Kind.FileMeta).Plaintext;
        var json = Encoding.UTF8.GetString(plain);
        Schema.Validate(json);
        Assert.Contains("\"deviceId\":\"dev-real\"", json);

        var feed = _env.Activity.Recent().Where(e => e.Collector == "files").Select(e => e.Event).ToList();
        Assert.Contains(CollectorActivity.Captured, feed);
        Assert.Contains(ActivityEvents.Encrypted, feed);
        Assert.Contains(ActivityEvents.Queued, feed);
        // Activity details never carry content or paths.
        Assert.DoesNotContain(_env.Activity.Recent(), e => (e.Detail ?? "").Contains("one.txt", StringComparison.Ordinal));

        // Device report (Ivy.Core) sees the collector rows the host maintains.
        var report = new DeviceReporter(sink, _env.States, _env.Queue, time: _env.Time).Build();
        var filesRow = report.Collectors.Single(c => c.Name == "files");
        Assert.True(filesRow.Enabled);
        Assert.Equal(2, filesRow.QueueDepth);
        Assert.NotNull(filesRow.LastRunAt);
    }

    [Fact]
    public async Task CreateFor_attaches_to_the_vault_agent()
    {
        var keys = new Ivy.Core.KeyStore.FileKeyStore(_dir.Sub("keys"));
        await using var agent = new VaultAgent(new VaultAgentOptions { DataDirectory = _dir.Sub("agent") }, keys);
        await using var host = CollectorHost.CreateFor(agent, new CollectorHostOptions { UsePlatformDefaults = false, ChangeSources = _changes });
        Assert.Same(host, agent.RescanHandler);
        Assert.Same(host, agent.CollectorConfigHandler);
        await host.StartAsync();
        Assert.All(host.Statuses().Where(s => s.State != CollectorState.Unsupported), s => Assert.Equal(CollectorState.WaitingForPairing, s.State));
        await host.StopAsync();
    }
}
