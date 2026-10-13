using Ivy.App.Core.Hosting;
using Ivy.App.Core.ViewModels;
using Ivy.Core.Agent;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.Storage;
using Microsoft.Extensions.Time.Testing;

namespace Ivy.App.Core.Tests;

/// <summary>Fourth run (Fluent redesign): navigation state, per-page view models, brand icons, pairing errors, unpair.</summary>
public class NavigationStateTests
{
    private sealed class MemorySettings : IAgentViewSettings
    {
        public Dictionary<string, string> Values { get; } = new();
        public ThreadLog Threads { get; } = new();
        public string? GetSetting(string key) => Values.TryGetValue(key, out var v) ? v : null;
        public void SetSetting(string key, string value)
        {
            Threads.Record("SetSetting");
            Values[key] = value;
        }
    }

    [Fact]
    public void Defaults_to_overview_with_both_groups_expanded()
    {
        var nav = new NavigationViewModel(new UiStateStore(new MemorySettings()));
        nav.Load();
        Assert.Equal(NavPages.Overview, nav.SelectedPage);
        Assert.Equal("Overview", nav.SelectedTitle);
        Assert.True(nav.IsExpanded(NavPages.CollectorsGroup));
        Assert.True(nav.IsExpanded(NavPages.ConversationsGroup));
    }

    [Fact]
    public async Task Selection_and_expanded_groups_persist_and_reload()
    {
        var settings = new MemorySettings();
        var nav = new NavigationViewModel(new UiStateStore(settings));
        nav.SetExpanded(NavPages.ConversationsGroup, false);
        await nav.LastSave;
        Assert.True(nav.Select(NavPages.Usage));
        await nav.LastSave;
        Assert.All(settings.Threads.Calls, c => Assert.NotEqual(Environment.CurrentManagedThreadId, c.Thread)); // never on the caller's (UI) thread

        var reloaded = new NavigationViewModel(new UiStateStore(settings));
        reloaded.Load();
        Assert.Equal(NavPages.Usage, reloaded.SelectedPage);
        Assert.True(reloaded.IsExpanded(NavPages.CollectorsGroup));
        Assert.False(reloaded.IsExpanded(NavPages.ConversationsGroup));
    }

    [Fact]
    public async Task Selecting_a_child_opens_its_group()
    {
        var settings = new MemorySettings();
        var nav = new NavigationViewModel(new UiStateStore(settings));
        nav.SetExpanded(NavPages.ConversationsGroup, false);
        var raised = new List<string?>();
        nav.PropertyChanged += (_, e) => raised.Add(e.PropertyName);
        nav.Select(NavPages.Telegram);
        await nav.LastSave;
        Assert.True(nav.IsExpanded(NavPages.ConversationsGroup));
        Assert.Contains(nameof(NavigationViewModel.ExpandedGroups), raised);
        Assert.Contains(nameof(NavigationViewModel.SelectedPage), raised);
        Assert.Equal("LINE", NavPages.Title(NavPages.Line));
        Assert.Equal(NavPages.ConversationsGroup, NavPages.GroupOf(NavPages.Line));
        Assert.Null(NavPages.GroupOf(NavPages.Transfers));
    }

    [Fact]
    public void Group_headers_and_unknown_tags_are_not_pages()
    {
        var settings = new MemorySettings();
        var nav = new NavigationViewModel(new UiStateStore(settings));
        Assert.False(nav.Select(NavPages.CollectorsGroup));
        Assert.False(nav.Select("nope"));
        Assert.False(nav.Select(null));
        Assert.Equal(NavPages.Overview, nav.SelectedPage);
        nav.SetExpanded("nope", true);
        Assert.DoesNotContain("nope", nav.ExpandedGroups);
        Assert.Empty(settings.Values);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("{not json")]
    [InlineData("[]")]
    public void Corrupt_saved_state_keeps_the_defaults(string? saved)
    {
        var settings = new MemorySettings();
        if (saved is not null) settings.Values[NavigationViewModel.SettingsKey] = saved;
        var nav = new NavigationViewModel(new UiStateStore(settings));
        nav.Load();
        Assert.Equal(NavPages.Overview, nav.SelectedPage);
        Assert.True(nav.IsExpanded(NavPages.CollectorsGroup));
    }

