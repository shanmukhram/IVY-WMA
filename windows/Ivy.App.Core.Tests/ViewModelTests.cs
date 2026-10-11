using Ivy.App.Core.Hosting;
using Ivy.App.Core.ViewModels;
using Ivy.Core.Agent;
using Ivy.Core.Protocol;
using Ivy.Core.Storage;
using Ivy.Core.Upload;
using Microsoft.Extensions.Time.Testing;

namespace Ivy.App.Core.Tests;

public class MainViewModelTests
{
    private const string Exe = @"C:\IVY\Ivy.App.exe";
    private readonly FakeAgent _agent = new();
    private readonly FakeHost _host = new();
    private readonly FakeStartup _startup = new();
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-10-10T12:00:00Z"));
    private string? _nextPick;

    private MainViewModel Create() =>
        new(_agent, _host, ImmediateDispatcher.Instance, _startup, () => Task.FromResult(_nextPick), Exe, "1.2.3", _time);

    private DateTimeOffset Now => _time.GetUtcNow();

    [Fact]
    public async Task Unpaired_start_shows_pairing_and_does_not_start_collectors()
    {
        var vm = Create();
        await vm.StartAsync();
        Assert.True(vm.ShowPairing);
        Assert.False(vm.ShowMain);
        Assert.Equal(0, _host.Starts);
        Assert.Equal("not paired", vm.FingerprintText);
        Assert.False(vm.SyncNowCommand.CanExecute(null));
        Assert.Equal("IVY for Windows 1.2.3", vm.VersionText);
    }

    [Fact]
    public async Task Paired_start_seeds_feed_starts_host_and_loads_settings()
    {
        _agent.IsPaired = true;
        _agent.DeviceFingerprint = "AAAA-BBBB-CCCC-DDDD";
        _agent.MacFingerprint = "1111-2222-3333-4444";
        _agent.History.AddRange(new[]
        {
            new ActivityEntry(1, "2026-10-10T11:00:00.000Z", "files", ActivityEvents.Queued, "up/a"),
            new ActivityEntry(2, "2026-10-10T11:00:01.000Z", "files", ActivityEvents.Uploaded, "up/a 10 bytes"),
        });
        _host.Settings = new CollectorSettings { IndexedRoots = new[] { @"D:\Docs" }, WindowTitleCapture = false, TitleExclusions = new[] { "keepass.exe" } };
        var vm = Create();
        await vm.StartAsync();

        // The window opens locked by design (PRD "Window privacy lock").
        Assert.True(vm.ShowLocked);
        Assert.False(vm.ShowMain);
        Assert.Equal(1, _host.Starts);
        Assert.Equal(new long?[] { 2, 1 }, vm.Feed.Items.Select(i => i.ActivityId).ToArray());
        Assert.Equal(new[] { @"D:\Docs" }, vm.Settings.IndexedRoots.Items);
        Assert.False(vm.Settings.WindowTitleCapture);
        Assert.Equal(new[] { "keepass.exe" }, vm.Settings.TitleExclusions.Items);
        Assert.Empty(_host.Applied); // loading does not write back
        Assert.Equal("device AAAA-BBBB-CCCC-DDDD   mac 1111-2222-3333-4444", vm.FingerprintText);
        Assert.Equal(new[] { "files", "screenshots", "usage", "notifications", "line", "telegram" }, vm.Collectors.Select(c => c.Name));
    }

    [Fact]
    public async Task Persisted_upload_pause_carries_over_to_capture()
    {
        _agent.IsPaired = true;
        _agent.UploadsPaused = true;
        var vm = Create();
        await vm.StartAsync();
        Assert.False(vm.IsRunning);
        Assert.True(_host.Paused);
        Assert.Equal("Paused", vm.RunStateText);
        Assert.Equal("Resume", vm.PauseMenuText);
    }

    [Fact]
    public async Task Global_toggle_pauses_uploads_and_capture()
    {
        _agent.IsPaired = true;
        var vm = Create();
        await vm.StartAsync();
        vm.IsRunning = false;
        Assert.Equal("Paused", vm.RunStateText); // shown at once; the writes follow off the UI thread
        await vm.LastHostWork;
        Assert.True(_agent.UploadsPaused);
        Assert.True(_host.Paused);
        Assert.Equal("Paused", vm.RunStateText);
        vm.TogglePause();
        await vm.LastHostWork;
        Assert.False(_agent.UploadsPaused);
        Assert.False(_host.Paused);
        Assert.Equal("Running", vm.RunStateText);
        Assert.Equal("Pause", vm.PauseMenuText);
    }

