using System.Text;
using System.Text.RegularExpressions;

namespace Ivy.Collectors.Common;

/// <summary>
/// Glob → regex. <c>**</c> matches anything including separators, <c>*</c> anything but a separator,
/// <c>?</c> one non-separator character. Paths and patterns are normalized to <c>/</c>; matching is
/// case-insensitive (Windows semantics, applied on every platform so tests behave the same).
/// </summary>
public static class Glob
{
    public static string Normalize(string path) => path.Replace('\\', '/');

    public static Regex ToRegex(string pattern, bool matchWholeString = true)
    {
        var p = Normalize(pattern);
        var sb = new StringBuilder(matchWholeString ? "^" : "");
        for (var i = 0; i < p.Length; i++)
        {
            var ch = p[i];
            switch (ch)
            {
                case '*':
                    if (i + 1 < p.Length && p[i + 1] == '*')
                    {
                        i++;
                        // "**/" also matches zero directories.
                        if (i + 1 < p.Length && p[i + 1] == '/') { i++; sb.Append("(?:.*/)?"); }
                        else sb.Append(".*");
                    }
                    else sb.Append("[^/]*");
                    break;
                case '?':
                    sb.Append("[^/]");
                    break;
                default:
                    sb.Append(Regex.Escape(ch.ToString()));
                    break;
            }
        }
        if (matchWholeString) sb.Append('$');
        return new Regex(sb.ToString(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    }

    public static bool HasWildcards(string s) => s.IndexOfAny(new[] { '*', '?' }) >= 0;
}