    [Fact]
    public void Unknown_saved_page_and_groups_are_dropped()
    {
        var decoded = NavigationViewModel.Decode("""{"page":"timeline","expanded":["collectors","android","collectors"]}""");
        Assert.NotNull(decoded);
        Assert.Equal(NavPages.Overview, decoded.Value.Page);
        Assert.Equal(new[] { NavPages.CollectorsGroup }, decoded.Value.Expanded);
        Assert.Equal("""{"page":"files","expanded":["collectors","conversations"]}""",
            NavigationViewModel.Encode(NavPages.Files, new[] { NavPages.ConversationsGroup, NavPages.CollectorsGroup }));
    }

    [Fact]
    public void Every_page_and_group_has_a_title_and_pages_are_distinct()
    {
        Assert.Equal(NavPages.All.Count, NavPages.All.Distinct().Count());
        Assert.All(NavPages.All.Concat(NavPages.Groups), t => Assert.NotEqual(t, NavPages.Title(t)));
        Assert.All(NavPages.Groups, g => Assert.False(NavPages.IsPage(g)));
    }

    [Fact]
    public async Task Theme_override_round_trips()
    {
        var settings = new MemorySettings();
        var a = new AppearanceViewModel(new UiStateStore(settings));
        a.Load();
        Assert.Equal(AppTheme.System, a.Theme);
        a.ThemeIndex = 2;
        await a.LastSave;
        Assert.Equal(AppTheme.Dark, a.Theme);
        Assert.Equal("dark", settings.Values[AppearanceViewModel.SettingsKey]);
        a.ThemeIndex = 7; // out of range: ignored
        Assert.Equal(AppTheme.Dark, a.Theme);

        var b = new AppearanceViewModel(new UiStateStore(settings));
        b.Load();
        Assert.Equal(2, b.ThemeIndex);
        settings.Values[AppearanceViewModel.SettingsKey] = "purple";
        b.Load();
        Assert.Equal(AppTheme.System, b.Theme);
    }

    [Fact]
    public async Task A_failing_store_does_not_throw()
    {
        var store = new UiStateStore(new ThrowingSettings());
        var nav = new NavigationViewModel(store);
        nav.Load();
        nav.Select(NavPages.Settings);
        await nav.LastSave; // swallowed
        Assert.Equal(NavPages.Settings, nav.SelectedPage);
    }

    private sealed class ThrowingSettings : IAgentViewSettings
    {
        public string? GetSetting(string key) => throw new IOException("db gone");
        public void SetSetting(string key, string value) => throw new IOException("db gone");
    }
}

public class BrandIconTests
{
    [Fact]
    public void Embedded_resource_has_telegram_and_line_from_simple_icons()
    {
        Assert.Contains("simple-icons", BrandIcons.Source);
        Assert.Contains("CC0", BrandIcons.Source);
        Assert.Contains("telegram", BrandIcons.Known);
        Assert.Contains("line", BrandIcons.Known);
    }

    [Theory]
    [InlineData("telegram", "telegram", "#26A5E4")]
    [InlineData("Telegram Desktop", "telegram", "#26A5E4")]
    [InlineData("org.telegram.messenger", "telegram", "#26A5E4")]
    [InlineData("LINE", "line", "#00C300")]
    [InlineData("jp.naver.line.android", "line", "#00C300")]
    public void Known_apps_map_to_their_path_and_brand_colour(string app, string key, string color)
    {
        var g = BrandIcons.For(app);
        Assert.True(g.HasPath);
        Assert.False(g.IsFallback);
        Assert.Equal(key, g.Key);
        Assert.Equal(color, g.Color);
        Assert.False(g.UsesTextColor);
        Assert.StartsWith("M", g.PathData);
        // SVG path syntax only: commands, numbers, separators.
        Assert.Matches("^[MmZzLlHhVvCcSsQqTtAa0-9.,\\- ]+$", g.PathData!);
    }

    [Fact]
    public void Path_data_matches_simple_icons_exactly()
    {
        // Spot checks against simple-icons 16.32.0 icons/telegram.svg and icons/line.svg.
        Assert.StartsWith("M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12", BrandIcons.Telegram.PathData);
        Assert.EndsWith("4.025-1.627 4.476-1.635z", BrandIcons.Telegram.PathData);
        Assert.StartsWith("M19.365 9.863c.349 0 .63.285.63.631", BrandIcons.Line.PathData);
        Assert.EndsWith("C23.176 14.393 24 12.458 24 10.314", BrandIcons.Line.PathData);
    }

