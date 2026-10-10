using System.Globalization;
using System.Text.RegularExpressions;

namespace Ivy.App.Core;

/// <summary>
/// Telegram's per-chat progress, parsed from the collector's detail line. The collector writes it as
/// <c>chats {done}/{total}, {messages} messages[, {n} phone-only (secret)]</c>
/// (Ivy.Collectors/Telegram/TelegramCollector.cs, <c>UpdateProgress</c>); the window turns it into a ProgressBar.
/// Anything else (flood-wait, errors) is not progress and parses to null.
/// </summary>
public sealed record TelegramProgress(int ChatsDone, int ChatsTotal, long Messages, int PhoneOnly)
{
    private static readonly Regex Pattern = new(
        @"^chats (?<done>\d+)/(?<total>\d+), (?<msgs>\d+) messages(?:, (?<phone>\d+) phone-only \(secret\))?$",
        RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    public static TelegramProgress? TryParse(string? detail)
    {
        if (string.IsNullOrWhiteSpace(detail)) return null;
        var m = Pattern.Match(detail.Trim());
        if (!m.Success) return null;
        var inv = CultureInfo.InvariantCulture;
        if (!int.TryParse(m.Groups["done"].Value, NumberStyles.None, inv, out var done)
            || !int.TryParse(m.Groups["total"].Value, NumberStyles.None, inv, out var total)
            || !long.TryParse(m.Groups["msgs"].Value, NumberStyles.None, inv, out var msgs)) return null;
        var phone = 0;
        if (m.Groups["phone"].Success && !int.TryParse(m.Groups["phone"].Value, NumberStyles.None, inv, out phone)) return null;
        if (done > total) return null;
        return new TelegramProgress(done, total, msgs, phone);
    }
}

/// <summary>The LINE probe's summary, from the collector's detail line after a probe (<c>LineProbeReport.HumanSummary()</c>).</summary>
public static class LineProbe
{
    private const string Prefix = "Probe complete:";

    /// <summary>"Probe complete: 412 files, 6 databases, 0 readable" without the trailing "; report &lt;path&gt;", or null.</summary>
    public static string? Summary(string? detail)
    {
        if (string.IsNullOrWhiteSpace(detail)) return null;
        var d = detail.Trim();
        if (!d.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        var cut = d.IndexOf("; report ", StringComparison.Ordinal);
        return (cut >= 0 ? d[..cut] : d).TrimEnd('.', ' ') + ".";
    }
}
