namespace Ivy.Collectors.Abstractions;

/// <summary>A path that changed (created, written, renamed to/from, or deleted). Collectors re-stat it.</summary>
public readonly record struct FileChange(string Path);

/// <summary>Push-style change notifications for a set of roots (FileSystemWatcher by default).</summary>
public interface IFileChangeSource : IDisposable
{
    event Action<FileChange>? Changed;

    /// <summary>Raised when the OS reports lost events (buffer overflow); the collector schedules a rescan.</summary>
    event Action<string>? Overflowed;

    void Watch(IReadOnlyList<string> roots, bool includeSubdirectories);
}

public interface IFileChangeSourceFactory
{
    IFileChangeSource Create();
}

public sealed class FileSystemWatcherChangeSourceFactory : IFileChangeSourceFactory
{
    public static readonly FileSystemWatcherChangeSourceFactory Instance = new();
    public IFileChangeSource Create() => new FileSystemWatcherChangeSource();
}

/// <summary><see cref="FileSystemWatcher"/> on every root (all platforms).</summary>
public sealed class FileSystemWatcherChangeSource : IFileChangeSource
{
    private readonly List<FileSystemWatcher> _watchers = new();

    public event Action<FileChange>? Changed;
    public event Action<string>? Overflowed;

    public void Watch(IReadOnlyList<string> roots, bool includeSubdirectories)
    {
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            var w = new FileSystemWatcher(root)
            {
                IncludeSubdirectories = includeSubdirectories,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                InternalBufferSize = 64 * 1024,
            };
            w.Created += (_, e) => Changed?.Invoke(new FileChange(e.FullPath));
            w.Changed += (_, e) => Changed?.Invoke(new FileChange(e.FullPath));
            w.Deleted += (_, e) => Changed?.Invoke(new FileChange(e.FullPath));
            w.Renamed += (_, e) =>
            {
                Changed?.Invoke(new FileChange(e.OldFullPath));
                Changed?.Invoke(new FileChange(e.FullPath));
            };
            var r = root;
            w.Error += (_, _) => Overflowed?.Invoke(r);
            w.EnableRaisingEvents = true;
            _watchers.Add(w);
        }
    }

    public void Dispose()
    {
        foreach (var w in _watchers)
        {
            w.EnableRaisingEvents = false;
            w.Dispose();
        }
        _watchers.Clear();
    }
}
