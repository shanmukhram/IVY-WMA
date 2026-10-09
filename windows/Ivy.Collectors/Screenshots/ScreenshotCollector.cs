using System.Collections.Concurrent;
using System.Security.Cryptography;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Core.Commands;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;

namespace Ivy.Collectors.Screenshots;

/// <summary>
/// WC3/WC6: every new image in the Screenshots folder(s) is uploaded as a chunked blob (original bytes,
/// payload kind <c>screenshot</c>) plus a <c>screenshot</c> record referencing it by <c>blobOid</c>.
/// <list type="bullet">
/// <item>Debounce: a candidate is uploaded only after it was seen twice, at least
/// <see cref="ScreenshotSettings.DebounceSeconds"/> apart, with the same size and mtime, size &gt; 0, and it
/// opens with no concurrent writer.</item>
/// <item>Dedupe: by SHA-256 in <c>screenshot_seen</c>; a copy or re-save of the same bytes is not re-sent.</item>
/// <item>Times: <c>takenAt</c> from EXIF DateTimeOriginal, else the file's creation time; <c>savedAt</c> = mtime;
/// <c>eventTime</c> = takenAt.</item>
/// </list>
/// </summary>
public sealed class ScreenshotCollector : Collector<ScreenshotSettings>
{
    private sealed class Candidate
    {
        public long Size;
        public DateTimeOffset Mtime;
        public DateTimeOffset StableSince;
    }

    private readonly IFileSystemSource _fs;
    private readonly IFileChangeSourceFactory _changes;
    private readonly ConcurrentDictionary<string, byte> _signals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Candidate> _candidates = new(StringComparer.Ordinal);
    private readonly TimeZoneInfo? _zone;
    private IFileChangeSource? _watcher;
    private DateTimeOffset _lastSweep = DateTimeOffset.MinValue;
    private DateTimeOffset? _baseline;

    public ScreenshotCollector(CollectorContext context, IFileSystemSource? fs = null, IFileChangeSourceFactory? changes = null,
        ScreenshotSettings? settings = null, TimeZoneInfo? localZone = null)
        : base(CollectorNames.Screenshots, context, settings)
    {
        _fs = fs ?? PhysicalFileSystemSource.Instance;
        _changes = changes ?? FileSystemWatcherChangeSourceFactory.Instance;
        _zone = localZone;
    }

    public override TimeSpan Interval => TimeSpan.FromSeconds(1);

    public int PendingCandidates => _candidates.Count + _signals.Count;

    protected override void Validate(ScreenshotSettings s)
    {
        if (s.DebounceSeconds < 0) throw new ArgumentException("debounceSeconds must be >= 0");
        if (s.SweepSeconds < 1) throw new ArgumentException("sweepSeconds must be >= 1");
        if (s.MaxBytes < 1) throw new ArgumentException("maxBytes must be positive");
        foreach (var r in s.Roots)
            if (string.IsNullOrWhiteSpace(r) || !Path.IsPathFullyQualified(r)) throw new ArgumentException($"root '{r}' must be an absolute path");
    }

    public override Task StartAsync(CancellationToken ct)
    {
        var roots = Settings.Roots.Where(r => _fs.Stat(r) is { IsDirectory: true }).ToList();
        if (roots.Count > 0)
        {
            _watcher = _changes.Create();
            _watcher.Changed += c => _signals[c.Path] = 0;
            _watcher.Overflowed += _ => _lastSweep = DateTimeOffset.MinValue;
            _watcher.Watch(roots, includeSubdirectories: false);
        }
        // uploadExisting=false: files older than the first start are never uploaded.
        _baseline = null;
        if (!Settings.UploadExisting)
        {
            var saved = Context.Settings.LoadJson(Name, "baseline")?.GetValue<string>();
            if (saved is null) Context.Settings.SaveJson(Name, "baseline", saved = IvyTime.Format(Now));
            _baseline = IvyTime.Parse(saved);
        }
        Cursor = $"seen:{SeenCount()}";
        return Task.CompletedTask;
    }