    [Theory]
    [InlineData("WhatsApp", "WH")]
    [InlineData("Signal Desktop", "SD")]
    [InlineData("x", "X")]
    [InlineData("", "#")]
    [InlineData(null, "#")]
    [InlineData("!!!", "#")]
    public void Unknown_apps_fall_back_to_an_initials_tile(string? app, string initials)
    {
        var g = BrandIcons.For(app);
        Assert.True(g.IsFallback);
        Assert.Null(g.PathData);
        Assert.Equal(initials, g.Initials);
        Assert.Matches("^#[0-9A-F]{6}$", g.TileColor);
        Assert.Equal(g.TileColor, g.Color);
    }

    [Fact]
    public void Tile_colour_is_stable_and_matches_the_mac_hash()
    {
        Assert.Equal(BrandIcons.For("WhatsApp").TileColor, BrandIcons.For("whats app").TileColor);
        // FNV-1a("whatsapp") mod 10, as mac/ui/src/components/Avatar.tsx computes it.
        uint h = 2166136261;
        foreach (var c in "whatsapp") { h ^= c; h = unchecked(h * 16777619); }
        var palette = new[] { "#FF6B5F", "#FF9F0A", "#E5B000", "#34C759", "#00B8A9", "#32ADE6", "#007AFF", "#5E5CE6", "#AF52DE", "#FF375F" };
        Assert.Equal(palette[h % 10], BrandIcons.HashColor("whatsapp"));
    }

    [Fact]
    public void Luminance_rule_matches_the_mac()
    {
        Assert.True(BrandIcons.Luminance("000000") < 0.04);
        Assert.True(BrandIcons.Luminance("FFFC00") > 0.6);
        Assert.InRange(BrandIcons.Luminance("26A5E4"), 0.04, 0.6);
    }
}

public class PageViewModelTests
{
    private readonly FakeAgent _agent = new() { IsPaired = true, DeviceFingerprint = "AAAA-BBBB", MacFingerprint = "1111-2222" };
    private readonly FakeHost _host = new();
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-10-10T12:00:00Z"));
    private readonly List<string> _opened = new();

    private MainViewModel Create() =>
        new(_agent, _host, ImmediateDispatcher.Instance, new FakeStartup(), () => Task.FromResult<string?>(null), @"C:\IVY\Ivy.App.exe", "1.2.3", _time,
            _opened.Add, folders: new AppFolders(@"C:\Users\b\AppData\Local\IVY", @"C:\Users\b\AppData\Local\IVY\logs"));

    private DateTimeOffset Now => _time.GetUtcNow();

    [Fact]
    public async Task Overview_card_reports_fingerprints_run_state_and_reachability()
    {
        _agent.NextSnapshot = new AgentSnapshot { LastUpPutAt = Now.AddSeconds(-5), LastCmdListAt = Now.AddMinutes(-1) };
        var vm = Create();
        await vm.StartAsync();
        Assert.Equal("AAAA-BBBB", vm.Overview.DeviceFingerprint);
        Assert.Equal("1111-2222", vm.Overview.MacFingerprint);
        Assert.Equal("Reachable", vm.Overview.BucketStateText);
        Assert.Equal(UiSeverity.Success, vm.Overview.BucketSeverity);
        Assert.False(vm.Overview.HasBucketProblem);
        Assert.EndsWith("(5s ago)", vm.Overview.LastUploadText);
        Assert.EndsWith("(1m ago)", vm.Overview.LastPollText);
        Assert.Equal(OverviewViewModel.RunningLine, vm.Overview.RunStateLine);

        vm.IsRunning = false;
        await vm.LastHostWork;
        Assert.Equal(OverviewViewModel.PausedLine, vm.Overview.RunStateLine);
    }

