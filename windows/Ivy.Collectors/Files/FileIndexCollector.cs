using System.Collections.Concurrent;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Collectors.Thumbnails;
using Ivy.Core.Commands;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Microsoft.Extensions.Logging;

namespace Ivy.Collectors.Files;

/// <summary>Persisted progress of a full scan (<c>collector.files.scan</c>); survives restarts.</summary>
public sealed class FileScanState
{
    public required string ScanId { get; init; }
    public required string StartedAt { get; init; }
    public required string Reason { get; init; }
    public required IReadOnlyList<string> Roots { get; init; }
    public int RootIndex { get; set; }
    /// <summary>Relative path ('/'-joined) of the last directory whose files were committed; null = root not started.</summary>
    public string? Checkpoint { get; set; }
    public long FilesSeen { get; set; }
    public long FilesEmitted { get; set; }
    /// <summary>Fingerprint of roots + exclusion rules the scan was started with.</summary>
    public string? Config { get; init; }
}

/// <summary>Result of the last completed full scan (<c>collector.files.lastFullScan</c>).</summary>
public sealed class FileScanSummary
{
    public required string CompletedAt { get; init; }
    public required string Reason { get; init; }
    public long FilesSeen { get; init; }
    public long FilesEmitted { get; init; }
    public long Deleted { get; init; }
    public IReadOnlyList<string> Roots { get; init; } = Array.Empty<string>();
    public string? Config { get; init; }
}

/// <summary>
/// WC1/WC2/WC6 file index. Emits <c>file_meta</c> (metadata always, originals only on request) for every
/// admitted file under the configured roots:
/// <list type="bullet">
/// <item>Full scan (initial, every <see cref="FileIndexSettings.FullRescanHours"/>, on <c>rescan</c>): a
/// deterministic walk processed <see cref="FileIndexSettings.ScanBatchSize"/> files per tick, with a
/// persisted checkpoint so a restart continues where it stopped. Unchanged files (same mtime in
/// <c>file_cache</c>) are not re-read. At the end of each root, cached files not seen in the scan are
/// recorded as deleted.</item>
/// <item>Incremental: FileSystemWatcher on all platforms, plus the NTFS USN journal on Windows (cursor =
/// next USN per volume in <c>collector_state.cursor</c>). Events are debounced and re-stat'ed.</item>
/// </list>
/// Deletions: an observed deletion (watcher delete, USN delete reason, or a file missing in a rescan) is
/// recorded in <c>file_tombstones</c>, the <c>file_cache</c> row is removed, an activity entry is written,
/// and a <c>file_meta</c> with <c>deleted: true</c> (PROTOCOL.md §6) is emitted to the Mac.
/// </summary>
public sealed class FileIndexCollector : Collector<FileIndexSettings>
{
    private const string ScanKey = "scan";
    private const string LastScanKey = "lastFullScan";

    private readonly IFileSystemSource _fs;
    private readonly IFileChangeSourceFactory _changes;
    private readonly IUsnJournal? _usn;
    private readonly IThumbnailGenerator? _thumbs;
    private readonly FileIndexStore _store;
    private readonly ConcurrentDictionary<string, DateTimeOffset> _pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, UsnPosition> _usnPositions = new(StringComparer.OrdinalIgnoreCase);

    private ExclusionMatcher _exclusions;
    private IFileChangeSource? _watcher;
    private FileScanState? _scan;
    private ScanWalker? _walker;
    private IEnumerator<DirectoryBatch>? _walk;
    private string? _pendingScanReason;
    private string? _pendingScope;
    private DateTimeOffset _lastUsnPoll = DateTimeOffset.MinValue;
    private string? _usnNote;
    private FileScanSummary? _lastFullScan;
    private DateTimeOffset _lastProgressLog = DateTimeOffset.MinValue;

    public FileIndexCollector(CollectorContext context, IFileSystemSource? fs = null, IFileChangeSourceFactory? changes = null,
        IUsnJournal? usn = null, IThumbnailGenerator? thumbnails = null, FileIndexSettings? settings = null)
        : base(CollectorNames.Files, context, settings)
    {
        _fs = fs ?? PhysicalFileSystemSource.Instance;
        _changes = changes ?? FileSystemWatcherChangeSourceFactory.Instance;
        _usn = usn;
        _thumbs = thumbnails;
        _store = new FileIndexStore(context.Db);
        _exclusions = BuildMatcher(Settings);
    }

    public override TimeSpan Interval => TimeSpan.FromSeconds(1);

