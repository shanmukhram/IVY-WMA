using System.Diagnostics;
using Ivy.App.Core.Diagnostics;
using Ivy.App.Core.Hosting;
using Ivy.App.Core.ViewModels;
using Ivy.Core.Agent;
using Ivy.Core.KeyStore;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;

namespace Ivy.App.Core.Tests;

public class HangReportTests
{
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-10-10T12:00:00Z");

    [Fact]
    public void Breadcrumbs_nest_restore_and_describe_with_elapsed_time()
    {
        var tid = Environment.CurrentManagedThreadId;
        Assert.Null(UiBreadcrumb.Of(tid));
        Assert.Equal("idle", UiBreadcrumb.Describe(null, Stopwatch.GetTimestamp()));
        using (UiBreadcrumb.Enter("OnTick"))
        {
            using (UiBreadcrumb.Enter("FlushFeed batch=12"))
            {
                var c = UiBreadcrumb.Of(tid)!;
                Assert.Equal("FlushFeed batch=12", c.What);
                var later = c.StartTimestamp + Stopwatch.Frequency * 5; // five seconds on
                Assert.Equal("FlushFeed batch=12 (running 5000 ms) inside OnTick", UiBreadcrumb.Describe(c, later));
                Assert.Contains(UiBreadcrumb.All(), x => x.ThreadId == tid);
            }
            Assert.Equal("OnTick", UiBreadcrumb.Of(tid)!.What);
        }
        Assert.Null(UiBreadcrumb.Of(tid));
    }

    [Fact]
    public void Breadcrumbs_of_other_threads_do_not_clobber_this_one()
    {
        var tid = Environment.CurrentManagedThreadId;
        using (UiBreadcrumb.Enter("Apply rows=6"))
        {
            var other = new Thread(() =>
            {
                using (UiBreadcrumb.Enter("tray WndProc msg=0x8001")) Assert.Equal("Apply rows=6", UiBreadcrumb.Of(tid)!.What);
            });
            other.Start();
            other.Join();
            Assert.Equal("Apply rows=6", UiBreadcrumb.Of(tid)!.What);
        }
    }

    [Fact]
    public void Heartbeat_and_incident_lines_have_timings_and_identifiers_only()
    {
        Assert.Equal("heartbeat: ui=alive feed=580 window=visible last_tick=2026-10-10T11:59:59.000Z (1 s ago)",
            HangReport.Heartbeat(true, new UiSample(580, true, T0.AddSeconds(-1)), T0));
        Assert.Equal("heartbeat: ui=unresponsive feed=3 window=hidden last_tick=never",
            HangReport.Heartbeat(false, new UiSample(3, false, null), T0));
        Assert.Equal("heartbeat: ui=alive feed=? window=? last_tick=never", HangReport.Heartbeat(true, null, T0));
        Assert.Equal("UI unresponsive since 2026-10-10T12:00:00.000Z (5000 ms); ui: FlushFeed batch=12 (running 5100 ms)",
            HangReport.Unresponsive(T0, T0.AddSeconds(5), "FlushFeed batch=12 (running 5100 ms)"));
        Assert.Equal("UI unresponsive since 2026-10-10T12:00:00.000Z (6000 ms); ui: idle; other threads: ShowMenu (running 6000 ms)",
            HangReport.Unresponsive(T0, T0.AddSeconds(6), "idle", new[] { "ShowMenu (running 6000 ms)" }));
        Assert.Equal("UI recovered after 7300 ms", HangReport.Recovered(TimeSpan.FromMilliseconds(7300)));
        Assert.Equal("ivy-app-hang-20261010T120000Z.dmp", HangReport.DumpFileName(T0));
        Assert.Equal("slow FlushFeed batch=40: 75 ms", HangReport.Slow("FlushFeed batch=40", TimeSpan.FromMilliseconds(75.6)));
        Assert.Equal("session_lock", HangReport.SessionChange(7));
        Assert.Equal("code_99", HangReport.SessionChange(99));
    }
}

public class UiWatchdogMonitorTests
{
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-10-10T12:00:00Z");

