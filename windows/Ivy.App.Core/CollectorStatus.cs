namespace Ivy.App.Core;

/// <summary>
/// Status dot: green working, amber stale (no run in more than two intervals, or not running) or waiting (the
/// collector is fine and waiting for its app, e.g. LINE signing in), red error, grey off or idle (nothing to do
/// right now, e.g. LINE closed or not installed: informational, not a problem).
/// </summary>
public enum CollectorStatus { Off, Paused, Ok, Stale, Error, Idle, Waiting }

/// <summary>InfoBar severity without a WinUI reference; the values equal <c>InfoBarSeverity</c>'s (the shell casts).</summary>
public enum UiSeverity { Informational = 0, Success = 1, Warning = 2, Error = 3 }

public static class CollectorNames
{
    public const string Files = "files";
    public const string Screenshots = "screenshots";
    public const string Usage = "usage";
    public const string Notifications = "notifications";
    public const string Line = "line";
    public const string Telegram = "telegram";

    /// <summary>Row order in the window (PRD "App UI").</summary>
    public static readonly IReadOnlyList<string> All = new[] { Files, Screenshots, Usage, Notifications, Line, Telegram };

    public static string Display(string name) => name switch
    {
        Files => "Files",
        Screenshots => "Screenshots",
        Usage => "App usage",
        Notifications => "Notifications",
        Line => "LINE",
        Telegram => "Telegram",
        _ => name,
    };

    /// <summary>Page subtitle: what the collector captures, in one sentence (mirrors the Mac's Windows group).</summary>
    public static string Describe(string name) => name switch
    {
        Files => "Indexes your folders with thumbnails. Images and documents under the size caps upload in full; other originals on request.",
        Screenshots => "Uploads new screenshots so the Mac can read their text.",
        Usage => "Records which app is in front, with window titles when title capture is on.",
        Notifications => "Copies Windows notifications as they were shown: partial records, not conversations.",
        Line => "Reads what LINE for Windows has synced to this PC. Always partial: the phone holds the full history.",
        Telegram => "Pulls complete cloud history through the Telegram Desktop session on this PC.",
        _ => "",
    };