    [Fact]
    public async Task Live_activity_and_upload_started_reach_the_feed()
    {
        _agent.IsPaired = true;
        var vm = Create();
        await vm.StartAsync();
        _agent.RaiseActivity(new ActivityEntry(7, "2026-10-10T12:00:00.000Z", "usage", ActivityEvents.Encrypted, "usage_event up/u 300 bytes"));
        _agent.RaiseProgress(new UploadProgress("up/u", "usage", 0, 300, UploadPhase.Started));
        _agent.RaiseProgress(new UploadProgress("up/u", "usage", 100, 300, UploadPhase.Progress));
        Assert.Equal(2, vm.Feed.Items.Count);
        Assert.Equal(ActivityEvents.UploadStarted, vm.Feed.Items[0].Event);
        Assert.Equal(7, vm.Feed.Items[1].ActivityId);
    }

    [Fact]
    public async Task Current_upload_shows_latest_progress_then_idle()
    {
        _agent.IsPaired = true;
        var vm = Create();
        await vm.StartAsync();
        Assert.Equal("idle", vm.CurrentUploadText);
        _agent.RaiseProgress(new UploadProgress("up/big", "files", 8L * 1024 * 1024, 32L * 1024 * 1024, UploadPhase.Progress));
        await vm.RefreshAsync();
        Assert.True(vm.HasCurrentUpload);
        Assert.Equal(25, vm.CurrentUploadPercent);
        Assert.Equal("up/big  8.0 MB of 32.0 MB (25%)", vm.CurrentUploadText);
        _agent.RaiseProgress(new UploadProgress("up/big", "files", 32L * 1024 * 1024, 32L * 1024 * 1024, UploadPhase.Completed));
        await vm.RefreshAsync();
        Assert.False(vm.HasCurrentUpload);
        Assert.Equal("idle (last: up/big)", vm.CurrentUploadText);
    }

    [Fact]
    public async Task Rows_queue_import_and_footer_follow_the_snapshots()
    {
        _agent.IsPaired = true;
        _host.Infos.Add(new CollectorInfo { Name = "usage", Enabled = true, Running = true, LastRunAt = Now.AddSeconds(-10), Detail = "titles on" });
        _host.Infos.Add(new CollectorInfo { Name = "screenshots", Enabled = true, Running = true, LastRunAt = Now.AddMinutes(-11) });
        _host.Infos.Add(new CollectorInfo { Name = "notifications", Enabled = true, Running = true, LastRunAt = Now, LastError = "database locked" });
        _host.Infos.Add(new CollectorInfo { Name = "files", Enabled = false });
        _host.Infos.Add(new CollectorInfo { Name = "extra", Enabled = true, Running = true, LastRunAt = Now, ExpectedInterval = TimeSpan.FromMinutes(1) });
        _host.FileImport = new FileImportProgress(2500, 10000, false);
        _agent.NextSnapshot = new AgentSnapshot
        {
            PendingObjects = 12,
            PendingBytes = 3 * 1024 * 1024,
            RetryingObjects = 2,
            ByCollector = new Dictionary<string, QueueStats> { ["usage"] = new(4, 2048, 0), ["files"] = new(8, 3 * 1024 * 1024 - 2048, 2) },
            LastUploadByCollector = new Dictionary<string, DateTimeOffset> { ["usage"] = Now.AddSeconds(-5) },
            LastQueuedByCollector = new Dictionary<string, DateTimeOffset> { ["usage"] = Now.AddSeconds(-2) },
            LastUpPutAt = Now.AddSeconds(-5),
            UpError = "timeout",
            UpErrorAt = Now.AddSeconds(-1),
            LastCmdListAt = Now.AddMinutes(-1),
        };
        var vm = Create();
        await vm.StartAsync();

        var usage = vm.Collectors.Single(c => c.Name == "usage");
        Assert.True(usage.Enabled);
        Assert.Equal(CollectorStatus.Ok, usage.Status);
        Assert.Equal(StatusRules.Green, usage.StatusColor);
        Assert.Equal("2s ago", usage.LastCaptureText);
        Assert.Equal("5s ago", usage.LastUploadText);
        Assert.Equal("4 (2.0 KB)", usage.QueueDepthText);
        Assert.Equal("ok - titles on", usage.StatusText);
        Assert.Equal(CollectorStatus.Stale, vm.Collectors.Single(c => c.Name == "screenshots").Status); // > 2 x 5 min
        var notif = vm.Collectors.Single(c => c.Name == "notifications");
        Assert.Equal(CollectorStatus.Error, notif.Status);
        Assert.Equal("error: database locked", notif.StatusText);
        Assert.Equal(CollectorStatus.Off, vm.Collectors.Single(c => c.Name == "files").Status);
        Assert.Equal(CollectorStatus.Ok, vm.Collectors.Single(c => c.Name == "extra").Status); // unknown collectors get a row

        Assert.Equal("12", vm.PendingObjectsText);
        Assert.Equal("3.0 MB", vm.PendingBytesText);
        Assert.Equal("2", vm.RetryingText);
        Assert.Equal("scanning: 2,500 / 10,000 files (25%)", vm.ImportText);
        Assert.Equal(25, vm.ImportPercent);
        Assert.Equal("bytes queued: 3.0 MB in 8 objects", vm.ImportBytesText);
        Assert.Contains("last put", vm.UpBucketText);
        Assert.Contains("(5s ago)", vm.UpBucketText);
        Assert.EndsWith("last attempt failed 1s ago: timeout", vm.UpBucketText);
        Assert.Contains("(1m ago)", vm.CmdBucketText);
        Assert.DoesNotContain("error", vm.CmdBucketText);

        _time.Advance(TimeSpan.FromMinutes(2));
        await vm.RefreshAsync();
        Assert.Equal(CollectorStatus.Stale, usage.Status);
    }

