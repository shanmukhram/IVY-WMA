using System.Globalization;

namespace Ivy.App.Core.Diagnostics;

/// <summary>What the UI thread reported on its last heartbeat (sampled on the UI thread).</summary>
public sealed record UiSample(int FeedCount, bool WindowVisible, DateTimeOffset? LastTickAt);

/// <summary>
/// Log lines of the hang diagnostics (second Windows run: AppHangB1 with nothing in the log). Timings, counts and
/// identifiers only: no paths, titles or text.
/// </summary>
public static class HangReport
{
    public static string Stamp(DateTimeOffset t) =>
        t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static string Ms(TimeSpan d) => ((long)d.TotalMilliseconds).ToString(CultureInfo.InvariantCulture);

    /// <summary><c>heartbeat: ui=alive feed=580 window=visible last_tick=2026-10-10T12:00:01.000Z (0 s ago)</c></summary>
    public static string Heartbeat(bool alive, UiSample? sample, DateTimeOffset now)
    {
        var s = "heartbeat: ui=" + (alive ? "alive" : "unresponsive");
        if (sample is null) return s + " feed=? window=? last_tick=never";
        s += " feed=" + sample.FeedCount.ToString(CultureInfo.InvariantCulture)
             + " window=" + (sample.WindowVisible ? "visible" : "hidden")
             + " last_tick=";
        if (sample.LastTickAt is not { } t) return s + "never";
        var ago = (long)Math.Max(0, (now - t).TotalSeconds);
        return s + Stamp(t) + " (" + ago.ToString(CultureInfo.InvariantCulture) + " s ago)";
    }

    /// <summary><c>UI unresponsive since 2026-10-10T12:00:00.000Z (5000 ms); ui: FlushFeed batch=12 (running 5100 ms)</c></summary>
    public static string Unresponsive(DateTimeOffset since, DateTimeOffset now, string uiBreadcrumb, IEnumerable<string>? others = null)
    {
        var s = "UI unresponsive since " + Stamp(since) + " (" + Ms(now - since) + " ms); ui: " + uiBreadcrumb;
        var rest = others?.ToList();
        if (rest is { Count: > 0 }) s += "; other threads: " + string.Join(", ", rest);
        return s;
    }

    public static string Recovered(TimeSpan after) => "UI recovered after " + Ms(after) + " ms";

    /// <summary><c>ivy-app-hang-20261010T120000Z.dmp</c></summary>
    public static string DumpFileName(DateTimeOffset t) =>
        "ivy-app-hang-" + t.ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture) + ".dmp";

    /// <summary><c>slow FlushFeed batch=40: 75 ms</c></summary>
    public static string Slow(string what, TimeSpan took) => "slow " + what + ": " + Ms(took) + " ms";

    /// <summary>WM_WTSSESSION_CHANGE wParam names (WinUser.h).</summary>
    public static string SessionChange(int code) => code switch
    {
        0x1 => "console_connect",
        0x2 => "console_disconnect",
        0x3 => "remote_connect",
        0x4 => "remote_disconnect",
        0x5 => "session_logon",
        0x6 => "session_logoff",
        0x7 => "session_lock",
        0x8 => "session_unlock",
        0x9 => "session_remote_control",
        0xA => "session_create",
        0xB => "session_terminate",
        _ => "code_" + code.ToString(CultureInfo.InvariantCulture),
    };
}
