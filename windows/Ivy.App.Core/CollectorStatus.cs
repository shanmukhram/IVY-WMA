namespace Ivy.App.Core;

/// <summary>Status dot: green working, amber stale (no run in more than two intervals, or not running), red error, grey off.</summary>
public enum CollectorStatus { Off, Paused, Ok, Stale, Error }

public static class CollectorNames
{
    public const string Files = "files";
    public const string Screenshots = "screenshots";
    public const string Usage = "usage";
    public const string Notifications = "notifications";

    /// <summary>Row order in the window (PRD "App UI").</summary>
    public static readonly IReadOnlyList<string> All = new[] { Files, Screenshots, Usage, Notifications };

    public static string Display(string name) => name switch
    {
        Files => "Files",
        Screenshots => "Screenshots",
        Usage => "App usage",
        Notifications => "Notifications",
        _ => name,
    };

    /// <summary>
    /// Expected run interval when the collector host does not report one. Used only for the stale rule.
    /// usage samples every 30 s (WC4); the others are event driven with a periodic heartbeat/rescan.
    /// </summary>
    public static TimeSpan DefaultInterval(string name) => name switch
    {
        Usage => TimeSpan.FromSeconds(30),
        Screenshots => TimeSpan.FromMinutes(5),
        Notifications => TimeSpan.FromMinutes(5),
        Files => TimeSpan.FromHours(1),
        _ => TimeSpan.FromMinutes(5),
    };
}

public static class StatusRules
{
    public const string Green = "#3ECF8E";
    public const string Amber = "#F5A623";
    public const string Red = "#E5484D";
    public const string Grey = "#6B6B6B";

    /// <summary>
    /// Floor for the stale rule. Some collectors tick every second (file and screenshot queues); a single
    /// slow tick (a thumbnail batch) must not flash amber, so "stale" means at least 2 x 15 s without a run.
    /// </summary>
    public static readonly TimeSpan MinStaleInterval = TimeSpan.FromSeconds(15);

    public static (CollectorStatus Status, string Text) Evaluate(bool enabled, bool globallyPaused, bool running, string? lastError,
        DateTimeOffset? lastRunAt, TimeSpan interval, DateTimeOffset now)
    {
        if (!enabled) return (CollectorStatus.Off, "off");
        if (globallyPaused) return (CollectorStatus.Paused, "paused");
        if (!string.IsNullOrEmpty(lastError)) return (CollectorStatus.Error, "error: " + lastError);
        if (!running) return (CollectorStatus.Stale, "not running");
        if (lastRunAt is null) return (CollectorStatus.Stale, "no run yet");
        if (interval < MinStaleInterval) interval = MinStaleInterval;
        if (now - lastRunAt.Value > interval * 2) return (CollectorStatus.Stale, "stale");
        return (CollectorStatus.Ok, "ok");
    }

    public static string Color(CollectorStatus s) => s switch
    {
        CollectorStatus.Ok => Green,
        CollectorStatus.Stale => Amber,
        CollectorStatus.Error => Red,
        _ => Grey,
    };
}