    [Fact]
    public async Task Unreachable_bucket_opens_the_infobar_with_the_reason()
    {
        _agent.NextSnapshot = new AgentSnapshot { LastUpPutAt = Now.AddMinutes(-9), UpError = "name resolution failed", UpErrorAt = Now.AddSeconds(-3), CmdError = "timeout" };
        var vm = Create();
        await vm.StartAsync();
        Assert.True(vm.Overview.HasBucketProblem);
        Assert.Equal("Not reachable", vm.Overview.BucketStateText);
        Assert.Equal(UiSeverity.Error, vm.Overview.BucketSeverity);
        Assert.Equal("The IVY buckets are not reachable", vm.Overview.BucketProblemTitle);
        Assert.Contains("failed 3s ago: name resolution failed.", vm.Overview.BucketProblemMessage);
        Assert.Contains("Last command poll failed: timeout.", vm.Overview.BucketProblemMessage);
        Assert.Contains("stay queued", vm.Overview.BucketProblemMessage);

        _agent.NextSnapshot = new AgentSnapshot { CmdError = "timeout" };
        await vm.RefreshAsync();
        Assert.Equal("Command poll failing", vm.Overview.BucketStateText);
        Assert.Equal(UiSeverity.Warning, vm.Overview.BucketSeverity);

        _agent.NextSnapshot = new AgentSnapshot();
        await vm.RefreshAsync();
        Assert.Equal("Not checked yet", vm.Overview.BucketStateText);
        Assert.False(vm.Overview.HasBucketProblem);
        Assert.Equal("", vm.Overview.BucketProblemMessage);
    }

    [Fact]
    public async Task Collector_pages_get_status_reason_severity_and_queue_share()
    {
        _host.Infos.Add(new CollectorInfo { Name = "files", Enabled = true, Running = true, LastRunAt = Now, Detail = "scanning D:\\ 1200 files" });
        _host.Infos.Add(new CollectorInfo { Name = "notifications", Enabled = true, Running = true, LastRunAt = Now, LastError = "cannot read C:\\wpndatabase.db" });
        _host.Infos.Add(new CollectorInfo { Name = "screenshots", Enabled = true, Running = false });
        _host.Infos.Add(new CollectorInfo { Name = "usage", Enabled = false });
        _agent.NextSnapshot = new AgentSnapshot { ByCollector = new Dictionary<string, QueueStats> { ["files"] = new(3, 12 * 1024 * 1024, 0) } };
        var vm = Create();
        await vm.StartAsync();

        Assert.Equal("Working", vm.FilesRow.StatusLabel);
        Assert.Equal(UiSeverity.Success, vm.FilesRow.Severity);
        Assert.Equal("Scanning D:\\ 1200 files.", vm.FilesRow.StatusReason);
        Assert.Equal("3 objects (12.0 MB) waiting to upload", vm.FilesRow.QueueContributionText);
        Assert.False(vm.FilesRow.HasProblem);
        Assert.NotEmpty(vm.FilesRow.Description);
        Assert.Equal("\uE8B7", vm.FilesRow.Glyph);

        Assert.Equal("Error", vm.NotificationsRow.StatusLabel);
        Assert.True(vm.NotificationsRow.HasProblem);
        Assert.Equal("Notifications has a problem", vm.NotificationsRow.ProblemTitle);
        Assert.Equal("Cannot read C:\\wpndatabase.db.", vm.NotificationsRow.StatusReason);
        Assert.Equal(UiSeverity.Error, vm.NotificationsRow.Severity);

        Assert.Equal("Needs attention", vm.ScreenshotsRow.StatusLabel);
        Assert.Equal("Not running.", vm.ScreenshotsRow.StatusReason);
        Assert.Equal(UiSeverity.Warning, vm.ScreenshotsRow.Severity);

        Assert.Equal("Off", vm.UsageRow.StatusLabel);
        Assert.Equal("Turned off. Nothing is captured.", vm.UsageRow.StatusReason);
        Assert.False(vm.UsageRow.HasProblem);
        Assert.Equal("Nothing waiting to upload", vm.UsageRow.QueueContributionText);

        Assert.Equal("Not available in this build.", vm.LineRow.StatusReason);
        Assert.True(vm.Overview.HasCollectorProblems);
        Assert.Equal("2 collectors need attention: Screenshots, Notifications.", vm.Overview.CollectorProblemsText);

        vm.IsRunning = false;
        await vm.LastHostWork;
        await vm.RefreshAsync();
        Assert.Equal("Paused", vm.FilesRow.StatusLabel);
        Assert.False(vm.NotificationsRow.HasProblem); // paused hides problems: nothing is meant to run
    }

