using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;

namespace Ivy.Collectors.Files;

/// <summary>One directory's files, yielded in scan order.</summary>
internal sealed record DirectoryBatch(string Directory, string RelativePath, IReadOnlyList<FsEntry> Files);

/// <summary>
/// Deterministic pre-order walk of one root: children sorted ordinally, so the visiting order equals the
/// lexicographic order of relative path segment lists. That makes a single "last completed directory"
/// checkpoint enough to resume: a directory before the checkpoint that is not one of its ancestors was
/// finished (with its whole subtree), the checkpoint itself and its ancestors had their files done but
/// may still have children to visit.
/// </summary>
internal sealed class ScanWalker
{
    private readonly IFileSystemSource _fs;
    private readonly ExclusionMatcher _exclusions;
    private readonly bool _includeHidden;
    private readonly bool _includeSystem;

    public ScanWalker(IFileSystemSource fs, ExclusionMatcher exclusions, bool includeHidden, bool includeSystem)
    {
        _fs = fs;
        _exclusions = exclusions;
        _includeHidden = includeHidden;
        _includeSystem = includeSystem;
    }

    /// <summary>Directories that could not be listed during the walk (access denied, vanished). Cached files
    /// under them are not treated as deleted.</summary>
    public List<string> FailedDirectories { get; } = new();

    public bool Admit(FsEntry e)
    {
        if (e.IsReparsePoint) return false;          // junctions/symlinks: avoid loops and double counting
        if (!_includeHidden && e.Hidden) return false;
        if (!_includeSystem && e.System) return false;
        return !_exclusions.IsExcludedEntry(e.FullPath, e.Name);
    }

    /// <summary>Walk <paramref name="root"/>; <paramref name="checkpoint"/> is the relative path of the last completed
    /// directory (<c>""</c> = the root itself), or null to start from the beginning.</summary>
    public IEnumerable<DirectoryBatch> Walk(string root, string? checkpoint)
    {
        var cp = checkpoint is null ? null : Split(checkpoint);
        var stack = new Stack<(string Dir, string[] Rel)>();
        stack.Push((root, Array.Empty<string>()));
        while (stack.Count > 0)
        {
            var (dir, rel) = stack.Pop();
            var emitFiles = true;
            if (cp is not null)
            {
                var cmp = Compare(rel, cp);
                if (cmp <= 0)
                {
                    if (cmp < 0 && !IsPrefix(rel, cp)) continue; // whole subtree finished before the checkpoint
                    emitFiles = false;                            // the checkpoint or one of its ancestors
                }
            }

            List<FsEntry> entries;
            try { entries = _fs.EnumerateDirectory(dir).ToList(); }
            catch (Exception e) when (e is UnauthorizedAccessException or IOException or System.Security.SecurityException)
            {
                FailedDirectories.Add(dir);
                continue;
            }

            var files = new List<FsEntry>();
            var dirs = new List<FsEntry>();
            foreach (var e in entries)
            {
                if (!Admit(e)) continue;
                (e.IsDirectory ? dirs : files).Add(e);
            }
            dirs.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            files.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));

            if (emitFiles) yield return new DirectoryBatch(dir, string.Join('/', rel), files);
            for (var i = dirs.Count - 1; i >= 0; i--)
            {
                var child = new string[rel.Length + 1];
                rel.CopyTo(child, 0);
                child[^1] = dirs[i].Name;
                stack.Push((dirs[i].FullPath, child));
            }
        }
    }

    public static string[] Split(string relative) =>
        relative.Length == 0 ? Array.Empty<string>() : relative.Split('/');

    /// <summary>Segment-wise ordinal comparison; a proper prefix sorts first (pre-order).</summary>
    public static int Compare(string[] a, string[] b)
    {
        var n = Math.Min(a.Length, b.Length);
        for (var i = 0; i < n; i++)
        {
            var c = string.CompareOrdinal(a[i], b[i]);
            if (c != 0) return c;
        }
        return a.Length.CompareTo(b.Length);
    }

    public static bool IsPrefix(string[] a, string[] b)
    {
        if (a.Length > b.Length) return false;
        for (var i = 0; i < a.Length; i++) if (!string.Equals(a[i], b[i], StringComparison.Ordinal)) return false;
        return true;
    }
}
