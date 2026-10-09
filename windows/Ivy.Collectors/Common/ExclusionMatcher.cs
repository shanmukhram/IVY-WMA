using System.Text.RegularExpressions;

namespace Ivy.Collectors.Common;

/// <summary>
/// Path exclusions for the file index. Pattern forms:
/// <list type="bullet">
/// <item>no slash (<c>node_modules</c>, <c>*.tmp</c>): matches any single path segment, at any depth;</item>
/// <item>with a slash: matched against the whole path; patterns that do not start with <c>/</c>, a drive
/// (<c>?:/</c>, <c>C:/</c>) or <c>**</c> are treated as <c>**/pattern</c>;</item>
/// <item>a trailing <c>/**</c> is dropped: excluding a directory excludes everything under it.</item>
/// </list>
/// A path is excluded when it, or any of its ancestors, matches.
/// </summary>
public sealed class ExclusionMatcher
{
    /// <summary>Defaults (WC1): build/VCS folders, the recycle bin, OS and program folders, temp.</summary>
    public static readonly IReadOnlyList<string> Defaults = new[]
    {
        "node_modules",
        ".git",
        "$Recycle.Bin",
        "System Volume Information",
        "?:/Windows",
        "?:/Program Files",
        "?:/Program Files (x86)",
        "**/AppData/Local/Temp",
    };

    private readonly Regex[] _segment;
    private readonly Regex[] _path;

    public ExclusionMatcher(IEnumerable<string> patterns)
    {
        var seg = new List<Regex>();
        var path = new List<Regex>();
        foreach (var raw in patterns)
        {
            var p = Glob.Normalize(raw.Trim());
            while (p.EndsWith("/**", StringComparison.Ordinal)) p = p[..^3];
            p = p.TrimEnd('/');
            if (p.Length == 0) continue;
            if (!p.Contains('/'))
            {
                seg.Add(Glob.ToRegex(p));
                continue;
            }
            var anchored = p.StartsWith('/') || p.StartsWith("**", StringComparison.Ordinal) || (p.Length >= 3 && p[1] == ':' && p[2] == '/');
            path.Add(Glob.ToRegex(anchored ? p : "**/" + p));
        }
        _segment = seg.ToArray();
        _path = path.ToArray();
    }

    public IReadOnlyList<Regex> SegmentPatterns => _segment;

    /// <summary>Checks only the entry itself (its name and full path); use while walking, where ancestors were already checked.</summary>
    public bool IsExcludedEntry(string fullPath, string name)
    {
        foreach (var r in _segment) if (r.IsMatch(name)) return true;
        var n = Glob.Normalize(fullPath).TrimEnd('/');
        foreach (var r in _path) if (r.IsMatch(n)) return true;
        return false;
    }

    /// <summary>Checks the path and every ancestor (use for watcher/journal events).</summary>
    public bool IsExcluded(string fullPath)
    {
        var n = Glob.Normalize(fullPath).TrimEnd('/');
        var segs = n.Split('/');
        foreach (var s in segs)
        {
            if (s.Length == 0) continue;
            foreach (var r in _segment) if (r.IsMatch(s)) return true;
        }
        if (_path.Length == 0) return false;
        var idx = n.Length;
        while (idx > 0)
        {
            var prefix = n[..idx];
            foreach (var r in _path) if (r.IsMatch(prefix)) return true;
            idx = n.LastIndexOf('/', idx - 1);
        }
        return false;
    }
}
