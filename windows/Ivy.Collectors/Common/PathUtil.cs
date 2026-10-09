namespace Ivy.Collectors.Common;

internal static class PathUtil
{
    /// <summary>Windows paths are case-insensitive; elsewhere ordinal.</summary>
    public static StringComparison Comparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    public static string Full(string path) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));

    public static bool IsUnderOrEqual(string path, string root)
    {
        var p = Full(path);
        var r = Full(root);
        if (p.Equals(r, Comparison)) return true;
        if (!r.EndsWith(Path.DirectorySeparatorChar)) r += Path.DirectorySeparatorChar;
        return p.StartsWith(r, Comparison);
    }

    /// <summary>Extension without the dot, lower-case ("" when none).</summary>
    public static string Ext(string name)
    {
        var e = Path.GetExtension(name);
        return string.IsNullOrEmpty(e) ? "" : e[1..].ToLowerInvariant();
    }
}
