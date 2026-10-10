using System.Text;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Line;

/// <summary>
/// Atomically snapshots a LINE db file together with its <c>-wal</c>/<c>-shm</c> side-cars into a private
/// temp directory, the same approach the notification collector uses for the locked WPN database: copy the
/// three files with shared-read streams and retry until their sizes/mtimes are identical before and after,
/// so the copy is a consistent point-in-time set. The LINE client holds the live file open, so we never read
/// it in place. Dispose deletes the temp directory.
/// </summary>
public sealed class LineSnapshot : IDisposable
{
    private static readonly string[] Suffixes = { "", "-wal", "-shm" };
    private readonly string _dir;

    private LineSnapshot(string dir, string dbCopy) { _dir = dir; DbCopy = dbCopy; }

    /// <summary>The copied db file inside the snapshot directory.</summary>
    public string DbCopy { get; }

    /// <summary>The directory the whole LINE data folder is snapshotted under (for <see cref="LineStore.Open"/>).</summary>
    public string Directory => _dir;

    public static LineSnapshot? TryCreate(string sourceDbPath, string tempRoot, out string? reason)
    {
        reason = null;
        if (!File.Exists(sourceDbPath))
        {
            reason = $"LINE database not found at {sourceDbPath}";
            return null;
        }
        var dir = Path.Combine(tempRoot, Guid.NewGuid().ToString("N"));
        System.IO.Directory.CreateDirectory(dir);
        var target = Path.Combine(dir, Path.GetFileName(sourceDbPath));
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var before = Stamp(sourceDbPath);
            try
            {
                foreach (var s in Suffixes)
                {
                    var src = sourceDbPath + s;
                    var dst = target + s;
                    if (File.Exists(dst)) File.Delete(dst);
                    if (!File.Exists(src)) continue;
                    using var input = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
                    using var output = new FileStream(dst, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16);
                    input.CopyTo(output);
                }
            }
            catch (UnauthorizedAccessException)
            {
                TryDelete(dir);
                reason = $"access denied reading {sourceDbPath} (is LINE running as a different user?)";
                return null;
            }
            catch (IOException e) when (e is not FileNotFoundException)
            {
                if (attempt == 4) { TryDelete(dir); reason = $"could not copy {sourceDbPath}: {e.Message}"; return null; }
                Thread.Sleep(100 * (attempt + 1));
                continue;
            }
            if (before == Stamp(sourceDbPath)) return new LineSnapshot(dir, target);
            Thread.Sleep(100 * (attempt + 1));
        }
        TryDelete(dir);
        reason = $"{sourceDbPath} kept changing while copying; will retry next poll";
        return null;
    }

    private static string Stamp(string path)
    {
        var sb = new StringBuilder();
        foreach (var s in Suffixes)
        {
            var fi = new FileInfo(path + s);
            sb.Append(fi.Exists ? $"{fi.Length}:{fi.LastWriteTimeUtc.Ticks};" : "-;");
        }
        return sb.ToString();
    }

    private static void TryDelete(string dir)
    {
        SqliteConnection.ClearAllPools();
        try { System.IO.Directory.Delete(dir, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    public void Dispose() => TryDelete(_dir);
}