    /// <summary>Segoe Fluent Icons glyph (Folder, Camera, AreaChart, Ringer, ChatBubbles).</summary>
    public static string Glyph(string name) => name switch
    {
        Files => "\uE8B7",
        Screenshots => "\uE722",
        Usage => "\uE9D2",
        Notifications => "\uEA8F",
        _ => "\uE8F2",
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
        Line => TimeSpan.FromSeconds(5),
        Telegram => TimeSpan.FromSeconds(5),
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

    /// <summary>
    /// <see cref="Evaluate(bool, bool, bool, string?, DateTimeOffset?, TimeSpan, DateTimeOffset)"/> plus the
    /// collector's own state where it reports one through its detail line (today: LINE, see
    /// <see cref="LineStatus"/>). The general rules (off, paused, error, not running, stale) still win; only a
    /// healthy, recently run collector is refined to idle (grey) or waiting (amber).
    /// </summary>
    public static (CollectorStatus Status, string Text) Evaluate(string name, bool enabled, bool globallyPaused, bool running,
        string? lastError, DateTimeOffset? lastRunAt, TimeSpan interval, DateTimeOffset now, string? detail)
    {
        var result = Evaluate(enabled, globallyPaused, running, lastError, lastRunAt, interval, now);
        if (result.Status != CollectorStatus.Ok || name != CollectorNames.Line) return result;
        return LineStatus.Classify(detail) switch
        {
            LineStatusKind.Idle => (CollectorStatus.Idle, "idle"),
            LineStatusKind.Waiting => (CollectorStatus.Waiting, "waiting"),
            _ => result,
        };
    }

    /// <summary>Short status for tiles and headers.</summary>
    public static string Label(CollectorStatus s) => s switch
    {
        CollectorStatus.Ok => "Working",
        CollectorStatus.Paused => "Paused",
        CollectorStatus.Stale => "Needs attention",
        CollectorStatus.Error => "Error",
        CollectorStatus.Idle => "Idle",
        CollectorStatus.Waiting => "Waiting",
        _ => "Off",
    };

    public static UiSeverity Severity(CollectorStatus s) => s switch
    {
        CollectorStatus.Ok => UiSeverity.Success,
        CollectorStatus.Stale => UiSeverity.Warning,
        CollectorStatus.Waiting => UiSeverity.Warning,
        CollectorStatus.Error => UiSeverity.Error,
        _ => UiSeverity.Informational,
    };

    /// <summary>The "status with reason" sentence. <paramref name="ruleText"/> is <see cref="Evaluate"/>'s text.</summary>
    public static string Reason(CollectorStatus s, string ruleText, string? lastError, string? detail, bool missing)
    {
        if (missing) return "Not available in this build.";
        var d = string.IsNullOrWhiteSpace(detail) ? "" : " " + Sentence(detail!);
        return s switch
        {
            CollectorStatus.Off => "Turned off. Nothing is captured.",
            CollectorStatus.Paused => "IVY is paused. Resume on the Overview page or from the tray.",
            CollectorStatus.Error => Sentence(lastError ?? "unknown error"),
            CollectorStatus.Stale when ruleText == "not running" => "Not running." + d,
            CollectorStatus.Stale when ruleText == "no run yet" => "Started, but has not run yet." + d,
            CollectorStatus.Stale => "No run for more than two intervals." + d,
            _ => d.Length > 0 ? d.TrimStart() : "Capturing.",
        };
    }

    /// <summary>Capitalised and ending with a full stop.</summary>
    internal static string Sentence(string text)
    {
        var t = text.Trim();
        if (t.Length == 0) return t;
        t = char.ToUpperInvariant(t[0]) + t[1..];
        return t.EndsWith('.') || t.EndsWith(')') || t.EndsWith('?') ? t : t + ".";
    }

    public static string Color(CollectorStatus s) => s switch
    {
        CollectorStatus.Ok => Green,
        CollectorStatus.Stale => Amber,
        CollectorStatus.Waiting => Amber,
        CollectorStatus.Error => Red,
        _ => Grey,   // Off, Paused, Idle
    };
}

/// <summary>How the LINE row's detail line reads: an informational idle state, a wait, or anything else.</summary>
public enum LineStatusKind { Other, Idle, Waiting }

/// <summary>
/// The LINE collector's states as the window sees them. The host passes only the detail line and the error
/// across, so the collector's informational states are recognised by the fixed start of their detail line
/// (written by <c>LineDesktopCollector</c>; keep the two in step). Errors (schema drift, unverified map, a
/// missing store, a wrong data path) arrive as <c>LastError</c> and stay red through the general rules.
/// <list type="table">
/// <item><term>NotInstalled</term><description>grey, "LINE for Windows not found"</description></item>
/// <item><term>NotRunning</term><description>grey, "LINE is not running; last captured ...; resumes when LINE opens"</description></item>
/// <item><term>WaitingForLine</term><description>amber, "Waiting for LINE to finish signing in: ..."</description></item>
/// </list>
/// </summary>
public static class LineStatus
{
    public const string NotInstalledPrefix = "LINE for Windows not found";
    public const string NotRunningPrefix = "LINE is not running";
    public const string WaitingPrefix = "Waiting for LINE";

    public static LineStatusKind Classify(string? detail)
    {
        if (string.IsNullOrEmpty(detail)) return LineStatusKind.Other;
        if (detail.StartsWith(NotRunningPrefix, StringComparison.Ordinal) || detail.StartsWith(NotInstalledPrefix, StringComparison.Ordinal))
            return LineStatusKind.Idle;
        if (detail.StartsWith(WaitingPrefix, StringComparison.Ordinal)) return LineStatusKind.Waiting;
        return LineStatusKind.Other;
    }
}