    [Fact]
    public async Task Missing_collectors_and_no_import_are_reported_honestly()
    {
        _agent.IsPaired = true;
        var vm = Create();
        await vm.StartAsync();
        Assert.All(vm.Collectors, c => Assert.Equal("not available", c.StatusText));
        Assert.Equal("no initial index reported by the files collector", vm.ImportText);
        Assert.Equal("up bucket: last put never", vm.UpBucketText);
        Assert.Equal("cmd bucket: last list never", vm.CmdBucketText);
    }

    [Fact]
    public async Task Row_toggle_goes_to_host_but_refresh_does_not()
    {
        _agent.IsPaired = true;
        _host.Infos.Add(new CollectorInfo { Name = "usage", Enabled = true, Running = true, LastRunAt = Now });
        var vm = Create();
        await vm.StartAsync();
        await vm.RefreshAsync();
        Assert.Empty(_host.EnabledCalls);
        vm.Collectors.Single(c => c.Name == "usage").Enabled = false;
        await vm.LastHostWork;
        Assert.Equal(new[] { ("usage", false) }, _host.EnabledCalls);
    }

    [Fact]
    public async Task Sync_now_calls_agent_and_reports_failure()
    {
        _agent.IsPaired = true;
        var vm = Create();
        await vm.StartAsync();
        await vm.SyncNowAsync();
        Assert.Equal(1, _agent.SyncCalls);
        Assert.EndsWith(" ok", vm.SyncStatusText);
        _agent.SyncError = new InvalidOperationException("offline");
        await vm.SyncNowAsync();
        Assert.Equal("sync failed: offline", vm.SyncStatusText);
    }

    [Fact]
    public async Task Host_exceptions_surface_as_text_not_crashes()
    {
        _agent.IsPaired = true;
        var host = new ThrowingHost();
        var vm = new MainViewModel(_agent, host, ImmediateDispatcher.Instance, _startup, () => Task.FromResult<string?>(null), Exe, "1", _time);
        await vm.StartAsync();
        Assert.StartsWith("Collector host: ", vm.HostErrorText);
        vm.IsRunning = false;
        await vm.LastHostWork;
        Assert.True(_agent.UploadsPaused);
        Assert.Equal("Collector host: boom", vm.HostErrorText);
        vm.Settings.WindowTitleCapture = false;
        await vm.Settings.LastApply;
        Assert.Equal("Could not apply capture settings: roots: not a folder", vm.Settings.SettingsError);
    }