    [Fact]
    public async Task Telegram_page_shows_per_chat_progress_and_phone_only_note()
    {
        _host.Infos.Add(new CollectorInfo { Name = "telegram", Enabled = true, Running = true, LastRunAt = Now, Detail = "chats 12/40, 18240 messages, 3 phone-only (secret)" });
        var vm = Create();
        await vm.StartAsync();
        var c = vm.Conversation;
        Assert.True(c.HasTelegramProgress);
        Assert.Equal("12 of 40 chats complete", c.TelegramChatsText);
        Assert.Equal("18,240 messages so far", c.TelegramMessagesText);
        Assert.Equal(30, c.TelegramPercent);
        Assert.StartsWith("3 secret chats are on the phone only.", c.PhoneOnlyText);

        _host.Infos[0] = _host.Infos[0] with { Detail = null, LastError = "Telegram Desktop local passcode required (enter it once in the IVY window)" };
        await vm.RefreshAsync();
        Assert.False(c.HasTelegramProgress);
        Assert.True(c.TelegramNeedsPasscode);
        Assert.False(c.TelegramHasOtherError); // the passcode bar covers it
        Assert.Equal("12 of 40 chats complete", c.TelegramChatsText); // last known numbers kept, not shown as current
        Assert.Same(BrandIcons.Telegram.PathData, vm.TelegramBrand.PathData);

        _host.Infos[0] = _host.Infos[0] with { LastError = "session invalid: AUTH_KEY_UNREGISTERED" };
        await vm.RefreshAsync();
        Assert.True(c.TelegramHasOtherError);
        Assert.False(c.TelegramNeedsPasscode);
    }

    [Theory]
    [InlineData("chats 0/0, 0 messages", 0, 0, 0L, 0)]
    [InlineData("chats 5/9, 120 messages", 5, 9, 120L, 0)]
    [InlineData("chats 9/9, 99999999999 messages, 1 phone-only (secret)", 9, 9, 99999999999L, 1)]
    public void Telegram_progress_parses(string detail, int done, int total, long msgs, int phone)
    {
        Assert.Equal(new TelegramProgress(done, total, msgs, phone), TelegramProgress.TryParse(detail));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("flood-wait until 2026-10-10T12:00:00.000Z")]
    [InlineData("chats 10/9, 1 messages")]
    [InlineData("chats a/9, 1 messages")]
    public void Non_progress_details_do_not_parse(string? detail) => Assert.Null(TelegramProgress.TryParse(detail));

    [Fact]
    public async Task Line_page_shows_probe_summary_and_coverage_note()
    {
        _host.Infos.Add(new CollectorInfo { Name = "line", Enabled = true, Running = true, LastRunAt = Now, Detail = @"Probe complete: 412 files, 6 databases, 0 readable; report C:\IVY\line-probe.json" });
        var vm = Create();
        Assert.Equal(ConversationViewModel.NoProbeYet, vm.Conversation.LineProbeSummary);
        await vm.StartAsync();
        Assert.Equal("Probe complete: 412 files, 6 databases, 0 readable.", vm.Conversation.LineProbeSummary);
        Assert.Contains("Always partial", ConversationViewModel.LineCoverageNote);

        // A later ordinary tick replaces the detail; the last summary stays.
        _host.Infos[0] = _host.Infos[0] with { Detail = "ok partial: 3 chats, 0 new this tick (coverage partial, mirror of the phone)" };
        await vm.RefreshAsync();
        Assert.Equal("Probe complete: 412 files, 6 databases, 0 readable.", vm.Conversation.LineProbeSummary);
        Assert.Null(LineProbe.Summary("LINE for Windows not found"));
    }