    /// <summary>The in-progress full scan, if any (for the UI's import progress).</summary>
    public FileScanState? CurrentScan => _scan;

    public FileScanSummary? LastFullScan => _lastFullScan ??= Context.Settings.Load<FileScanSummary>(Name, LastScanKey);

    public int PendingChanges => _pending.Count;

    /// <summary>Paths known only through deletion (file_tombstones).</summary>
    public bool IsTombstoned(string path) => _store.IsTombstoned(path);

    protected override void Validate(FileIndexSettings s)
    {
        if (s.ScanBatchSize is < 1 or > 100_000) throw new ArgumentException("scanBatchSize must be 1..100000");
        if (s.FullRescanHours < 0) throw new ArgumentException("fullRescanHours must be >= 0");
        if (s.UsnPollSeconds < 1) throw new ArgumentException("usnPollSeconds must be >= 1");
        if (s.ChangeDebounceSeconds < 0) throw new ArgumentException("changeDebounceSeconds must be >= 0");
        if (s.ThumbnailMaxBytes < 0) throw new ArgumentException("thumbnailMaxBytes must be >= 0");
        foreach (var r in s.Roots)
            if (string.IsNullOrWhiteSpace(r) || !Path.IsPathFullyQualified(r)) throw new ArgumentException($"root '{r}' must be an absolute path");
        _ = new ExclusionMatcher(s.Exclusions);
    }

    protected override void OnSettingsChanged(FileIndexSettings previous, FileIndexSettings current) => _exclusions = BuildMatcher(current);

    /// <summary>What a full scan depends on. A scan or summary with a different fingerprint is stale (folders or rules changed).</summary>
    private string ConfigFingerprint() => string.Join("|",
        string.Join(";", Settings.Roots.Select(PathUtil.Full)),
        string.Join(";", Settings.Exclusions),
        Settings.IncludeHidden ? "h" : "-",
        Settings.IncludeSystem ? "s" : "-");

    private ExclusionMatcher BuildMatcher(FileIndexSettings s)
    {
        // Never index the agent's own data directory (queue files change constantly).
        var dataDir = Path.GetDirectoryName(Path.GetFullPath(Context.Db.Path));
        var patterns = s.Exclusions.ToList();
        if (!string.IsNullOrEmpty(dataDir)) patterns.Add(Glob.Normalize(dataDir));
        return new ExclusionMatcher(patterns);
    }

    public override Task StartAsync(CancellationToken ct)
    {
        _scan = Context.Settings.Load<FileScanState>(Name, ScanKey);
        foreach (var (k, v) in UsnCursor.Parse(Context.States.Get(Name)?.Cursor)) _usnPositions[k] = v;
        var roots = ExistingRoots();
        if (roots.Count > 0)
        {
            _watcher = _changes.Create();
            _watcher.Changed += c => _pending[c.Path] = Now;
            _watcher.Overflowed += r => RequestScan("watcher_overflow", null, restart: false);
            _watcher.Watch(roots, includeSubdirectories: true);
        }
        if (_scan is not null) Activity(CollectorActivity.ScanStarted, $"resuming scan {_scan.ScanId} at root {_scan.RootIndex + 1}/{_scan.Roots.Count}, {_scan.FilesSeen} files seen");
        UpdateCursorAndDetail();
        return Task.CompletedTask;
    }

    public override Task StopAsync()
    {
        _watcher?.Dispose();
        _watcher = null;
        _walk?.Dispose();
        _walk = null;
        _walker = null;
        return Task.CompletedTask;
    }

    /// <summary>Queue a path as changed (what the watcher and USN reader do).</summary>
    public void NotifyChanged(string path) => _pending[path] = Now;

    /// <summary>Schedule a full scan (or a subtree scan when <paramref name="scope"/> is given) for the next tick.</summary>
    public void RequestScan(string reason, string? scope, bool restart)
    {
        if (_scan is not null && !restart) return;
        _pendingScanReason = reason;
        _pendingScope = scope;
    }

