using Ivy.App.Core.Hosting;
using Ivy.App.Core.ViewModels;
using Ivy.Core.Agent;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.Storage;
using Ivy.Core.Upload;

namespace Ivy.App.Core.Tests;

public class VaultAgentViewTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    private VaultAgent NewAgent(MemoryR2? r2 = null) =>
        new(new VaultAgentOptions { DataDirectory = Path.Combine(_dir.Path, "data") }, new FileKeyStore(Path.Combine(_dir.Path, "keys")), r2);

    [Fact]
    public async Task Unpaired_agent_reports_empty_state()
    {
        await using var agent = NewAgent();
        await agent.StartAsync();
        using var view = new VaultAgentView(agent);
        Assert.False(view.IsPaired);
        Assert.Null(view.DeviceFingerprint);
        Assert.False(view.UploadsPaused);
        Assert.Equal(0, view.BandwidthBytesPerSecond);
        view.UploadsPaused = true; // no uploader yet: ignored rather than throwing
        var s = view.Snapshot();
        Assert.Equal(0, s.PendingObjects);
        Assert.Null(s.LastUpPutAt);
        Assert.Null(s.LastCmdListAt);
        Assert.Null(s.UpError);
    }

    [Fact]
    public async Task Snapshot_aggregates_queue_and_activity()
    {
        await using var agent = NewAgent();
        await agent.StartAsync();
        using var view = new VaultAgentView(agent);
        agent.Queue.EnqueueCiphertext("up/meta/a", Kind.FileMeta, new byte[100], "files");
        agent.Queue.EnqueueCiphertext("up/meta/b", Kind.FileMeta, new byte[50], "files");
        agent.Queue.EnqueueCiphertext("up/usage/c", Kind.UsageEvent, new byte[7], "usage");
        agent.Queue.EnqueueCiphertext("up/status/d", Kind.DeviceReport, new byte[3]);
        var failed = agent.Queue.NextDue()!;
        agent.Queue.MarkUploading(failed.Id);
        agent.Queue.MarkFailed(failed.Id, "timeout");

        agent.Activity.Append("files", ActivityEvents.Queued, "up/meta/a");
        agent.Activity.Append("files", ActivityEvents.Uploaded, "up/meta/z 1 bytes");
        agent.Activity.Append("usage", ActivityEvents.Queued, "up/usage/c");
        var s = view.Snapshot();

        Assert.Equal(4, s.PendingObjects);
        Assert.Equal(160, s.PendingBytes);
        Assert.Equal(1, s.RetryingObjects);
        Assert.Equal(new QueueStats(2, 150, 1), s.For("files"));
        Assert.Equal(new QueueStats(1, 7, 0), s.For("usage"));
        Assert.Equal(new QueueStats(1, 3, 0), s.For(""));
        Assert.Equal(new QueueStats(0, 0, 0), s.For("notifications"));
        Assert.True(s.LastQueuedByCollector.ContainsKey("files"));
        Assert.True(s.LastQueuedByCollector.ContainsKey("usage"));
        Assert.True(s.LastUploadByCollector.ContainsKey("files"));
        Assert.NotNull(s.LastUpPutAt);
        Assert.Null(s.UpError);

        agent.Activity.Append("usage", ActivityEvents.UploadFailed, "up/usage/c attempt 1: timeout");
        s = view.Snapshot();
        Assert.Equal("up/usage/c attempt 1: timeout", s.UpError);
        Assert.NotNull(s.UpErrorAt);
        agent.Activity.Append("files", ActivityEvents.Uploaded, "up/meta/y 1 bytes");
        Assert.Null(view.Snapshot().UpError); // a later success clears it
    }

    [Fact]
    public async Task Activity_events_are_forwarded()
    {
        await using var agent = NewAgent();
        using var view = new VaultAgentView(agent);
        var seen = new List<ActivityEntry>();
        view.ActivityAppended += (_, e) => seen.Add(e);
        agent.Activity.Append(null, ActivityEvents.Reconciled, "x");
        Assert.Single(seen);
        Assert.Single(view.RecentActivity(10));
        view.SetSetting("k", "v");
        Assert.Equal("v", view.GetSetting("k"));
    }

    [Fact]
    public async Task End_to_end_pairing_through_the_view_models_then_sync_uploads()
    {
        var r2 = new MemoryR2();
        await using var agent = NewAgent(r2);
        await agent.StartAsync();
        using var view = new VaultAgentView(agent);
        var host = new StoredCollectorHostView(agent.Collectors, agent.Db.GetSetting, agent.Db.SetSetting);
        var startup = new FakeStartup();
        var vm = new MainViewModel(view, host, ImmediateDispatcher.Instance, startup, () => Task.FromResult<string?>(null), @"C:\Ivy.App.exe", "0.1.0");
        await vm.StartAsync();
        Assert.True(vm.ShowPairing);

        var (code, macFp) = r2.MacPrepares(DateTimeOffset.UtcNow);
        vm.Pairing.PairingText = code[..20] + "\r\n" + code[20..]; // a line break picked up while copying
        await vm.Pairing.PairAsync();
        Assert.True(vm.Pairing.Completed, vm.Pairing.Status);
        Assert.Equal(macFp, vm.Pairing.MacFingerprint);
        Assert.Equal(agent.PairingState!.DeviceFingerprint, vm.Pairing.DeviceFingerprint);
        Assert.True(view.IsPaired);
        Assert.Contains(vm.Feed.Items, i => i.Event == ActivityEvents.Paired);

        // The uploader now exists and the view is attached to it.
        view.UploadsPaused = true;
        Assert.True(agent.Uploader!.Paused);
        view.UploadsPaused = false;
        view.BandwidthBytesPerSecond = 1024 * 1024;
        Assert.Equal(1024 * 1024, agent.Uploader.BandwidthBytesPerSecond);

        var phases = new List<UploadPhase>();
        view.UploadProgress += (_, p) => { lock (phases) phases.Add(p.Phase); };
        await vm.SyncNowAsync();
        Assert.EndsWith(" ok", vm.SyncStatusText);
        Assert.Contains(r2.Up.Keys, k => k.StartsWith("up/", StringComparison.Ordinal) && !k.Contains("pair", StringComparison.Ordinal));
        lock (phases) Assert.Contains(UploadPhase.Completed, phases);
        await vm.RefreshAsync();
        Assert.StartsWith("up bucket: last put 20", vm.UpBucketText);
        Assert.DoesNotContain("never", vm.CmdBucketText);
        Assert.Contains(vm.Feed.Items, i => i.Event == ActivityEvents.Uploaded);
        Assert.Contains(vm.Feed.Items, i => i.Event == ActivityEvents.UploadStarted);
        Assert.Equal("0", vm.PendingObjectsText);
        await vm.ShutdownAsync();
    }
}