    [Fact]
    public async Task Transfers_page_lists_command_outcomes_from_history_and_live()
    {
        _agent.History.AddRange(new[]
        {
            new ActivityEntry(1, "2026-10-10T11:00:00.000Z", "commands", ActivityEvents.CommandReceived, "file_request 0123456789abcdef"),
            new ActivityEntry(2, "2026-10-10T11:00:02.000Z", "commands", ActivityEvents.CommandCompleted, "0123456789abcdef uploaded"),
            new ActivityEntry(3, "2026-10-10T11:01:00.000Z", "commands", ActivityEvents.CommandRejected, "cmd/dev/abc: signature invalid"),
            new ActivityEntry(4, "2026-10-10T11:01:00.000Z", "files", ActivityEvents.Queued, "up/x"),
        });
        var vm = Create();
        await vm.StartAsync();
        Assert.Equal(2, vm.Commands.Items.Count);
        var rejected = vm.Commands.Items[0];
        Assert.Equal("Rejected command", rejected.TypeText);
        Assert.Equal("Rejected: signature invalid", rejected.StatusText);
        Assert.Equal(UiSeverity.Error, rejected.Severity);
        var file = vm.Commands.Items[1];
        Assert.Equal("File request", file.TypeText);
        Assert.Equal("01234567", file.ShortId);
        Assert.Equal("Uploaded to the Mac", file.StatusText);
        Assert.Equal(UiSeverity.Success, file.Severity);

        _agent.RaiseActivity(new ActivityEntry(5, "2026-10-10T12:00:00.000Z", "commands", ActivityEvents.CommandReceived, "rescan feedface00"));
        Assert.Equal("Rescan", vm.Commands.Items[0].TypeText);
        Assert.Equal("In progress", vm.Commands.Items[0].StatusText);
        _agent.RaiseActivity(new ActivityEntry(6, "2026-10-10T12:00:01.000Z", "commands", ActivityEvents.CommandCompleted, "feedface00 not_found"));
        Assert.Equal("File not found", vm.Commands.Items[0].StatusText);
        Assert.Equal(UiSeverity.Warning, vm.Commands.Items[0].Severity);
        Assert.Equal(3, vm.Commands.Items.Count);
    }

    [Fact]
    public void Command_history_is_bounded_and_ignores_malformed_lines()
    {
        var h = new CommandHistory(capacity: 3);
        var t = DateTimeOffset.Parse("2026-10-10T12:00:00Z");
        for (var i = 0; i < 5; i++) h.Observe(new FeedEntry(i, t, "commands", ActivityEvents.CommandReceived, "rescan id" + i));
        h.Observe(new FeedEntry(9, t, "commands", ActivityEvents.CommandReceived, "nospace"));
        h.Observe(new FeedEntry(10, t, "commands", ActivityEvents.CommandReceived, "rescan id4")); // duplicate
        Assert.Equal(new[] { "id4", "id3", "id2" }, h.Items.Select(i => i.Id));
        h.Observe(new FeedEntry(11, t, "commands", ActivityEvents.CommandCompleted, "lost done"));
        Assert.Equal("Command", h.Items[0].TypeText); // completion whose receipt is outside the window
        Assert.Equal("Done", h.Items[0].StatusText);
    }

    [Fact]
    public async Task Files_page_exclusions_load_and_apply()
    {
        _host.Settings = new CollectorSettings { FileExclusions = new[] { "node_modules", "?:/Windows" } };
        var vm = Create();
        await vm.StartAsync();
        Assert.Equal(new[] { "node_modules", "?:/Windows" }, vm.Settings.FileExclusions.Items);
        Assert.Empty(_host.Applied);

        vm.Settings.FileExclusions.NewItem = "  *.iso ";
        Assert.True(vm.Settings.FileExclusions.AddNew());
        await vm.Settings.LastApply;
        Assert.Equal(new[] { "node_modules", "?:/Windows", "*.iso" }, _host.Applied[^1].FileExclusions);
        vm.Settings.FileExclusions.Remove("node_modules");
        await vm.Settings.LastApply;
        Assert.Equal(new[] { "?:/Windows", "*.iso" }, _host.Applied[^1].FileExclusions);

        // The stored fallback keeps them too.
        var json = CollectorSettingsCodec.Encode(_host.Applied[^1]);
        Assert.Equal(new[] { "?:/Windows", "*.iso" }, CollectorSettingsCodec.Decode(json)!.FileExclusions);
    }

    [Fact]
    public async Task Settings_page_opens_folders_and_selects_theme()
    {
        var vm = Create();
        await vm.StartAsync();
        vm.OpenDataFolderCommand.Execute(null);
        vm.OpenLogFolderCommand.Execute(null);
        Assert.Equal(new[] { @"C:\Users\b\AppData\Local\IVY", @"C:\Users\b\AppData\Local\IVY\logs" }, _opened);
        vm.Appearance.ThemeIndex = 1;
        await vm.Appearance.LastSave;
        Assert.Equal("light", _agent.Settings[AppearanceViewModel.SettingsKey]);
        vm.Navigation.Select(NavPages.Settings);
        await vm.Navigation.LastSave;
        Assert.Contains("\"settings\"", _agent.Settings[NavigationViewModel.SettingsKey]);

        var reopened = Create();
        await reopened.StartAsync();
        Assert.Equal(NavPages.Settings, reopened.Navigation.SelectedPage);
        Assert.Equal(AppTheme.Light, reopened.Appearance.Theme);
    }