    public override Task<CommandOutcome> RescanAsync(string? scope, CancellationToken ct)
    {
        if (Settings.Roots.Count == 0) return Task.FromResult(CommandOutcome.Error("no folders selected"));
        if (!string.IsNullOrEmpty(scope))
        {
            if (!Path.IsPathFullyQualified(scope)) return Task.FromResult(CommandOutcome.Error("scope must be an absolute path"));
            if (!Settings.Roots.Any(r => PathUtil.IsUnderOrEqual(scope, r))) return Task.FromResult(CommandOutcome.Error("scope is outside the selected folders"));
        }
        if (_scan is not null && string.IsNullOrEmpty(scope))
            return Task.FromResult(CommandOutcome.Done($"full scan already in progress ({_scan.FilesSeen} files seen)"));
        RequestScan("command", string.IsNullOrEmpty(scope) ? null : scope, restart: false);
        return Task.FromResult(CommandOutcome.Done(string.IsNullOrEmpty(scope) ? "full rescan scheduled" : "rescan of scope scheduled"));
    }

    public override Task TickAsync(CancellationToken ct)
    {
        var sink = Sink;
        if (sink is null) return Task.CompletedTask;
        if (Settings.Roots.Count == 0)
        {
            Detail = "no folders selected";
            return Task.CompletedTask;
        }
        var missing = Settings.Roots.Where(r => _fs.Stat(r) is not { IsDirectory: true }).ToList();
        if (missing.Count > 0) SetError($"folder not available: {string.Join(", ", missing)}");

        PollUsn();
        StartScanIfDue();
        ProcessChanges(sink, flushAll: false);
        if (_scan is not null) ScanStep(sink, Settings.ScanBatchSize, ct);
        UpdateCursorAndDetail();
        return Task.CompletedTask;
    }

    /// <summary>Test/maintenance helper: run the full scan to completion now.</summary>
    public void RunScanToCompletion(CancellationToken ct = default)
    {
        var sink = Sink ?? throw new InvalidOperationException("no sink (not paired)");
        StartScanIfDue();
        while (_scan is not null && !ct.IsCancellationRequested) ScanStep(sink, Settings.ScanBatchSize, ct);
        UpdateCursorAndDetail();
    }

    /// <summary>Test helper: process every queued change immediately, ignoring the debounce.</summary>
    public void FlushChanges()
    {
        var sink = Sink ?? throw new InvalidOperationException("no sink (not paired)");
        ProcessChanges(sink, flushAll: true);
        UpdateCursorAndDetail();
    }

    // ---------------------------------------------------------------- full scan

    private void StartScanIfDue()
    {
        var config = ConfigFingerprint();
        // Folders or rules changed since the in-progress scan began: restart it with the new settings.
        if (_scan is not null && _pendingScanReason is null && _scan.Config is not null && _scan.Config != config && !_scan.Reason.EndsWith(":scope", StringComparison.Ordinal))
            _pendingScanReason = "settings_changed";
        if (_scan is not null && _pendingScanReason is null) return;
        string? reason = _pendingScanReason;
        var scope = _pendingScope;
        if (reason is null)
        {
            var last = LastFullScan;
            if (last is null) reason = "initial";
            else if (last.Config is not null && last.Config != config) reason = "settings_changed";
            else if (Settings.FullRescanHours > 0 && IvyTime.Parse(last.CompletedAt) + TimeSpan.FromHours(Settings.FullRescanHours) <= Now) reason = "periodic";
            else return;
        }
        _pendingScanReason = null;
        _pendingScope = null;
        _walk?.Dispose();
        _walk = null;
        var roots = scope is not null ? new[] { PathUtil.Full(scope) } : Settings.Roots.Select(PathUtil.Full).Distinct().ToArray();
        _scan = new FileScanState
        {
            ScanId = Guid.NewGuid().ToString("N")[..12],
            StartedAt = IvyTime.Format(Now),
            Reason = scope is not null ? reason + ":scope" : reason,
            Roots = roots,
            Config = config,
        };
        SaveScan();
        Activity(CollectorActivity.ScanStarted, $"scan {_scan.ScanId} ({_scan.Reason}) of {roots.Length} root(s)");
    }