    [Fact]
    public void Responsive_ui_gets_one_heartbeat_in_flight_and_a_line_per_minute()
    {
        var m = new UiWatchdogMonitor();
        var s = m.Step(T0, () => "x");
        Assert.True(s.PostHeartbeat);
        Assert.Null(s.Warning);
        Assert.Null(s.Info);
        Assert.False(m.Step(T0.AddSeconds(1), () => "x").PostHeartbeat); // still in flight
        m.Acknowledge(T0.AddSeconds(1), new UiSample(10, true, T0.AddSeconds(1)));
        DateTimeOffset now = T0.AddSeconds(2);
        string? line = null;
        for (var i = 0; i < 60; i++, now = now.AddSeconds(1))
        {
            var step = m.Step(now, () => "x");
            Assert.True(step.PostHeartbeat);
            Assert.False(step.WriteDump);
            m.Acknowledge(now, new UiSample(10 + i, true, now));
            if (step.Info is not null) line = step.Info;
        }
        Assert.NotNull(line);
        Assert.StartsWith("heartbeat: ui=alive feed=", line);
    }

    [Fact]
    public void Unanswered_heartbeat_is_one_incident_with_one_dump_then_recovery()
    {
        var m = new UiWatchdogMonitor();
        Assert.True(m.Step(T0, () => "x").PostHeartbeat);
        for (var i = 1; i < 5; i++) Assert.Null(m.Step(T0.AddSeconds(i), () => "x").Warning);
        var hit = m.Step(T0.AddSeconds(5), () => "FlushFeed batch=3 (running 5000 ms)", () => new[] { "ShowMenu (running 10 ms)" });
        Assert.True(hit.WriteDump);
        Assert.Equal("UI unresponsive since 2026-10-10T12:00:00.000Z (5000 ms); ui: FlushFeed batch=3 (running 5000 ms); other threads: ShowMenu (running 10 ms)", hit.Warning);
        Assert.True(m.InIncident);
        for (var i = 6; i < 20; i++)
        {
            var s = m.Step(T0.AddSeconds(i), () => throw new InvalidOperationException("not read again"));
            Assert.False(s.WriteDump);
            Assert.Null(s.Warning);
            Assert.False(s.PostHeartbeat);
        }
        m.Acknowledge(T0.AddSeconds(20), new UiSample(1, true, null));
        Assert.False(m.InIncident);
        var after = m.Step(T0.AddSeconds(21), () => "x");
        Assert.Equal("UI recovered after 20000 ms", after.Info);
        Assert.True(after.PostHeartbeat);
    }

    [Fact]
    public void Refused_post_is_retried()
    {
        var m = new UiWatchdogMonitor();
        Assert.True(m.Step(T0, () => "x").PostHeartbeat);
        m.PostFailed();
        Assert.True(m.Step(T0.AddSeconds(1), () => "x").PostHeartbeat);
    }
}

public class BackgroundWorkTests
{
    [Fact]
    public async Task Runs_in_order_off_the_calling_thread_and_surfaces_errors()
    {
        var work = new BackgroundWork();
        var order = new List<int>();
        var gate = new TaskCompletionSource();
        var first = work.Run(async () => { await gate.Task; lock (order) order.Add(1); });
        var second = work.Run(() => { lock (order) order.Add(2); });
        var failing = work.Run(() => throw new InvalidOperationException("boom"));
        var third = work.Run(() => { lock (order) order.Add(3); });
        gate.SetResult();
        await first;
        await second;
        await Assert.ThrowsAsync<InvalidOperationException>(() => failing);
        await third; // a failure does not stop the queue
        await work.Idle();
        Assert.Equal(new[] { 1, 2, 3 }, order);
    }
}

public class FeedDispatchFailureTests
{
    /// <summary>Refuses posts while <see cref="Refuse"/> is set (DispatcherQueue.TryEnqueue returning false).</summary>
    private sealed class RefusingDispatcher : IUiDispatcher
    {
        public bool Refuse { get; set; } = true;
        public int Refused { get; private set; }
        public List<Action> Posted { get; } = new();
        public bool Post(Action action)
        {
            if (Refuse)
            {
                Refused++;
                return false;
            }
            Posted.Add(action);
            return true;
        }
    }

    private sealed class ListLogger : ILogger
    {
        public List<(LogLevel Level, string Text)> Lines { get; } = new();
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            lock (Lines) Lines.Add((logLevel, formatter(state, exception)));
        }
    }

    [Fact]
    public async Task Refused_flush_clears_the_flag_logs_and_the_next_event_delivers_everything()
    {
        var agent = new FakeAgent();
        var ui = new RefusingDispatcher();
        var log = new ListLogger();
        var vm = new MainViewModel(agent, new FakeHost(), ui, new FakeStartup(), () => Task.FromResult<string?>(null), "x.exe", "1", log: log);
        await vm.StartAsync();
        agent.RaiseActivity(new ActivityEntry(1, "2026-10-10T12:00:00.000Z", "files", "queued", null));
        Assert.Equal(1, ui.Refused);
        Assert.False(vm.FlushScheduled); // before the fix this stayed set and the feed stopped for good
        Assert.Contains(log.Lines, l => l.Level == LogLevel.Warning && l.Text.Contains("feed flush was not accepted", StringComparison.Ordinal));

        ui.Refuse = false;
        agent.RaiseActivity(new ActivityEntry(2, "2026-10-10T12:00:01.000Z", "files", "queued", null));
        Assert.True(vm.FlushScheduled);
        ui.Posted.Single()();
        Assert.False(vm.FlushScheduled);
        Assert.Equal(new long?[] { 2, 1 }, vm.Feed.Items.Select(i => i.ActivityId).ToArray());
    }
}

