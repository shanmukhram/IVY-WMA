namespace Ivy.Collectors.Abstractions;

/// <summary>One directory entry as the collectors see it (no content).</summary>
public sealed record FsEntry(
    string FullPath,
    string Name,
    bool IsDirectory,
    long Size,
    DateTimeOffset LastWriteUtc,
    DateTimeOffset CreationUtc,
    bool Hidden,
    bool System,
    bool IsReparsePoint);

/// <summary>
/// File-system access used by the file index and screenshot collectors. The default
/// <see cref="PhysicalFileSystemSource"/> is plain System.IO and works on Windows and macOS; tests wrap it
/// to count calls or simulate locked files.
/// </summary>
public interface IFileSystemSource
{
    /// <summary>Immediate children of <paramref name="directory"/>. Throws <see cref="UnauthorizedAccessException"/>
    /// or <see cref="IOException"/> when the directory cannot be listed.</summary>
    IEnumerable<FsEntry> EnumerateDirectory(string directory);

    /// <summary>Metadata for one path, or null if it does not exist.</summary>
    FsEntry? Stat(string path);

    /// <summary>Open for reading while allowing other readers/writers (used for hashing and thumbnails).</summary>
    Stream OpenRead(string path);

    /// <summary>
    /// True when the file can be opened for reading with no concurrent writer (FileShare.Read). On Windows
    /// this fails while the producing app still holds the file open for writing; it is the "fully written" probe.
    /// </summary>
    bool IsReadableWithoutWriters(string path);
}

public sealed class PhysicalFileSystemSource : IFileSystemSource
{
    public static readonly PhysicalFileSystemSource Instance = new();

    private static readonly EnumerationOptions Options = new()
    {
        RecurseSubdirectories = false,
        IgnoreInaccessible = true,
        AttributesToSkip = 0,
        ReturnSpecialDirectories = false,
    };

    public IEnumerable<FsEntry> EnumerateDirectory(string directory)
    {
        var dir = new DirectoryInfo(directory);
        foreach (var info in dir.EnumerateFileSystemInfos("*", Options))
        {
            FsEntry? e;
            try { e = ToEntry(info); }
            catch (IOException) { e = null; }
            catch (UnauthorizedAccessException) { e = null; }
            if (e is not null) yield return e;
        }
    }

    public FsEntry? Stat(string path)
    {
        try
        {
            var fi = new FileInfo(path);
            if (fi.Exists) return ToEntry(fi);
            var di = new DirectoryInfo(path);
            return di.Exists ? ToEntry(di) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    public Stream OpenRead(string path) =>
        new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.SequentialScan);

    public bool IsReadableWithoutWriters(string path)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1);
            return true;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static FsEntry ToEntry(FileSystemInfo info)
    {
        var attrs = info.Attributes;
        var isDir = (attrs & FileAttributes.Directory) != 0;
        return new FsEntry(
            info.FullName,
            info.Name,
            isDir,
            isDir ? 0 : ((FileInfo)info).Length,
            new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero),
            new DateTimeOffset(info.CreationTimeUtc, TimeSpan.Zero),
            (attrs & FileAttributes.Hidden) != 0,
            (attrs & FileAttributes.System) != 0,
            (attrs & FileAttributes.ReparsePoint) != 0);
    }
}