    private void ScanStep(IRecordSink sink, int budget, CancellationToken ct)
    {
        var scan = _scan!;
        var processed = 0;
        using var batch = _store.BeginBatch();
        var nowStr = IvyTime.Format(Now);
        while (processed < budget && !ct.IsCancellationRequested)
        {
            if (scan.RootIndex >= scan.Roots.Count)
            {
                batch.Commit();
                CompleteScan(scan);
                return;
            }
            var root = scan.Roots[scan.RootIndex];
            if (_walk is null)
            {
                _walker = new ScanWalker(_fs, _exclusions, Settings.IncludeHidden, Settings.IncludeSystem);
                _walk = _walker.Walk(root, scan.Checkpoint).GetEnumerator();
            }
            if (!_walk.MoveNext())
            {
                batch.Commit();
                var deleted = SweepRoot(sink, root, scan.StartedAt, _walker!.FailedDirectories);
                _walk.Dispose();
                _walk = null;
                scan.RootIndex++;
                scan.Checkpoint = null;
                SaveScan();
                if (deleted > 0) Activity(CollectorActivity.Deleted, $"{deleted} file(s) no longer present under a scanned root");
                continue;
            }
            var dir = _walk.Current;
            foreach (var f in dir.Files)
            {
                if (ProcessFile(sink, batch, f, nowStr)) scan.FilesEmitted++;
                scan.FilesSeen++;
                processed++;
            }
            scan.Checkpoint = dir.RelativePath;
        }
        batch.Commit();
        SaveScan();
        if (Now - _lastProgressLog >= TimeSpan.FromSeconds(30))
        {
            _lastProgressLog = Now;
            Activity(CollectorActivity.ScanProgress, $"scan {scan.ScanId}: {scan.FilesSeen} files seen, {scan.FilesEmitted} new/changed");
        }
    }

    private void CompleteScan(FileScanState scan)
    {
        var summary = new FileScanSummary
        {
            CompletedAt = IvyTime.Format(Now),
            Reason = scan.Reason,
            FilesSeen = scan.FilesSeen,
            FilesEmitted = scan.FilesEmitted,
            Roots = scan.Roots,
            Config = scan.Config,
        };
        // A scoped rescan does not reset the periodic schedule.
        if (!scan.Reason.EndsWith(":scope", StringComparison.Ordinal))
        {
            Context.Settings.Save(Name, LastScanKey, summary);
            _lastFullScan = summary;
        }
        _scan = null;
        Context.Settings.Save<FileScanState>(Name, ScanKey, null);
        Activity(CollectorActivity.ScanCompleted, $"scan {scan.ScanId} ({scan.Reason}): {scan.FilesSeen} files, {scan.FilesEmitted} new/changed");
    }

    private void SaveScan() => Context.Settings.Save(Name, ScanKey, _scan);

    /// <summary>Cached files under a fully walked root that the scan did not see: deleted, or now excluded.</summary>
    private int SweepRoot(IRecordSink sink, string root, string scanStartedAt, IReadOnlyList<string> failedDirs)
    {
        if (_fs.Stat(root) is not { IsDirectory: true }) return 0; // unmounted drive: never mass-delete
        var stale = _store.StaleUnder(root, scanStartedAt);
        if (stale.Count == 0) return 0;
        var now = IvyTime.Format(Now);
        var deleted = 0;
        using var batch = _store.BeginBatch();
        foreach (var (path, hash, fileId) in stale)
        {
            if (failedDirs.Any(d => PathUtil.IsUnderOrEqual(path, d))) continue;
            var st = _fs.Stat(path);
            if (st is null)
            {
                batch.Tombstone(path, hash, fileId, now, "deleted");
                EmitDeletion(sink, path, now);
                deleted++;
            }
            else if (!st.IsDirectory && !Admitted(path, st))
            {
                batch.Tombstone(path, hash, fileId, now, "excluded");
            }
            else
            {
                batch.Touch(path, now);
            }
        }
        batch.Commit();
        return deleted;
    }

    // ---------------------------------------------------------------- per file