    [Fact]
    public async Task Pairing_flow_shows_fingerprints_then_continue_switches_to_main()
    {
        _agent.OnPair = s => new PairingResult("dev", "pid", "AAAA-BBBB-CCCC-DDDD", "1111-2222-3333-4444");
        // The owner provisions the window lock passphrase once, from the command line, before the window is built.
        var lockStore = new Ivy.App.Core.WindowLock.InMemoryWindowLockStore();
        Ivy.App.Core.WindowLock.WindowLockSetup.StorePassphrase(lockStore, "test passphrase");
        var vm = new MainViewModel(_agent, _host, ImmediateDispatcher.Instance, _startup, () => Task.FromResult(_nextPick), Exe, "1.2.3", _time,
            lockStore: lockStore);
        await vm.StartAsync();
        Assert.False(vm.Pairing.PairCommand.CanExecute(null));
        vm.Pairing.PairingText = "  IVYPAIR1.xyz\r\n";
        Assert.True(vm.Pairing.PairCommand.CanExecute(null));
        await vm.Pairing.PairAsync();
        await vm.LastHostWork; // host start and run at login happen off the UI thread

        Assert.True(vm.Pairing.Completed);
        Assert.Equal("AAAA-BBBB-CCCC-DDDD", vm.Pairing.DeviceFingerprint);
        Assert.Equal("1111-2222-3333-4444", vm.Pairing.MacFingerprint);
        Assert.True(vm.ShowPairing);              // still on the pairing panel to compare fingerprints
        Assert.Equal(1, _host.Starts);            // collectors start right after pairing
        Assert.Equal(StartupCommand.Build(Exe), _startup.Command); // WP2: run at login on first pairing
        Assert.True(vm.Settings.RunAtLogin);
        Assert.True(vm.SyncNowCommand.CanExecute(null));
        Assert.False(vm.Pairing.PairCommand.CanExecute(null));
        Assert.True(vm.Pairing.ContinueCommand.CanExecute(null));
        vm.Pairing.ContinueCommand.Execute(null);
        // The window opens locked by design (PRD "Window privacy lock").
        Assert.True(vm.ShowLocked);
        Assert.False(vm.ShowMain);
        // The main panel is still reachable: the gesture, then the provisioned passphrase, reveals it.
        for (var i = 0; i < Ivy.App.Core.WindowLock.UnlockGesture.PressCount; i++) vm.Lock.Press();
        Assert.Equal(Ivy.App.Core.WindowLock.LockPrompt.EnterPassphrase, vm.Lock.Prompt);
        Assert.True(vm.Lock.TryUnlock("test passphrase"));
        Assert.True(vm.ShowMain);
        Assert.False(vm.ShowLocked);
        Assert.False(vm.ShowPairing);
    }

    [Fact]
    public async Task Pairing_failure_shows_reason_and_stays_editable()
    {
        _agent.OnPair = _ => throw new PairingException("pairing code expired");
        var vm = Create();
        await vm.StartAsync();
        vm.Pairing.PairingText = "IVYPAIR1.old";
        await vm.Pairing.PairAsync();
        Assert.Equal("Pairing failed: pairing code expired", vm.Pairing.Status);
        Assert.False(vm.Pairing.Completed);
        Assert.True(vm.Pairing.CanEdit);
        Assert.Equal(0, _host.Starts);
        Assert.Null(_startup.Command);
    }

    [Fact]
    public async Task Run_at_login_respects_an_earlier_decision_and_repoints_stale_entries()
    {
        _agent.IsPaired = true;
        _agent.Settings[SettingsViewModel.RunAtLoginDecidedKey] = "1";
        _startup.Command = "\"C:\\old place\\Ivy.App.exe\" --minimized";
        var vm = Create();
        await vm.StartAsync();
        Assert.True(vm.Settings.RunAtLogin);
        Assert.Equal(StartupCommand.Build(Exe), _startup.Command);
        vm.Settings.RunAtLogin = false;
        await vm.Settings.LastWork;
        Assert.Null(_startup.Command);
        vm.Settings.EnableRunAtLoginByDefault(); // decision recorded: no-op
        Assert.Null(_startup.Command);
    }