    [Fact]
    public async Task Unpaired_event_from_the_agent_shows_the_pairing_page()
    {
        var ui = new QueueDispatcher();
        var vm = new MainViewModel(_agent, _host, ui, new FakeStartup(), () => Task.FromResult<string?>(null), @"C:IVYIvy.App.exe", "1.2.3", _time);
        await vm.StartAsync();
        ui.Pump();
        Assert.True(vm.SyncNowCommand.CanExecute(null));
        Assert.Equal(1, _host.Starts);

        await Task.Run(() => _agent.RaiseUnpaired()); // the agent raises it on a worker thread
        Assert.False(vm.ShowPairing); // nothing changes until the UI thread runs the posted work
        ui.Pump();

        Assert.True(vm.ShowPairing);
        Assert.False(vm.ShowMain);
        Assert.False(vm.ShowLocked);
        Assert.False(vm.Pairing.Completed);
        Assert.True(vm.Pairing.CanEdit);
        Assert.Equal(PairingViewModel.DefaultStatus, vm.Pairing.Status);
        Assert.Equal("not paired", vm.FingerprintText);
        Assert.Equal("not paired", vm.Overview.MacFingerprint);
        Assert.False(vm.SyncNowCommand.CanExecute(null));
    }

    [Fact]
    public async Task Paired_start_waits_for_the_first_poll_before_starting_the_host()
    {
        var firstPoll = new TaskCompletionSource();
        _agent.FirstPoll = firstPoll.Task;
        var vm = Create();
        var start = vm.StartAsync();
        await Task.Delay(100);
        Assert.False(start.IsCompleted);
        Assert.Equal(0, _host.Starts);

        firstPoll.SetResult();
        await start;
        Assert.Equal(1, _host.Starts);
        Assert.False(vm.ShowPairing);
    }

    [Fact]
    public async Task An_unpair_handled_by_the_first_poll_means_the_host_is_never_started()
    {
        var firstPoll = new TaskCompletionSource();
        _agent.FirstPoll = firstPoll.Task;
        var vm = Create();
        var start = vm.StartAsync();
        await Task.Delay(100);
        Assert.Equal(0, _host.Starts);

        _agent.IsPaired = false; // the Mac's unpair command ran during the first poll
        _agent.DeviceFingerprint = null;
        _agent.MacFingerprint = null;
        firstPoll.SetResult();
        await start;

        Assert.Equal(0, _host.Starts);
        Assert.True(vm.ShowPairing);
        Assert.False(vm.ShowMain);
        Assert.False(vm.SyncNowCommand.CanExecute(null));
    }

    /// <summary>Holds posted UI work until <see cref="Pump"/>, like a real dispatcher queue.</summary>
    private sealed class QueueDispatcher : IUiDispatcher
    {
        private readonly System.Collections.Concurrent.ConcurrentQueue<Action> _q = new();
        public bool Post(Action action) { _q.Enqueue(action); return true; }
        public void Pump() { while (_q.TryDequeue(out var a)) a(); }
    }
}

public class PairingErrorTests
{
    private readonly FakeAgent _agent = new();

    [Theory]
    [InlineData("not an IVY pairing string", "That is not a complete IVY pairing string.")]
    [InlineData("malformed pairing string", "That is not a complete IVY pairing string.")]
    [InlineData("pairing code expired", "This pairing string has expired.")]
    [InlineData("pairing bootstrap not found (already used or not yet written)", "This pairing string was already used, or the Mac has not finished preparing it.")]
    [InlineData("pairing code is for role 'android', this device is 'windows'", "This pairing string is for a different kind of device.")]
    [InlineData("unsupported pairing version 2", "This pairing string comes from a different IVY version.")]
    [InlineData("bootstrap authentication failed", "The pairing string does not match what the Mac prepared.")]
    [InlineData("bootstrap up-bucket does not match the pairing code", "The pairing string does not match what the Mac prepared.")]
    public void Pairing_exceptions_map_to_a_message_and_a_hint(string reason, string message)
    {
        var e = PairingErrors.Describe(new PairingException(reason));
        Assert.Equal(message, e.Message);
        Assert.False(string.IsNullOrWhiteSpace(e.Hint));
        Assert.EndsWith(".", e.Hint);
    }

