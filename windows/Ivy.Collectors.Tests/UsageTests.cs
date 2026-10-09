using System.Text.Json.Nodes;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Host;
using Ivy.Collectors.Tests.Support;
using Ivy.Collectors.Usage;
using Ivy.Core.Protocol;

namespace Ivy.Collectors.Tests;

public class UsageTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly FakeProbe _probe = new();
    private readonly DateTimeOffset _t0;

    public UsageTests()
    {
        _env = new TestEnv(_dir);
        _t0 = _env.Time.GetUtcNow();
    }

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private UsageCollector NewCollector(JsonObject? settings = null, Common.CollectorContext? ctx = null)
    {
        var c = new UsageCollector(ctx ?? _env.Context, _probe);
        if (settings is not null) c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), settings));
        return c;
    }

    private static readonly ForegroundSample Code = new("Visual Studio Code", "Code.exe", "main.rs - ivy");
    private static readonly ForegroundSample Chrome = new("Google Chrome", "chrome.exe", "Inbox - Gmail");

    private async Task Sample(UsageCollector c, ForegroundSample? s, double advanceSeconds = 30, double idleSeconds = 0)
    {
        _env.Time.Advance(TimeSpan.FromSeconds(advanceSeconds));
        _probe.Current = s;
        _probe.Idle = TimeSpan.FromSeconds(idleSeconds);
        await c.TickAsync(default);
    }

    private string At(double seconds) => IvyTime.Format(_t0.AddSeconds(seconds));

    [Fact]
    public async Task Consecutive_samples_coalesce_and_a_change_closes_the_event()
    {
        var c = NewCollector();
        await Sample(c, Code, 0);       // t=0
        await Sample(c, Code);          // 30
        await Sample(c, Code);          // 60
        Assert.Empty(_env.Sink.Records);
        await Sample(c, Chrome);        // 90: switch
        var e = Assert.Single(_env.Sink.Of(Kind.UsageEvent));
        Assert.Equal("Visual Studio Code", e.Str("app"));
        Assert.Equal("Code.exe", e.Str("exe"));
        Assert.Equal("main.rs - ivy", e.Str("title"));
        Assert.Equal(At(0), e.Str("startedAt"));
        Assert.Equal(At(90), e.Str("endedAt"));
        Assert.Equal(At(0), e.Str("eventTime"));
        Assert.Equal("usage", e.Collector);

        // Same exe, different title is a new event.
        await Sample(c, Chrome with { Title = "Calendar" });   // 120
        Assert.Equal(2, _env.Sink.Of(Kind.UsageEvent).Count);
        var e2 = _env.Sink.Of(Kind.UsageEvent)[1];
        Assert.Equal((At(90), At(120)), (e2.Str("startedAt"), e2.Str("endedAt")));

        // No foreground window closes the event; stop flushes nothing more.
        await Sample(c, null);                                  // 150
        Assert.Equal(3, _env.Sink.Of(Kind.UsageEvent).Count);
        await c.StopAsync();
        Assert.Equal(3, _env.Sink.Of(Kind.UsageEvent).Count);
    }

    [Fact]
    public async Task Long_sessions_flush_every_ten_minutes()
    {
        var c = NewCollector();
        await Sample(c, Code, 0);
        for (var i = 0; i < 25; i++) await Sample(c, Code);    // 12.5 minutes
        var e = Assert.Single(_env.Sink.Of(Kind.UsageEvent));
        Assert.Equal((At(0), At(600)), (e.Str("startedAt"), e.Str("endedAt")));
        await c.StopAsync();                                    // flushes the continuation
        var e2 = _env.Sink.Of(Kind.UsageEvent)[1];
        Assert.Equal((At(600), At(750)), (e2.Str("startedAt"), e2.Str("endedAt")));
    }

    [Fact]
    public async Task Idle_for_five_minutes_closes_the_event_at_the_last_input()
    {
        var c = NewCollector();
        await Sample(c, Code, 0);
        await Sample(c, Code);                          // 30
        await Sample(c, Code, 30, idleSeconds: 200);    // 60: idle 200 s < 300 s, still open
        Assert.Empty(_env.Sink.Records);
        await Sample(c, Code, 270, idleSeconds: 330);   // 330: idle since t=0
        var e = Assert.Single(_env.Sink.Of(Kind.UsageEvent));
        Assert.Equal((At(0), At(0)), (e.Str("startedAt"), e.Str("endedAt")));

        // Still idle: nothing opens. Activity resumes: a new event starts.
        await Sample(c, Code, 30, idleSeconds: 360);
        Assert.Null(c.Current);
        await Sample(c, Code, 30, idleSeconds: 1);
        Assert.Equal(At(390), IvyTime.Format(c.Current!.StartedAt));
    }

    [Fact]
    public async Task Idle_end_uses_the_last_input_time()
    {
        var c = NewCollector();
        await Sample(c, Code, 0);
        await Sample(c, Code, 120, idleSeconds: 10);     // input at 110
        await Sample(c, Code, 300, idleSeconds: 310);    // 420 - 310 = 110
        Assert.Equal(At(110), Assert.Single(_env.Sink.Of(Kind.UsageEvent)).Str("endedAt"));
    }

    [Fact]
    public async Task Title_exclusions_record_no_title_and_coalesce_by_exe()
    {
        var c = NewCollector(new JsonObject { ["titleExclusions"] = new JsonArray("Incognito", "*bank*", "keepass*.exe") });
        await Sample(c, new ForegroundSample("Google Chrome", "chrome.exe", "New Incognito tab"), 0);
        await Sample(c, new ForegroundSample("Google Chrome", "chrome.exe", "Secret search - Incognito"));
        await Sample(c, new ForegroundSample("Google Chrome", "chrome.exe", "My BANK - accounts"));
        await Sample(c, new ForegroundSample("KeePassXC", "KeePassXC.exe", "passwords.kdbx"));
        await Sample(c, Code);
        var events = _env.Sink.Of(Kind.UsageEvent);
        Assert.Equal(2, events.Count);
        Assert.False(events[0].Has("title"));                   // excluded → recorded as absent
        Assert.Equal("chrome.exe", events[0].Str("exe"));
        Assert.Equal((At(0), At(90)), (events[0].Str("startedAt"), events[0].Str("endedAt")));
        Assert.False(events[1].Has("title"));                   // exe glob
        Assert.Equal("KeePassXC", events[1].Str("app"));
    }

    [Fact]
    public async Task Title_capture_can_be_turned_off()
    {
        var c = NewCollector(new JsonObject { ["captureTitles"] = false });
        await Sample(c, Code, 0);
        await Sample(c, Code with { Title = "other.rs - ivy" });  // same exe, titles not captured → same event
        await Sample(c, Chrome);
        var e = Assert.Single(_env.Sink.Of(Kind.UsageEvent));
        Assert.False(e.Has("title"));
        Assert.Equal((At(0), At(60)), (e.Str("startedAt"), e.Str("endedAt")));
    }

    [Fact]
    public async Task Open_event_survives_a_crash()
    {
        var c = NewCollector();
        await Sample(c, Code, 0);
        await Sample(c, Code);
        await Sample(c, Code);                                   // last seen at 60, then the process dies
        var c2 = NewCollector(ctx: _env.Restart());
        _env.Time.Advance(TimeSpan.FromHours(1));
        await c2.StartAsync(default);
        var e = Assert.Single(_env.Sink.Of(Kind.UsageEvent));
        Assert.Equal((At(0), At(60)), (e.Str("startedAt"), e.Str("endedAt")));
        await c2.StartAsync(default);                            // not emitted twice
        Assert.Single(_env.Sink.Of(Kind.UsageEvent));
    }

    [Fact]
    public void Coalescer_is_pure()
    {
        var co = new UsageCoalescer(TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(10));
        var t = _t0;
        Assert.Empty(co.Observe(t, "A", "a.exe", "x", TimeSpan.Zero));
        Assert.Empty(co.Observe(t.AddSeconds(30), "A", "A.EXE", "x", TimeSpan.Zero));   // exe compare is case-insensitive
        var closed = co.Observe(t.AddSeconds(60), "B", "b.exe", null, TimeSpan.Zero);
        Assert.Equal(new UsageInterval("A", "a.exe", "x", t, t.AddSeconds(60)), Assert.Single(closed));
        Assert.Equal(new UsageInterval("B", "b.exe", null, t.AddSeconds(60), t.AddSeconds(90)), co.Flush(t.AddSeconds(90)));
        Assert.Null(co.Flush(t.AddSeconds(100)));
    }

    [Fact]
    public void Title_filter_rules()
    {
        var f = new TitleFilter(true, new[] { "secret", "*.kdbx*", "C:\\Private\\*" });
        Assert.Null(f.Apply("My SECRET doc", "word.exe"));
        Assert.Null(f.Apply("db.kdbx - KeePass", "keepass.exe"));
        Assert.Null(f.Apply("anything", "C:\\Private\\tool.exe"));
        Assert.Equal("Inbox", f.Apply("Inbox", "outlook.exe"));
        Assert.Null(f.Apply("   ", "x.exe"));
        Assert.Null(new TitleFilter(false, Array.Empty<string>()).Apply("Inbox", "outlook.exe"));
    }

    [Fact]
    public void Collector_without_a_probe_is_unsupported()
    {
        Assert.NotNull(new UsageCollector(_env.Context, probe: null).UnsupportedReason);
        Assert.Null(NewCollector().UnsupportedReason);
        Assert.Throws<ArgumentException>(() => NewCollector(new JsonObject { ["sampleSeconds"] = 0 }));
    }
}