    public override Task StopAsync()
    {
        _watcher?.Dispose();
        _watcher = null;
        return Task.CompletedTask;
    }

    /// <summary>What the watcher does: mark a path as possibly new/changed.</summary>
    public void NotifyChanged(string path) => _signals[path] = 0;

    public override Task<CommandOutcome> RescanAsync(string? scope, CancellationToken ct)
    {
        _lastSweep = DateTimeOffset.MinValue;
        return Task.FromResult(CommandOutcome.Done("screenshot folders will be re-listed"));
    }

    public override Task TickAsync(CancellationToken ct)
    {
        var sink = Sink;
        if (sink is null) return Task.CompletedTask;
        var now = Now;
        var missing = Settings.Roots.Where(r => _fs.Stat(r) is not { IsDirectory: true }).ToList();
        if (missing.Count > 0) SetError($"screenshot folder not found: {string.Join(", ", missing)}");

        if (now - _lastSweep >= TimeSpan.FromSeconds(Settings.SweepSeconds)) Sweep(now);
        foreach (var path in _signals.Keys.ToList())
        {
            _signals.TryRemove(path, out _);
            if (IsCandidatePath(path)) Observe(path, now, fromSweep: false);
        }

        var debounce = TimeSpan.FromSeconds(Settings.DebounceSeconds);
        foreach (var (path, c) in _candidates.ToList())
        {
            ct.ThrowIfCancellationRequested();
            var st = _fs.Stat(path);
            if (st is null || st.IsDirectory) { _candidates.Remove(path); continue; }
            if (st.Size != c.Size || st.LastWriteUtc != c.Mtime)
            {
                c.Size = st.Size;
                c.Mtime = st.LastWriteUtc;
                c.StableSince = now;
                continue;
            }
            if (st.Size == 0 || now - c.StableSince < debounce) continue;
            if (!_fs.IsReadableWithoutWriters(path)) continue; // still being written
            if (st.Size > Settings.MaxBytes)
            {
                SetError($"screenshot larger than {Settings.MaxBytes} bytes skipped");
                _candidates.Remove(path);
                continue;
            }
            try
            {
                Capture(sink, st, now);
                _candidates.Remove(path);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                c.StableSince = now; // retry after another debounce period
            }
        }
        Cursor = $"seen:{SeenCount()}";
        Detail = _candidates.Count > 0 ? $"{_candidates.Count} file(s) waiting to settle" : null;
        return Task.CompletedTask;
    }

    private bool IsCandidatePath(string path)
    {
        var ext = PathUtil.Ext(path);
        if (!Settings.Extensions.Contains(ext, StringComparer.OrdinalIgnoreCase)) return false;
        var dir = Path.GetDirectoryName(path);
        return dir is not null && Settings.Roots.Any(r => PathUtil.Full(r).Equals(PathUtil.Full(dir), PathUtil.Comparison));
    }