    [Fact]
    public void Network_failures_say_to_check_the_connection()
    {
        var e = PairingErrors.Describe(new HttpRequestException("No such host is known."));
        Assert.Equal("Could not reach the IVY bucket.", e.Message);
        Assert.Contains("internet connection", e.Hint);
        Assert.Equal("Could not reach the IVY bucket.", PairingErrors.Describe(new TaskCanceledException()).Message);
        Assert.StartsWith("Pairing failed: InvalidOperationException", PairingErrors.Describe(new InvalidOperationException("x")).Message);
        Assert.Equal("Pairing failed: something new", PairingErrors.Describe(new PairingException("something new")).Message);
    }

    [Fact]
    public async Task Pairing_page_shows_the_error_inline_and_clears_it_on_retry()
    {
        var calls = 0;
        _agent.OnPair = _ => ++calls == 1 ? throw new PairingException("pairing code expired") : new PairingResult("d", "p", "AAAA", "BBBB");
        var vm = new PairingViewModel(_agent, ImmediateDispatcher.Instance);

        await vm.PairAsync(); // empty
        Assert.True(vm.HasError);
        Assert.Equal("Paste the pairing string first.", vm.ErrorText);

        vm.PairingText = "IVYPAIR1.old";
        await vm.PairAsync();
        Assert.Equal("This pairing string has expired.", vm.ErrorText);
        Assert.Contains("add the Windows device again", vm.ErrorHint);
        Assert.Equal("Pairing failed: pairing code expired", vm.Status);
        Assert.True(vm.CanEdit);

        await vm.PairAsync();
        Assert.False(vm.HasError);
        Assert.Equal("", vm.ErrorHint);
        Assert.True(vm.Completed);
    }
}

public class UnpairEndToEndTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task Reset_forgets_the_keys_stops_the_workers_and_allows_pairing_again()
    {
        var r2 = new MemoryR2();
        await using var agent = new VaultAgent(new VaultAgentOptions { DataDirectory = Path.Combine(_dir.Path, "data") },
            new FileKeyStore(Path.Combine(_dir.Path, "keys")), r2);
        await agent.StartAsync();
        using var view = new VaultAgentView(agent);
        var host = new StoredCollectorHostView(agent.Collectors, agent.Db.GetSetting, agent.Db.SetSetting);
        var vm = new MainViewModel(view, host, ImmediateDispatcher.Instance, new FakeStartup(), () => Task.FromResult<string?>(null), @"C:\Ivy.App.exe", "0.1.0");
        await vm.StartAsync();

        var (code, _) = r2.MacPrepares(DateTimeOffset.UtcNow);
        vm.Pairing.PairingText = code;
        await vm.Pairing.PairAsync();
        await vm.LastHostWork;
        vm.Pairing.ContinueCommand.Execute(null);
        Assert.True(view.IsPaired);
        view.UploadsPaused = true; // hold the queue still while the workers run
        agent.Queue.EnqueueCiphertext("up/meta/kept", Kind.FileMeta, new byte[10], "files");

        await agent.ResetPairingAsync(); // what the Mac's unpair command runs
        view.RefreshPairedState(); // the view does this when the agent raises Unpaired
        Assert.False(view.IsPaired);
        Assert.False(agent.IsRunning);
        Assert.Null(agent.Uploader);
        Assert.Null(agent.Sink);
        Assert.Null(view.MacFingerprint);
        Assert.False(agent.Keys.HasSecretKey);
        Assert.Equal(0, view.Snapshot().For("files").Objects); // the reset empties the queue
        Assert.Contains(agent.Activity.Recent(10), e => e.Event == ActivityEvents.Unpaired);
        view.UploadsPaused = true; // detached from the old uploader: ignored, not thrown

        var (code2, mac2) = r2.MacPrepares(DateTimeOffset.UtcNow);
        vm.Pairing.PairingText = code2;
        await vm.Pairing.PairAsync();
        await vm.LastHostWork;
        Assert.True(vm.Pairing.Completed, vm.Pairing.Status);
        Assert.Equal(mac2, vm.Pairing.MacFingerprint);
        Assert.True(view.IsPaired);
        Assert.True(agent.IsRunning);
    }
}
