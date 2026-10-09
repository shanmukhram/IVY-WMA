using System.Text.RegularExpressions;
using Ivy.Collectors.Common;

namespace Ivy.Collectors.Usage;

/// <summary>Applies <see cref="UsageSettings.CaptureTitles"/> and <see cref="UsageSettings.TitleExclusions"/>.</summary>
public sealed class TitleFilter
{
    private readonly bool _capture;
    private readonly List<string> _substrings = new();
    private readonly List<Regex> _globs = new();

    public TitleFilter(bool captureTitles, IEnumerable<string> exclusions)
    {
        _capture = captureTitles;
        foreach (var raw in exclusions)
        {
            var p = raw.Trim();
            if (p.Length == 0) continue;
            if (Glob.HasWildcards(p))
            {
                // Titles are not paths: '*' should cross '/' too, so translate to a flat regex.
                var rx = "^" + Regex.Escape(p).Replace(@"\*", ".*").Replace(@"\?", ".") + "$";
                _globs.Add(new Regex(rx, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Singleline, TimeSpan.FromMilliseconds(250)));
            }
            else _substrings.Add(p);
        }
    }

    public bool IsExcluded(string? title, string? exe)
    {
        foreach (var s in _substrings)
        {
            if (title is not null && title.Contains(s, StringComparison.OrdinalIgnoreCase)) return true;
            if (exe is not null && exe.Contains(s, StringComparison.OrdinalIgnoreCase)) return true;
        }
        foreach (var g in _globs)
        {
            if (title is not null && g.IsMatch(title)) return true;
            if (exe is not null && g.IsMatch(exe)) return true;
        }
        return false;
    }

    /// <summary>The title as it may be recorded (null when capture is off, excluded, or empty).</summary>
    public string? Apply(string? title, string? exe)
    {
        if (!_capture || string.IsNullOrWhiteSpace(title)) return null;
        return IsExcluded(title, exe) ? null : title;
    }
}