    [Fact]
    public async Task Paired_start_without_a_decision_registers_run_at_login()
    {
        // Paired before the run-at-login default existed, or the decision key was lost.
        _agent.IsPaired = true;
        var vm = Create();
        await vm.StartAsync();
        Assert.Equal(StartupCommand.Build(Exe), _startup.Command);
        Assert.True(vm.Settings.RunAtLogin);
        Assert.Equal("1", _agent.Settings[SettingsViewModel.RunAtLoginDecidedKey]);
    }

    [Fact]
    public async Task Paired_start_with_run_at_login_turned_off_does_not_re_register()
    {
        _agent.IsPaired = true;
        _agent.Settings[SettingsViewModel.RunAtLoginDecidedKey] = "1";
        var vm = Create();
        await vm.StartAsync();
        Assert.Null(_startup.Command);
        Assert.False(vm.Settings.RunAtLogin);
    }

    [Fact]
    public async Task Capture_settings_apply_on_every_change()
    {
        _agent.IsPaired = true;
        var vm = Create();
        await vm.StartAsync();
        _nextPick = @"E:\Photos";
        Assert.True(await vm.Settings.IndexedRoots.PickAndAddAsync());
        await vm.Settings.LastApply;
        Assert.Equal(new[] { @"E:\Photos" }, _host.Settings.IndexedRoots);
        _nextPick = null; // dialog cancelled
        Assert.False(await vm.Settings.IndexedRoots.PickAndAddAsync());
        _nextPick = @"C:\Users\b\Pictures\Screenshots";
        await vm.Settings.ScreenshotRoots.PickAndAddAsync();
        await vm.Settings.LastApply;
        vm.Settings.TitleExclusions.NewItem = " 1Password.exe ";
        Assert.True(vm.Settings.TitleExclusions.AddNew());
        await vm.Settings.LastApply;
        Assert.Equal("", vm.Settings.TitleExclusions.NewItem);
        vm.Settings.WindowTitleCapture = false;
        await vm.Settings.LastApply;
        Assert.Equal(4, _host.Applied.Count);
        var last = _host.Applied[^1];
        Assert.Equal(new[] { @"C:\Users\b\Pictures\Screenshots" }, last.ScreenshotRoots);
        Assert.Equal(new[] { "1Password.exe" }, last.TitleExclusions);
        Assert.False(last.WindowTitleCapture);
        vm.Settings.IndexedRoots.Remove(@"e:\photos");
        await vm.Settings.LastApply;
        Assert.Empty(_host.Settings.IndexedRoots);
    }

    [Fact]
    public async Task Media_policy_settings_load_validate_and_apply()
    {
        _agent.IsPaired = true;
        _host.Settings = new CollectorSettings
        {
            AutoUploadImages = true, ImageCapMB = 25, AutoUploadDocuments = false, DocumentCapMB = 2.5,
            ImageExtensions = new[] { "png", "jpg" }, DocumentExtensions = new[] { "pdf" },
        };
        var vm = Create();
        await vm.StartAsync();
        var s = vm.Settings;
        Assert.True(s.AutoUploadImages);
        Assert.False(s.AutoUploadDocuments);
        Assert.Equal("25", s.ImageCapText);
        Assert.Equal("2.5", s.DocumentCapText);
        Assert.Equal("current: images up to 25 MB, documents up to 2.5 MB", s.CapsStatus);
        Assert.Equal(new[] { "png", "jpg" }, s.ImageExtensions.Items);
        Assert.Equal(new[] { "pdf" }, s.DocumentExtensions.Items);
        Assert.Empty(_host.Applied); // loading does not write back

        // toggles apply at once
        s.AutoUploadDocuments = true;
        await s.LastApply;
        Assert.True(_host.Applied[^1].AutoUploadDocuments);
        s.AutoUploadImages = false;
        await s.LastApply;
        Assert.False(_host.Settings.AutoUploadImages);

        // caps apply with the button, and only valid values
        s.ImageCapText = "0";
        s.ApplyCapsCommand.Execute(null);
        Assert.Equal("enter sizes in MB, more than 0 and at most 4096", s.CapsStatus);
        s.ImageCapText = "lots";
        s.ApplyCapsCommand.Execute(null);
        Assert.Equal(2, _host.Applied.Count);
        Assert.Equal(25, _host.Settings.ImageCapMB);
        s.ImageCapText = " 50 MB ";
        s.DocumentCapText = "12.25";
        s.ApplyCapsCommand.Execute(null);
        await s.LastApply;
        Assert.Equal(50, _host.Settings.ImageCapMB);
        Assert.Equal(12.25, _host.Settings.DocumentCapMB);
        Assert.Equal("50", s.ImageCapText);
        Assert.Equal("current: images up to 50 MB, documents up to 12.25 MB", s.CapsStatus);

        // extension lists: normalized (no dot, lower case), duplicates rejected
        s.ImageExtensions.NewItem = " .HEIC ";
        Assert.True(s.ImageExtensions.AddNew());
        Assert.False(s.ImageExtensions.Add("heic"));
        Assert.False(s.ImageExtensions.Add(" . "));
        await s.LastApply;
        Assert.Equal(new[] { "png", "jpg", "heic" }, _host.Settings.ImageExtensions);
        Assert.True(s.DocumentExtensions.Add("TXT"));
        Assert.True(s.DocumentExtensions.Remove("pdf"));
        await s.LastApply;
        Assert.Equal(new[] { "txt" }, _host.Settings.DocumentExtensions);
        Assert.Equal(new[] { "png", "jpg", "heic" }, _host.Settings.ImageExtensions); // other values carried over
        Assert.Equal("", s.SettingsError);
    }