public class OffUiThreadTests
{
    [Fact]
    public async Task View_model_actions_do_not_run_host_or_agent_writes_on_the_calling_thread()
    {
        var agent = new FakeAgent { IsPaired = true };
        var host = new FakeHost();
        host.Infos.Add(new CollectorInfo { Name = "usage", Enabled = true, Running = true });
        var startup = new FakeStartup();
        var vm = new MainViewModel(agent, host, ImmediateDispatcher.Instance, startup, () => Task.FromResult<string?>(null), @"C:\IVY\Ivy.App.exe", "1");
        await vm.StartAsync();
        await vm.RefreshAsync();
        while (agent.Threads.Calls.TryDequeue(out _)) { }
        while (host.Threads.Calls.TryDequeue(out _)) { }
        while (startup.Threads.Calls.TryDequeue(out _)) { }

        // A dedicated thread stands in for the UI thread.
        var caller = 0;
        var ui = new Thread(() =>
        {
            caller = Environment.CurrentManagedThreadId;
            vm.IsRunning = false;                                          // ApplyRunning
            vm.Collectors.Single(c => c.Name == "usage").Enabled = false;  // SetCollectorEnabled
            vm.Settings.WindowTitleCapture = false;                        // Settings.Apply
            vm.Settings.BandwidthText = "64";
            vm.Settings.ApplyBandwidthCommand.Execute(null);               // ApplyBandwidth
            vm.Settings.RunAtLogin = !vm.Settings.RunAtLogin;              // RunAtLogin
        });
        ui.Start();
        ui.Join();
        await vm.LastHostWork;
        await vm.Settings.LastApply;
        await vm.Settings.LastWork;

        var calls = agent.Threads.Calls.Concat(host.Threads.Calls).Concat(startup.Threads.Calls).ToList();
        var ops = calls.Select(c => c.Op).ToHashSet();
        Assert.Contains("agent.UploadsPaused", ops);
        Assert.Contains("host.PauseAsync", ops);
        Assert.Contains("host.SetEnabledAsync", ops);
        Assert.Contains("host.ApplySettingsAsync", ops);
        Assert.Contains("agent.BandwidthBytesPerSecond", ops);
        Assert.Contains("agent.SetSetting", ops);
        Assert.Contains(calls, c => c.Op.StartsWith("startup.", StringComparison.Ordinal));
        Assert.All(calls, c => Assert.NotEqual(caller, c.Thread));
        Assert.Equal(64 * 1024, agent.BandwidthBytesPerSecond);
        Assert.Equal("current: 64.0 KB/s", vm.Settings.BandwidthStatus);
        Assert.Equal("Paused", vm.RunStateText);
    }
}

public class PairedStateCacheTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task Paired_state_is_read_once_and_refreshed_after_pairing_only()
    {
        var r2 = new MemoryR2();
        var keys = new FileKeyStore(Path.Combine(_dir.Path, "keys"));
        await using var agent = new VaultAgent(new VaultAgentOptions { DataDirectory = Path.Combine(_dir.Path, "data") }, keys, r2);
        await agent.StartAsync();
        using var view = new VaultAgentView(agent);
        Assert.False(view.IsPaired);
        Assert.Null(view.MacFingerprint);

        var (code, macFp) = r2.MacPrepares(DateTimeOffset.UtcNow);
        await view.PairAsync(code);
        Assert.True(view.IsPaired);
        Assert.Equal(macFp, view.MacFingerprint);

        // The cache, not the key store, answers the UI: forgetting the keys behind its back does not change it...
        keys.Clear();
        Assert.True(view.IsPaired);
        // ...until it is refreshed (startup, after a pairing attempt).
        view.RefreshPairedState();
        Assert.False(view.IsPaired);

        // A fresh view (next startup) reads the stored state once.
        using var again = new VaultAgentView(agent);
        Assert.False(again.IsPaired);
    }
}
