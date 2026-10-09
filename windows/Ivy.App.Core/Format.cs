using System.Globalization;

namespace Ivy.App.Core;

/// <summary>Display formatting for the status window. Invariant culture so numbers read the same everywhere.</summary>
public static class Fmt
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static readonly string[] Units = { "B", "KB", "MB", "GB", "TB" };

    /// <summary>1024-based byte size: <c>0 B</c>, <c>512 B</c>, <c>1.5 KB</c>, <c>12.0 MB</c>.</summary>
    public static string Bytes(long bytes)
    {
        if (bytes < 0) bytes = 0;
        if (bytes < 1024) return bytes.ToString(Inv) + " B";
        double v = bytes;
        var u = 0;
        while (v >= 1024 && u < Units.Length - 1)
        {
            v /= 1024;
            u++;
        }
        return v.ToString("0.0", Inv) + " " + Units[u];
    }

    /// <summary>Relative age: <c>never</c>, <c>just now</c>, <c>42s ago</c>, <c>5m ago</c>, <c>3h ago</c>, <c>2d ago</c>.</summary>
    public static string Ago(DateTimeOffset? t, DateTimeOffset now)
    {
        if (t is null) return "never";
        var d = now - t.Value;
        if (d < TimeSpan.FromSeconds(1)) return "just now";
        if (d < TimeSpan.FromMinutes(1)) return ((int)d.TotalSeconds).ToString(Inv) + "s ago";
        if (d < TimeSpan.FromHours(1)) return ((int)d.TotalMinutes).ToString(Inv) + "m ago";
        if (d < TimeSpan.FromDays(1)) return ((int)d.TotalHours).ToString(Inv) + "h ago";
        return ((int)d.TotalDays).ToString(Inv) + "d ago";
    }

    /// <summary>Feed timestamp, local wall clock <c>HH:mm:ss</c>.</summary>
    public static string Clock(DateTimeOffset t, TimeZoneInfo? zone = null) =>
        TimeZoneInfo.ConvertTime(t, zone ?? TimeZoneInfo.Local).ToString("HH:mm:ss", Inv);

    /// <summary>Full local timestamp <c>yyyy-MM-dd HH:mm:ss</c>.</summary>
    public static string Stamp(DateTimeOffset t, TimeZoneInfo? zone = null) =>
        TimeZoneInfo.ConvertTime(t, zone ?? TimeZoneInfo.Local).ToString("yyyy-MM-dd HH:mm:ss", Inv);

    /// <summary>"Stamp (ago)" or "never".</summary>
    public static string StampAgo(DateTimeOffset? t, DateTimeOffset now, TimeZoneInfo? zone = null) =>
        t is null ? "never" : Stamp(t.Value, zone) + " (" + Ago(t, now) + ")";

    /// <summary>Bandwidth cap: <c>unlimited</c> or <c>512.0 KB/s</c>.</summary>
    public static string Bandwidth(long bytesPerSecond) => bytesPerSecond <= 0 ? "unlimited" : Bytes(bytesPerSecond) + "/s";

    /// <summary>The cap in whole KB/s for the edit box (0 = unlimited).</summary>
    public static string BandwidthKBps(long bytesPerSecond) => (bytesPerSecond <= 0 ? 0 : bytesPerSecond / 1024).ToString(Inv);

    /// <summary>
    /// Parse the bandwidth box: whole KB/s, blank or 0 means unlimited. Returns bytes/second, or null if invalid.
    /// </summary>
    public static long? ParseBandwidthKBps(string? text)
    {
        var s = (text ?? "").Trim();
        if (s.Length == 0) return 0;
        if (!long.TryParse(s, NumberStyles.None, Inv, out var kb)) return null;
        if (kb > long.MaxValue / 1024) return null;
        return kb * 1024;
    }

    /// <summary>Percentage 0–100, clamped; 0 when the total is unknown.</summary>
    public static double Percent(long done, long total)
    {
        if (total <= 0) return 0;
        var p = 100.0 * done / total;
        return p < 0 ? 0 : p > 100 ? 100 : p;
    }

    public static string Count(long n) => n.ToString("N0", Inv);

    /// <summary>Strip every whitespace character (pasted pairing strings often pick up line breaks).</summary>
    public static string StripWhitespace(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var chars = new char[s.Length];
        var n = 0;
        foreach (var c in s)
            if (!char.IsWhiteSpace(c)) chars[n++] = c;
        return new string(chars, 0, n);
    }
}