    [Fact]
    public async Task Media_policy_defaults_match_the_collector_defaults()
    {
        _agent.IsPaired = true;
        var vm = Create(); // the fake host returns new CollectorSettings(): the defaults
        await vm.StartAsync();
        var c = new Ivy.Collectors.Files.FileIndexSettings();
        Assert.Equal(c.AutoUploadImages, vm.Settings.AutoUploadImages);
        Assert.Equal(c.AutoUploadDocuments, vm.Settings.AutoUploadDocuments);
        Assert.Equal(c.ImageCapMB, vm.Settings.ImageCapMB);
        Assert.Equal(c.DocumentCapMB, vm.Settings.DocumentCapMB);
        Assert.Equal(c.ImageExtensions, vm.Settings.ImageExtensions.Items);
        Assert.Equal(c.DocumentExtensions, vm.Settings.DocumentExtensions.Items);
        Assert.True(vm.Settings.AutoUploadImages);
        Assert.Equal(25, vm.Settings.ImageCapMB);
        Assert.Equal(10, vm.Settings.DocumentCapMB);
    }

    [Fact]
    public async Task Bandwidth_cap_validates_and_applies()
    {
        _agent.IsPaired = true;
        _agent.BandwidthBytesPerSecond = 0;
        var vm = Create();
        await vm.StartAsync();
        Assert.Equal("0", vm.Settings.BandwidthText);
        Assert.Equal("current: unlimited", vm.Settings.BandwidthStatus);
        vm.Settings.BandwidthText = "abc";
        vm.Settings.ApplyBandwidthCommand.Execute(null);
        Assert.Equal(0, _agent.BandwidthBytesPerSecond);
        Assert.Equal("enter whole KB/s (0 = unlimited)", vm.Settings.BandwidthStatus);
        vm.Settings.BandwidthText = "256";
        vm.Settings.ApplyBandwidthCommand.Execute(null);
        await vm.Settings.LastWork;
        Assert.Equal(256 * 1024, _agent.BandwidthBytesPerSecond);
        Assert.Equal("current: 256.0 KB/s", vm.Settings.BandwidthStatus);
    }

    [Fact]
    public async Task Shutdown_disposes_the_host()
    {
        var vm = Create();
        await vm.StartAsync();
        await vm.ShutdownAsync();
        Assert.True(_host.Disposed);
    }