    private void Sweep(DateTimeOffset now)
    {
        _lastSweep = now;
        foreach (var root in Settings.Roots)
        {
            IEnumerable<FsEntry> entries;
            try { entries = _fs.EnumerateDirectory(root).ToList(); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { continue; }
            foreach (var e in entries)
            {
                if (e.IsDirectory || !IsCandidatePath(e.FullPath)) continue;
                if (_baseline is { } b && e.LastWriteUtc < b) continue;
                if (IsKnown(e)) continue;
                Observe(e.FullPath, now, fromSweep: true);
            }
        }
    }

    private void Observe(string path, DateTimeOffset now, bool fromSweep)
    {
        var st = _fs.Stat(path);
        if (st is null || st.IsDirectory) return;
        if (fromSweep && _candidates.ContainsKey(path)) return;
        if (_candidates.TryGetValue(path, out var c) && c.Size == st.Size && c.Mtime == st.LastWriteUtc) return;
        _candidates[path] = new Candidate { Size = st.Size, Mtime = st.LastWriteUtc, StableSince = now };
    }

    private void Capture(IRecordSink sink, FsEntry st, DateTimeOffset now)
    {
        string sha;
        using (var s = _fs.OpenRead(st.FullPath)) sha = Bytes.ToHex(SHA256.HashData(s));
        if (LookupSha(sha))
        {
            Remember(sha, st, blobOid: null, now); // same bytes already uploaded (copy, rename, re-save)
            return;
        }

        (int Width, int Height)? dims;
        DateTimeOffset? exif;
        using (var s = _fs.OpenRead(st.FullPath)) dims = ImageMetadata.Dimensions(s);
        using (var s = _fs.OpenRead(st.FullPath)) exif = ImageMetadata.TakenAt(s, _zone);

        EnqueuedBlob blob;
        using (var s = _fs.OpenRead(st.FullPath))
        {
            if (s.Length != st.Size) throw new IOException("file changed while uploading");
            blob = EmitBlob(sink, s, PayloadKinds.Screenshot, s.Length);
        }
        if (!string.Equals(blob.PlaintextSha256, sha, StringComparison.Ordinal)) sha = blob.PlaintextSha256; // record what was actually sent

        var takenAt = exif ?? st.CreationUtc;
        var record = new ScreenshotRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = IvyTime.Format(takenAt),
            CaptureTime = IvyTime.Format(now),
            SourcePath = st.FullPath,
            Width = dims?.Width,
            Height = dims?.Height,
            Sha256 = sha,
            BlobOid = blob.Oid,
            TakenAt = IvyTime.Format(takenAt),
            SavedAt = IvyTime.Format(st.LastWriteUtc),
        };
        Emit(sink, record);
        Remember(sha, st, blob.Oid, now);
    }

    // ------------------------------------------------------------ screenshot_seen / screenshot_files

    private bool IsKnown(FsEntry e)
    {
        using var c = Context.Db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM screenshot_files WHERE path = $p AND size = $s AND mtime = $m";
        cmd.Parameters.AddWithValue("$p", e.FullPath);
        cmd.Parameters.AddWithValue("$s", e.Size);
        cmd.Parameters.AddWithValue("$m", IvyTime.Format(e.LastWriteUtc));
        return cmd.ExecuteScalar() is not null;
    }

    private bool LookupSha(string sha)
    {
        using var c = Context.Db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM screenshot_seen WHERE sha256 = $h";
        cmd.Parameters.AddWithValue("$h", sha);
        return cmd.ExecuteScalar() is not null;
    }

    private void Remember(string sha, FsEntry e, string? blobOid, DateTimeOffset now)
    {
        using var c = Context.Db.Open();
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO screenshot_files(path, size, mtime, sha256) VALUES ($p, $s, $m, $h)
            ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256;
            """;
        cmd.Parameters.AddWithValue("$h", sha);
        cmd.Parameters.AddWithValue("$p", e.FullPath);
        cmd.Parameters.AddWithValue("$s", e.Size);
        cmd.Parameters.AddWithValue("$m", IvyTime.Format(e.LastWriteUtc));
        cmd.ExecuteNonQuery();
        if (blobOid is not null)
        {
            cmd.Parameters.Clear();
            cmd.CommandText = "INSERT OR IGNORE INTO screenshot_seen(sha256, blob_oid, first_path, captured_at) VALUES ($h, $o, $p, $t)";
            cmd.Parameters.AddWithValue("$h", sha);
            cmd.Parameters.AddWithValue("$o", blobOid);
            cmd.Parameters.AddWithValue("$p", e.FullPath);
            cmd.Parameters.AddWithValue("$t", IvyTime.Format(now));
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }

    private int SeenCount()
    {
        using var c = Context.Db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM screenshot_seen";
        return (int)(long)cmd.ExecuteScalar()!;
    }
}