    private bool ProcessFile(IRecordSink sink, FileIndexStore.Batch batch, FsEntry f, string nowStr)
    {
        var mtime = IvyTime.Format(f.LastWriteUtc);
        var cached = batch.Get(f.FullPath);
        if (cached is { } c && c.Mtime == mtime)
        {
            batch.Touch(f.FullPath, nowStr);
            return false;
        }
        string hash;
        try
        {
            using var s = _fs.OpenRead(f.FullPath);
            hash = QuickHash.Compute(s);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return false; // locked or unreadable: picked up by the next change event or scan
        }

        var ext = PathUtil.Ext(f.Name);
        string? thumb = null;
        if (Settings.Thumbnails && _thumbs is not null && _thumbs.Supports(ext) && f.Size > 0 && f.Size <= Settings.ThumbnailMaxBytes)
        {
            thumb = batch.GetThumb(f.FullPath, hash);
            if (thumb is null)
            {
                thumb = MakeThumbnail(sink, f.FullPath, ext);
                if (thumb is not null) batch.SetThumb(f.FullPath, hash, thumb);
            }
        }

        var record = new FileMetaRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = mtime,
            CaptureTime = nowStr,
            Path = f.FullPath,
            Name = f.Name,
            Size = f.Size,
            Ext = ext,
            Mtime = mtime,
            QuickHash = hash,
            ThumbBlobOid = thumb,
        };
        var r = Emit(sink, record);
        batch.Upsert(f.FullPath, hash, mtime, nowStr, r.Oid);
        return true;
    }

    /// <summary>Emit a <c>file_meta</c> deletion (PROTOCOL.md §6) alongside the <c>file_tombstones</c> bookkeeping.</summary>
    private void EmitDeletion(IRecordSink sink, string path, string nowStr)
    {
        var name = Path.GetFileName(path);
        Emit(sink, new FileMetaRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = nowStr, // for a deletion, eventTime is when the deletion was observed
            CaptureTime = nowStr,
            Path = path,
            Name = name,
            Ext = PathUtil.Ext(name),
            Deleted = true,
            // size/mtime/quickHash intentionally omitted for a deletion
        });
    }

    private string? MakeThumbnail(IRecordSink sink, string path, string ext)
    {
        byte[]? jpeg;
        try
        {
            using var s = _fs.OpenRead(path);
            jpeg = _thumbs!.Generate(s, ext);
        }
        catch (Exception e) when (e is not OutOfMemoryException and not OperationCanceledException)
        {
            Logger.LogDebug(e, "thumbnail generation failed");
            return null;
        }
        if (jpeg is null) return null;
        using var ms = new MemoryStream(jpeg, writable: false);
        return EmitBlob(sink, ms, PayloadKinds.Thumbnail, jpeg.Length).Oid;
    }

    // ---------------------------------------------------------------- incremental

    private void ProcessChanges(IRecordSink sink, bool flushAll)
    {
        if (_pending.IsEmpty) return;
        var now = Now;
        var debounce = TimeSpan.FromSeconds(Settings.ChangeDebounceSeconds);
        var ready = new List<string>();
        foreach (var (path, at) in _pending)
            if (flushAll || now - at >= debounce)
                if (_pending.TryRemove(new KeyValuePair<string, DateTimeOffset>(path, at))) ready.Add(path);
        if (ready.Count == 0) return;

        var nowStr = IvyTime.Format(now);
        var roots = Settings.Roots.Select(PathUtil.Full).ToList();
        using var batch = _store.BeginBatch();
        foreach (var raw in ready.Distinct(StringComparer.Ordinal))
        {
            string path;
            try { path = PathUtil.Full(raw); }
            catch (ArgumentException) { continue; }
            var root = roots.FirstOrDefault(r => PathUtil.IsUnderOrEqual(path, r));
            if (root is null || _exclusions.IsExcluded(path)) continue;
            var st = _fs.Stat(path);
            if (st is null)
            {
                if (batch.Get(path) is { } c)
                {
                    batch.Tombstone(path, c.QuickHash, c.FileId, nowStr, "deleted");
                    EmitDeletion(sink, path, nowStr);
                    Activity(CollectorActivity.Deleted, "1 file");
                }
                else
                {
                    var under = _store.Under(path);
                    foreach (var (p, h, id) in under)
                    {
                        batch.Tombstone(p, h, id, nowStr, "deleted");
                        EmitDeletion(sink, p, nowStr);
                    }
                    if (under.Count > 0) Activity(CollectorActivity.Deleted, $"{under.Count} file(s) under a removed folder");
                }
                continue;
            }
            if (!AncestorsAdmitted(path, root)) continue;
            var walker = new ScanWalker(_fs, _exclusions, Settings.IncludeHidden, Settings.IncludeSystem);
            if (!walker.Admit(st)) continue;
            if (st.IsDirectory)
            {
                foreach (var d in walker.Walk(path, null))
                    foreach (var f in d.Files) ProcessFile(sink, batch, f, nowStr);
            }
            else
            {
                ProcessFile(sink, batch, st, nowStr);
            }
        }
        batch.Commit();
    }

    private bool Admitted(string path, FsEntry st)
    {
        var root = Settings.Roots.Select(PathUtil.Full).FirstOrDefault(r => PathUtil.IsUnderOrEqual(path, r));
        if (root is null || _exclusions.IsExcluded(path)) return false;
        return AncestorsAdmitted(path, root) && new ScanWalker(_fs, _exclusions, Settings.IncludeHidden, Settings.IncludeSystem).Admit(st);
    }

    /// <summary>Hidden/system/reparse directories between the root and the path also exclude it.</summary>
    private bool AncestorsAdmitted(string path, string root)
    {
        var dir = Path.GetDirectoryName(path);
        while (dir is not null && !PathUtil.Full(dir).Equals(root, PathUtil.Comparison) && PathUtil.IsUnderOrEqual(dir, root))
        {
            var st = _fs.Stat(dir);
            if (st is null) return false;
            if (st.IsReparsePoint || (!Settings.IncludeHidden && st.Hidden) || (!Settings.IncludeSystem && st.System)) return false;
            dir = Path.GetDirectoryName(dir);
        }
        return true;
    }

    // ---------------------------------------------------------------- USN journal (Windows)

    private void PollUsn()
    {
        if (_usn is null || !Settings.UseUsnJournal) return;
        if (Now - _lastUsnPoll < TimeSpan.FromSeconds(Settings.UsnPollSeconds)) return;
        _lastUsnPoll = Now;
        var roots = Settings.Roots.Select(PathUtil.Full).ToList();
        var notes = new List<string>();
        foreach (var volume in roots.Select(Path.GetPathRoot).Where(v => !string.IsNullOrEmpty(v)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var vol = volume!;
            UsnJournalInfo info;
            try { info = _usn.Query(vol); }
            catch (UnauthorizedAccessException) { notes.Add($"USN journal on {vol} needs elevation; using FileSystemWatcher only"); continue; }
            catch (NotSupportedException) { notes.Add($"no USN journal on {vol}; using FileSystemWatcher only"); continue; }
            catch (IOException e) { notes.Add($"USN journal on {vol} unavailable ({e.Message}); using FileSystemWatcher only"); continue; }

            if (!_usnPositions.TryGetValue(vol, out var pos))
            {
                // First sight of this volume: the full scan covers the past; follow from now on.
                _usnPositions[vol] = new UsnPosition(info.JournalId, info.NextUsn);
                continue;
            }
            if (pos.JournalId != info.JournalId || pos.NextUsn < info.FirstUsn)
            {
                // Journal recreated or wrapped past our cursor: events were lost, so rescan (principle 4: never pretend).
                _usnPositions[vol] = new UsnPosition(info.JournalId, info.NextUsn);
                RequestScan(pos.JournalId != info.JournalId ? "usn_journal_reset" : "usn_journal_wrapped", null, restart: false);
                continue;
            }
            var next = pos.NextUsn;
            for (var i = 0; i < 64 && next < info.NextUsn; i++)
            {
                UsnReadResult res;
                try { res = _usn.Read(vol, info.JournalId, next, 4096); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    notes.Add($"USN read on {vol} failed ({e.Message})");
                    break;
                }
                foreach (var ch in res.Changes)
                {
                    if ((ch.Reason & UsnReasons.Relevant) == 0 || ch.FullPath is null) continue;
                    if (roots.Any(r => PathUtil.IsUnderOrEqual(ch.FullPath, r))) _pending[ch.FullPath] = DateTimeOffset.MinValue; // due now
                }
                if (res.NextUsn <= next) break;
                next = res.NextUsn;
            }
            _usnPositions[vol] = pos with { NextUsn = next };
        }
        _usnNote = notes.Count > 0 ? string.Join("; ", notes) : null;
    }

    private void UpdateCursorAndDetail()
    {
        if (_usnPositions.Count > 0) Cursor = UsnCursor.Format(_usnPositions);
        else if (LastFullScan is { } l) Cursor = $"scan:{l.CompletedAt}";
        var parts = new List<string>();
        if (_scan is { } s) parts.Add($"scanning ({s.Reason}): root {Math.Min(s.RootIndex + 1, s.Roots.Count)}/{s.Roots.Count}, {s.FilesSeen} files seen, {s.FilesEmitted} new/changed");
        else if (LastFullScan is { } last) parts.Add($"last full scan {last.CompletedAt}: {last.FilesSeen} files");
        if (_usnNote is not null) parts.Add(_usnNote);
        else if (_usn is null) parts.Add(OperatingSystem.IsWindows() ? "USN journal off; FileSystemWatcher only" : "FileSystemWatcher only (no USN journal on this platform)");
        if (Settings.Roots.Count == 0) parts.Add("no folders selected");
        Detail = string.Join("; ", parts);
    }

    private List<string> ExistingRoots() =>
        Settings.Roots.Select(PathUtil.Full).Where(r => _fs.Stat(r) is { IsDirectory: true }).Distinct().ToList();
}