public class StoredCollectorHostViewTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task Rows_settings_and_pause()
    {
        using var db = new VaultDb(Path.Combine(_dir.Path, VaultDb.FileName));
        var state = new CollectorStateStore(db);
        state.Register("files");
        state.RecordRun("usage", DateTimeOffset.Parse("2026-10-10T12:00:00Z"));
        var defaults = new CollectorSettings { ScreenshotRoots = new[] { @"C:\Shots" } };
        var host = new StoredCollectorHostView(state, db.GetSetting, db.SetSetting, defaults);

        var rows = host.Collectors();
        Assert.Equal(new[] { "files", "usage" }, rows.Select(r => r.Name));
        Assert.All(rows, r => Assert.False(r.Running));
        Assert.Equal(DateTimeOffset.Parse("2026-10-10T12:00:00Z"), rows.Single(r => r.Name == "usage").LastRunAt);
        await host.SetEnabledAsync("files", false);
        Assert.False(state.Get("files")!.Enabled);

        Assert.Same(defaults, host.GetSettings());
        await host.ApplySettingsAsync(new CollectorSettings { IndexedRoots = new[] { @"D:\" }, WindowTitleCapture = false, TitleExclusions = new[] { "x.exe" } });
        var back = new StoredCollectorHostView(state, db.GetSetting, db.SetSetting).GetSettings();
        Assert.Equal(new[] { @"D:\" }, back.IndexedRoots);
        Assert.Empty(back.ScreenshotRoots);
        Assert.False(back.WindowTitleCapture);
        Assert.Equal(new[] { "x.exe" }, back.TitleExclusions);

        await host.PauseAsync();
        Assert.True(host.Paused);
        await host.ResumeAsync();
        Assert.False(host.Paused);
        Assert.Null(host.FileImport);
    }

    [Fact]
    public void Codec_tolerates_garbage()
    {
        Assert.Null(CollectorSettingsCodec.Decode(null));
        Assert.Null(CollectorSettingsCodec.Decode("not json"));
        Assert.Null(CollectorSettingsCodec.Decode("null"));
        var s = CollectorSettingsCodec.Decode("{\"v\":1}")!;
        Assert.True(s.WindowTitleCapture);
        Assert.Empty(s.IndexedRoots);
        // saved before the media policy existed: its defaults
        Assert.True(s.AutoUploadImages);
        Assert.Equal(25, s.ImageCapMB);
        Assert.Equal(10, s.DocumentCapMB);
        Assert.Contains("pdf", s.DocumentExtensions);
    }

    [Fact]
    public void Codec_round_trips_the_media_policy()
    {
        var s = new CollectorSettings
        {
            AutoUploadImages = false, ImageCapMB = 3.5, AutoUploadDocuments = false, DocumentCapMB = 1,
            ImageExtensions = new[] { "png" }, DocumentExtensions = new[] { "txt", "md" },
        };
        var back = CollectorSettingsCodec.Decode(CollectorSettingsCodec.Encode(s))!;
        Assert.False(back.AutoUploadImages);
        Assert.Equal(3.5, back.ImageCapMB);
        Assert.False(back.AutoUploadDocuments);
        Assert.Equal(1, back.DocumentCapMB);
        Assert.Equal(new[] { "png" }, back.ImageExtensions);
        Assert.Equal(new[] { "txt", "md" }, back.DocumentExtensions);
    }
}

public class FileLoggerTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Writes_levels_at_or_above_minimum()
    {
        var path = Path.Combine(_dir.Path, "logs", "ivy-app.log");
        using var f = new FileLoggerFactory(path);
        var log = Microsoft.Extensions.Logging.LoggerFactoryExtensions.CreateLogger<VaultAgentViewTests>(f);
        Microsoft.Extensions.Logging.LoggerExtensions.LogDebug(log, "hidden");
        Microsoft.Extensions.Logging.LoggerExtensions.LogWarning(log, "upload of {Key} failed", "up/x");
        var text = File.ReadAllText(path);
        Assert.DoesNotContain("hidden", text);
        Assert.Contains("WRN VaultAgentViewTests: upload of up/x failed", text);
    }
}