    private sealed class ThrowingHost : ICollectorHostView
    {
        public bool Paused => false;
        public FileImportProgress? FileImport => throw new InvalidOperationException("boom");
        public IReadOnlyList<CollectorInfo> Collectors() => throw new InvalidOperationException("boom");
        public Task SetEnabledAsync(string name, bool enabled) => throw new InvalidOperationException("boom");
        public Task PauseAsync() => Task.FromException(new InvalidOperationException("boom"));
        public Task ResumeAsync() => throw new InvalidOperationException("boom");
        public CollectorSettings GetSettings() => new();
        public Task ApplySettingsAsync(CollectorSettings settings) => Task.FromException(new ArgumentException("roots: not a folder"));
        public Task StartAsync(CancellationToken ct = default) => Task.CompletedTask;
        public Task ApplyTelegramPasscodeAsync(string passcode) => Task.CompletedTask;
        public Task ApplyLineKeyAsync(string key) => Task.CompletedTask;
        public Task<bool> DetectLineKeyAsync() => Task.FromResult(false);
        public bool LineHasKey => false;
        public bool TelegramIncludeChannels => true;
        public Task SetTelegramIncludeChannelsAsync(bool include) => Task.CompletedTask;
        public Task RunLineProbeAsync() => Task.CompletedTask;
        public string? LineReportPath => null;
        public Task ResyncConversationsAsync() => Task.CompletedTask;
        public Task<IReadOnlyList<string>> IndexStandardFoldersAsync() => Task.FromResult<IReadOnlyList<string>>(System.Array.Empty<string>());
        public Task<IReadOnlyList<string>> CatalogMyPcAsync() => Task.FromResult<IReadOnlyList<string>>(System.Array.Empty<string>());
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

public class StringListViewModelTests
{
    [Fact]
    public void Trims_dedupes_and_counts_changes()
    {
        var changes = 0;
        var l = new StringListViewModel(() => changes++);
        Assert.True(l.Add(@" C:\A "));
        Assert.False(l.Add(@"c:\a"));
        Assert.False(l.Add("   "));
        Assert.False(l.Add(null));
        Assert.True(l.Add(@"D:\B"));
        Assert.Equal(new[] { @"C:\A", @"D:\B" }, l.Items);
        Assert.Equal(2, changes);
        Assert.False(l.Remove(@"X:\none"));
        Assert.False(l.Remove(null));
        Assert.True(l.Remove(@"C:\A"));
        Assert.Equal(3, changes);
    }

    [Fact]
    public void Load_does_not_raise_changes()
    {
        var changes = 0;
        var l = new StringListViewModel(() => changes++);
        l.Load(new[] { "a", " A ", "", "b" });
        Assert.Equal(new[] { "a", "b" }, l.Items);
        Assert.Equal(0, changes);
    }

    [Fact]
    public async Task Without_picker_pick_does_nothing()
    {
        var l = new StringListViewModel(() => { });
        Assert.False(await l.PickAndAddAsync());
    }
}

public class FeedBatchingTests
{
    /// <summary>Collects posted actions so the test controls when the "UI thread" runs.</summary>
    private sealed class ManualDispatcher : IUiDispatcher
    {
        public List<Action> Posted { get; } = new();
        public bool Post(Action action)
        {
            Posted.Add(action);
            return true;
        }
    }

    [Fact]
    public async Task Bursts_of_activity_become_one_ui_post()
    {
        var agent = new FakeAgent();
        var ui = new ManualDispatcher();
        var vm = new Ivy.App.Core.ViewModels.MainViewModel(agent, new FakeHost(), ui, new FakeStartup(), () => Task.FromResult<string?>(null), "x.exe", "1");
        await vm.StartAsync();
        ui.Posted.Clear();
        for (var i = 1; i <= 2000; i++) agent.RaiseActivity(new Ivy.Core.Storage.ActivityEntry(i, "2026-10-10T12:00:00.000Z", "files", "queued", null));
        Assert.Single(ui.Posted);
        ui.Posted[0]();
        Assert.Equal(ActivityFeed.DefaultCapacity, vm.Feed.Items.Count);
        Assert.Equal(2000, vm.Feed.Items[0].ActivityId);
        agent.RaiseActivity(new Ivy.Core.Storage.ActivityEntry(2001, "2026-10-10T12:00:00.000Z", "files", "queued", null));
        Assert.Equal(2, ui.Posted.Count); // a new burst after the flush schedules a new post
        ui.Posted[1]();
        Assert.Equal(2001, vm.Feed.Items[0].ActivityId);
    }
}
