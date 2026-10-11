using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json.Nodes;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Collectors.Screenshots;
using Ivy.Collectors.Thumbnails;
using Ivy.Core.Commands;
using Ivy.Core.Policy;
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
    /// <summary>Admitted files under the scan's roots, from a metadata-only counting walk; null until counted.</summary>
    public long? FilesTotal { get; set; }
    /// <summary>True when no full scan had completed before this one (the initial index), false for a rescan.</summary>
    public bool Initial { get; init; }
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
/// WC1/WC2 file index with the PLAN decision 8 media policy. Emits <c>file_meta</c> for every admitted file
/// under the configured roots:
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
/// <para>
/// Media policy (PLAN decision 8, supersedes PRD WC6): an image (<see cref="FileIndexSettings.ImageExtensions"/>, up to
/// <see cref="FileIndexSettings.ImageCapMB"/>) or a document (<see cref="FileIndexSettings.DocumentExtensions"/>, up to
/// <see cref="FileIndexSettings.DocumentCapMB"/>) also has its original uploaded, as a chunked blob of payload kind
/// <c>photo</c> or <c>document</c>, named by <c>file_meta.originalBlobOid</c>. Originals are deduplicated by quick hash +
/// size in <c>file_originals</c> (a moved or copied file names the existing blob; a modified file uploads again). The
/// metadata record is emitted first; the original is read and encrypted on a later tick into the upload queue's bulk
/// lane (records always drain first), with at most <see cref="FileIndexSettings.MaxQueuedOriginalBytes"/> waiting, so
/// the bandwidth cap and pause hold the bulk back. Images directly in a Screenshots folder are the screenshots
/// collector's (payload kind <c>screenshot</c>) and are never uploaded here. A file that cannot be read for its
/// upload (locked, access denied) keeps its metadata, is logged as <c>original_failed</c>, and is retried when the
/// next full scan starts. Everything else stays metadata + thumbnail, original on request.
/// </para>
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
    // counting walk for the import total (enumeration only: no hashing, no records)
    private IEnumerator<DirectoryBatch>? _count;
    private int _countRoot;
    private long _counted;
    // media policy
    private HashSet<string> _imageExts = new(StringComparer.Ordinal);
    private HashSet<string> _documentExts = new(StringComparer.Ordinal);
    private (DateTimeOffset At, IReadOnlyList<string> Roots, HashSet<string> Exts)? _screenshotFolders;
    private string? _originalsNote;
    // one-time self-scope to the standard folders (see AutoScopeIfNeeded); null source = disabled
    private readonly Func<IReadOnlyList<string>>? _standardFolders;
    private const string AutoScopedKey = "autoScoped";

    public FileIndexCollector(CollectorContext context, IFileSystemSource? fs = null, IFileChangeSourceFactory? changes = null,
        IUsnJournal? usn = null, IThumbnailGenerator? thumbnails = null, FileIndexSettings? settings = null,
        Func<IReadOnlyList<string>>? standardFolders = null)
        : base(CollectorNames.Files, context, settings)
    {
        _standardFolders = standardFolders;
        _fs = fs ?? PhysicalFileSystemSource.Instance;
        _changes = changes ?? FileSystemWatcherChangeSourceFactory.Instance;
        _usn = usn;
        _thumbs = thumbnails;
        _store = new FileIndexStore(context.Db);
        _exclusions = BuildMatcher(Settings);
        BuildPolicy(Settings);
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
        if (!(s.ImageCapMB > 0 && s.ImageCapMB <= MediaPolicyDefaults.MaxCapMB)) throw new ArgumentException($"imageCapMB must be > 0 and <= {MediaPolicyDefaults.MaxCapMB}");
        if (!(s.DocumentCapMB > 0 && s.DocumentCapMB <= MediaPolicyDefaults.MaxCapMB)) throw new ArgumentException($"documentCapMB must be > 0 and <= {MediaPolicyDefaults.MaxCapMB}");
        foreach (var (name, list) in new[] { ("imageExtensions", s.ImageExtensions), ("documentExtensions", s.DocumentExtensions) })
            foreach (var e in list)
            {
                var n = MediaPolicyDefaults.NormalizeExtension(e);
                if (n.Length == 0 || n.IndexOfAny(new[] { '/', '\\', '*', '?', '.', ' ' }) >= 0) throw new ArgumentException($"{name}: '{e}' is not a file extension");
            }
        if (s.OriginalsBytesPerTick < 1) throw new ArgumentException("originalsBytesPerTick must be >= 1");
        if (s.MaxQueuedOriginalBytes < 0) throw new ArgumentException("maxQueuedOriginalBytes must be >= 0");
    }

    protected override void OnSettingsChanged(FileIndexSettings previous, FileIndexSettings current)
    {
        _exclusions = BuildMatcher(current);
        BuildPolicy(current);
    }

    private void BuildPolicy(FileIndexSettings s)
    {
        _imageExts = s.ImageExtensions.Select(MediaPolicyDefaults.NormalizeExtension).Where(e => e.Length > 0).ToHashSet(StringComparer.Ordinal);
        _documentExts = s.DocumentExtensions.Select(MediaPolicyDefaults.NormalizeExtension).Where(e => e.Length > 0).ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>What a full scan depends on. A scan or summary with a different fingerprint is stale (folders or rules changed).</summary>
    private string ConfigFingerprint() => string.Join("|",
        string.Join(";", Settings.Roots.Select(PathUtil.Full)),
        string.Join(";", Settings.Exclusions),
        Settings.IncludeHidden ? "h" : "-",
        Settings.IncludeSystem ? "s" : "-",
        // media policy: a change rescans, so unchanged files that now qualify get their original (cheap: no re-hash)
        string.Create(CultureInfo.InvariantCulture, $"img:{(Settings.AutoUploadImages ? 1 : 0)}:{Settings.ImageCapMB}:{string.Join(",", _imageExts.Order(StringComparer.Ordinal))}"),
        string.Create(CultureInfo.InvariantCulture, $"doc:{(Settings.AutoUploadDocuments ? 1 : 0)}:{Settings.DocumentCapMB}:{string.Join(",", _documentExts.Order(StringComparer.Ordinal))}"));

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
        AttachWatcher();
        if (_scan is not null) Activity(CollectorActivity.ScanStarted, $"resuming scan {_scan.ScanId} at root {_scan.RootIndex + 1}/{_scan.Roots.Count}, {_scan.FilesSeen} files seen");
        UpdateCursorAndDetail();
        return Task.CompletedTask;
    }

    /// <summary>(Re)attach the change watcher to the roots that exist now; none when there are no roots.</summary>
    private void AttachWatcher()
    {
        _watcher?.Dispose();
        _watcher = null;
        var roots = ExistingRoots();
        if (roots.Count == 0) return;
        _watcher = _changes.Create();
        _watcher.Changed += c => _pending[c.Path] = Now;
        _watcher.Overflowed += r => RequestScan("watcher_overflow", null, restart: false);
        _watcher.Watch(roots, includeSubdirectories: true);
    }

    /// <summary>
    /// Index the standard folders with no setup. On the first paired tick, if no roots are configured, set them to
    /// exactly what the Settings "Index my standard folders" button sets
    /// (<see cref="MediaPolicyDefaults.WithStandardFolders"/>: Documents, Pictures and Downloads where they exist),
    /// save them, and log one Config activity line. The <c>autoScoped</c> flag is saved on that first paired tick
    /// whether or not roots were already configured, so this runs at most once per install: a user who later
    /// clears the roots stays cleared, and a user who had already chosen roots never gets standard folders added.
    /// Like the catalogue's self-scope it waits for pairing, so an unpaired agent (and the unpaired app tests)
    /// never picks up folders. Disabled when no folder source was given: the host passes one only on Windows
    /// with platform defaults, so tests and non-Windows hosts never scope to the real machine unless the test
    /// supplies its own folders. Returns true when roots were set; the caller then re-attaches the watcher.
    /// </summary>
    private bool AutoScopeIfNeeded()
    {
        if (_standardFolders is null) return false;
        if (Context.Settings.LoadJson(Name, AutoScopedKey) is not null) return false;
        Context.Settings.SaveJson(Name, AutoScopedKey, JsonValue.Create("1"));
        if (Settings.Roots.Count > 0) return false; // the user already chose folders; leave them as they are
        var roots = MediaPolicyDefaults.WithStandardFolders(Settings.Roots, _standardFolders());
        if (roots.Count == 0) return false;
        var next = GetSettingsJson();
        next["roots"] = new JsonArray(roots.Select(r => (JsonNode?)r).ToArray());
        try { ApplySettings(next); }
        catch (ArgumentException e)
        {
            Activity(CollectorActivity.Config, $"could not index the standard folders automatically: {e.Message}");
            return false;
        }
        Context.Settings.SaveSettings(Name, next); // persist so it survives a restart
        Activity(CollectorActivity.Config, $"indexing standard folders automatically: {string.Join(", ", roots)}");
        return true;
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
        // First paired tick of a fresh install: take the standard folders, then do what the button's collector
        // restart does (attach the watcher). The scan below then starts this same tick ("initial").
        if (AutoScopeIfNeeded()) AttachWatcher();
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
        if (_scan is not null)
        {
            CountStep(Settings.ScanBatchSize * CountBudgetFactor, ct);
            ScanStep(sink, Settings.ScanBatchSize, ct);
        }
        // after this tick's metadata: originals go to the bulk lane, which drains after every record
        ProcessOriginals(sink, ct);
        UpdateCursorAndDetail();
        return Task.CompletedTask;
    }

    /// <summary>Directory entries counted per tick, as a multiple of the scan batch (counting does not read files).</summary>
    private const int CountBudgetFactor = 20;

    /// <summary>Test/maintenance helper: run the full scan to completion now.</summary>
    public void RunScanToCompletion(CancellationToken ct = default)
    {
        var sink = Sink ?? throw new InvalidOperationException("no sink (not paired)");
        StartScanIfDue();
        while (_scan is not null && !ct.IsCancellationRequested)
        {
            CountStep(Settings.ScanBatchSize * CountBudgetFactor, ct);
            ScanStep(sink, Settings.ScanBatchSize, ct);
        }
        UpdateCursorAndDetail();
    }

    /// <summary>Test helper: run only the counting walk of the current scan to completion (no files are read).</summary>
    public void RunCountToCompletion()
    {
        while (_scan is { FilesTotal: null }) CountStep(int.MaxValue, default);
        UpdateCursorAndDetail();
    }

    /// <summary>Test helper: process one tick's worth of the scan (count + scan batch) without the host.</summary>
    public void ScanTick()
    {
        var sink = Sink ?? throw new InvalidOperationException("no sink (not paired)");
        StartScanIfDue();
        if (_scan is not null)
        {
            CountStep(Settings.ScanBatchSize * CountBudgetFactor, default);
            ScanStep(sink, Settings.ScanBatchSize, default);
        }
        UpdateCursorAndDetail();
    }

    /// <summary>Test helper: enqueue every due original now (still honouring the queued-bytes limit and the policy).</summary>
    public void RunOriginalsToCompletion()
    {
        var sink = Sink ?? throw new InvalidOperationException("no sink (not paired)");
        for (var i = 0; i < 10_000 && ProcessOriginals(sink, default) > 0; i++) { }
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
        ResetCount();
        var roots = scope is not null ? new[] { PathUtil.Full(scope) } : Settings.Roots.Select(PathUtil.Full).Distinct().ToArray();
        _scan = new FileScanState
        {
            ScanId = Guid.NewGuid().ToString("N")[..12],
            StartedAt = IvyTime.Format(Now),
            Reason = scope is not null ? reason + ":scope" : reason,
            Roots = roots,
            Config = config,
            Initial = LastFullScan is null,
        };
        SaveScan();
        Activity(CollectorActivity.ScanStarted, $"scan {_scan.ScanId} ({_scan.Reason}) of {roots.Length} root(s)");
        var retried = _store.RetryFailedOriginals();
        if (retried > 0) Activity(CollectorActivity.ScanProgress, $"retrying {retried} original(s) that could not be read before");
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
        ResetCount();
        Context.Settings.Save<FileScanState>(Name, ScanKey, null);
        Activity(CollectorActivity.ScanCompleted, $"scan {scan.ScanId} ({scan.Reason}): {scan.FilesSeen} files, {scan.FilesEmitted} new/changed");
    }

    private void SaveScan() => Context.Settings.Save(Name, ScanKey, _scan);

    private void ResetCount()
    {
        _count?.Dispose();
        _count = null;
        _countRoot = 0;
        _counted = 0;
    }

    /// <summary>
    /// Advance the counting walk (same walker and rules as the scan, so the total matches what the scan will see)
    /// by up to <paramref name="budget"/> files. When every root is counted, the total is stored in the scan state.
    /// After a restart the count starts over (it is cheap); a stored total is kept.
    /// </summary>
    private void CountStep(int budget, CancellationToken ct)
    {
        var scan = _scan;
        if (scan is null || scan.FilesTotal is not null) return;
        var n = 0;
        while (n < budget && !ct.IsCancellationRequested)
        {
            if (_countRoot >= scan.Roots.Count)
            {
                scan.FilesTotal = _counted;
                ResetCount();
                SaveScan();
                return;
            }
            _count ??= new ScanWalker(_fs, _exclusions, Settings.IncludeHidden, Settings.IncludeSystem).Walk(scan.Roots[_countRoot], null).GetEnumerator();
            if (!_count.MoveNext())
            {
                _count.Dispose();
                _count = null;
                _countRoot++;
                continue;
            }
            _counted += _count.Current.Files.Count;
            n += Math.Max(1, _count.Current.Files.Count);
        }
    }

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
            return LinkUnchanged(sink, batch, f, c.QuickHash, mtime, nowStr);
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

        var kind = PolicyKind(f.FullPath, ext, f.Size);
        var original = kind is null ? null : batch.ResolveOriginal(hash, f.Size, kind, f.FullPath, nowStr, NewOid);
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
            OriginalBlobOid = original,
        };
        var r = Emit(sink, record);
        batch.Upsert(f.FullPath, hash, mtime, nowStr, r.Oid);
        batch.SetLink(f.FullPath, hash, original);
        return true;
    }

    private string NewOid() => Oids.New(Time);

    /// <summary>
    /// An unchanged file that the policy covers but whose newest file_meta named no original (indexed before the
    /// policy, or before a cap or type change): emit one file_meta that names it. No file content is read here.
    /// </summary>
    private bool LinkUnchanged(IRecordSink sink, FileIndexStore.Batch batch, FsEntry f, string hash, string mtime, string nowStr)
    {
        var ext = PathUtil.Ext(f.Name);
        var kind = PolicyKind(f.FullPath, ext, f.Size);
        if (kind is null) return false;
        if (batch.GetLink(f.FullPath) is { } l && l.QuickHash == hash) return false;
        var original = batch.ResolveOriginal(hash, f.Size, kind, f.FullPath, nowStr, NewOid);
        EmitLink(sink, batch, f.FullPath, f.Name, f.Size, hash, mtime, original, nowStr);
        return true;
    }

    private void EmitLink(IRecordSink sink, FileIndexStore.Batch batch, string path, string name, long size, string hash, string mtime, string original, string nowStr)
    {
        Emit(sink, new FileMetaRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = mtime,
            CaptureTime = nowStr,
            Path = path,
            Name = name,
            Size = size,
            Ext = PathUtil.Ext(name),
            Mtime = mtime,
            QuickHash = hash,
            ThumbBlobOid = batch.GetThumb(path, hash),
            OriginalBlobOid = original,
        });
        batch.SetLink(path, hash, original);
    }

    // ---------------------------------------------------------------- media policy (PLAN decision 8)

    /// <summary><c>photo</c>, <c>document</c>, or null (metadata + thumbnail only, original on request).</summary>
    private string? PolicyKind(string path, string ext, long size)
    {
        if (size <= 0) return null;
        var e = MediaPolicyDefaults.NormalizeExtension(ext);
        if (e.Length == 0) return null;
        var s = Settings;
        if (_imageExts.Contains(e))
        {
            if (!s.AutoUploadImages || size > MediaPolicyDefaults.CapBytes(s.ImageCapMB)) return null;
            return IsInScreenshotFolder(path, e) ? null : PayloadKinds.Photo;
        }
        if (_documentExts.Contains(e))
            return s.AutoUploadDocuments && size <= MediaPolicyDefaults.CapBytes(s.DocumentCapMB) ? PayloadKinds.Document : null;
        return null;
    }

    /// <summary>The current settings still cover an original of this kind and size (toggles and caps can change while it waits).</summary>
    private bool PolicyAllows(string kind, long size) => kind switch
    {
        PayloadKinds.Photo => Settings.AutoUploadImages && size <= MediaPolicyDefaults.CapBytes(Settings.ImageCapMB),
        PayloadKinds.Document => Settings.AutoUploadDocuments && size <= MediaPolicyDefaults.CapBytes(Settings.DocumentCapMB),
        _ => false,
    };

    /// <summary>
    /// An image directly in a Screenshots folder (the screenshots collector's roots and extensions, not recursive,
    /// as it watches them) is uploaded by that collector as <c>screenshot</c>; this collector never uploads it too.
    /// </summary>
    private bool IsInScreenshotFolder(string path, string ext)
    {
        if (_screenshotFolders is not { } sf || Now - sf.At > TimeSpan.FromSeconds(30))
        {
            var s = Context.Settings.Load<ScreenshotSettings>(CollectorNames.Screenshots, "settings") ?? new ScreenshotSettings();
            var roots = s.Roots.Where(r => !string.IsNullOrWhiteSpace(r) && Path.IsPathFullyQualified(r)).Select(PathUtil.Full).ToList();
            sf = (Now, roots, s.Extensions.Select(MediaPolicyDefaults.NormalizeExtension).ToHashSet(StringComparer.Ordinal));
            _screenshotFolders = sf;
        }
        if (!sf.Exts.Contains(ext)) return false;
        var dir = Path.GetDirectoryName(path);
        if (dir is null) return false;
        var full = PathUtil.Full(dir);
        return sf.Roots.Any(r => r.Equals(full, PathUtil.Comparison));
    }

    /// <summary>Most originals looked at per tick (the byte budget usually stops earlier).</summary>
    private const int OriginalsPerTick = 256;

    /// <summary>
    /// Enqueue due originals into the bulk lane, up to <see cref="FileIndexSettings.OriginalsBytesPerTick"/> (at least
    /// one), while less than <see cref="FileIndexSettings.MaxQueuedOriginalBytes"/> of them waits for the uploader.
    /// Returns how many were enqueued or settled (0 = nothing more to do now).
    /// </summary>
    private int ProcessOriginals(IRecordSink sink, CancellationToken ct)
    {
        var due = _store.DueOriginals(OriginalsPerTick);
        if (due.Count == 0)
        {
            _originalsNote = null;
            return 0;
        }
        if (Context.Queue is { } q && q.BulkBytes(Name) >= Settings.MaxQueuedOriginalBytes)
        {
            _originalsNote = "originals waiting for the uploader (bandwidth cap or pause)";
            return 0;
        }
        _originalsNote = null;
        var budget = Settings.OriginalsBytesPerTick;
        var progressed = 0;
        foreach (var row in due)
        {
            if (ct.IsCancellationRequested || (progressed > 0 && budget <= 0)) break;
            if (!PolicyAllows(row.PayloadKind, row.Size)) continue; // turned off or over a lowered cap: waits
            var o = row;
            if (o.Status == "enqueuing")
            {
                if (RecoverInterrupted(sink, o)) { progressed++; continue; }
                o = _store.GetOriginal(o.QuickHash, o.Size);
                if (o is null) continue;
            }
            var read = UploadOriginal(sink, o);
            progressed++;
            if (read) budget -= o.Size;
        }
        return progressed;
    }

    /// <summary>
    /// The process stopped between "enqueuing" and "uploaded". When the blob is in the queue it was enqueued; otherwise
    /// it may have been enqueued and already uploaded, so its oid is never reused: a new oid is chosen and every path
    /// that named the old one gets a file_meta naming the new one. Returns true when settled.
    /// </summary>
    private bool RecoverInterrupted(IRecordSink sink, FileIndexStore.OriginalRow o)
    {
        if (Context.Queue?.Contains(ObjectKeys.BlobManifest(o.BlobOid)) == true)
        {
            _store.SetOriginalStatus(o, "uploaded", uploadedAt: IvyTime.Format(Now));
            return true;
        }
        var fresh = NewOid();
        _store.ReplaceOriginalOid(o, fresh);
        var nowStr = IvyTime.Format(Now);
        using var batch = _store.BeginBatch();
        foreach (var path in _store.LinkedPaths(fresh))
            if (batch.Get(path) is { } c && c.QuickHash == o.QuickHash)
                EmitLink(sink, batch, path, Path.GetFileName(path), o.Size, c.QuickHash, c.Mtime, fresh, nowStr);
        batch.Commit();
        return false;
    }

    /// <summary>Read the source and enqueue it under the original's oid. Returns true when file bytes were read.</summary>
    private bool UploadOriginal(IRecordSink sink, FileIndexStore.OriginalRow o)
    {
        var st = _fs.Stat(o.SourcePath);
        if (st is null || st.IsDirectory || st.Size != o.Size)
        {
            SourceGone(o);
            return false;
        }
        Stream s;
        try { s = _fs.OpenRead(o.SourcePath); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            OriginalFailed(o, e);
            return false;
        }
        using (s)
        {
            try
            {
                if (s.Length != o.Size || QuickHash.Compute(s) != o.QuickHash)
                {
                    SourceGone(o); // changed since it was indexed: the change event / next scan indexes the new content
                    return true;
                }
                s.Position = 0;
                _store.SetOriginalStatus(o, "enqueuing");
                EmitBlob(sink, s, o.PayloadKind, o.Size, oid: o.BlobOid, bulk: true);
                _store.SetOriginalStatus(o, "uploaded", uploadedAt: IvyTime.Format(Now));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException)
            {
                if (Context.Queue?.Contains(ObjectKeys.BlobManifest(o.BlobOid)) == true) _store.SetOriginalStatus(o, "uploaded", uploadedAt: IvyTime.Format(Now));
                else OriginalFailed(o, e);
            }
        }
        return true;
    }

    private void OriginalFailed(FileIndexStore.OriginalRow o, Exception e)
    {
        var why = e is UnauthorizedAccessException or System.Security.SecurityException ? "access denied" : "locked or unreadable";
        _store.SetOriginalStatus(o, "failed", why, countAttempt: true);
        // activity details carry oids and statuses, never paths or content
        Activity(CollectorActivity.OriginalFailed, $"{o.PayloadKind} original {o.BlobOid} not uploaded ({why}); metadata kept, retried on the next rescan");
    }

    /// <summary>The source no longer holds this content: read it from another indexed copy, or forget it.</summary>
    private void SourceGone(FileIndexStore.OriginalRow o)
    {
        foreach (var p in _store.PathsWithHash(o.QuickHash, o.SourcePath))
        {
            if (_fs.Stat(p) is { IsDirectory: false } st && st.Size == o.Size)
            {
                _store.SetOriginalSource(o, p);
                return;
            }
        }
        _store.DropOriginal(o);
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
        Import = CurrentImport();
        var parts = new List<string>();
        if (_scan is { } s) parts.Add($"scanning ({s.Reason}): root {Math.Min(s.RootIndex + 1, s.Roots.Count)}/{s.Roots.Count}, {s.FilesSeen}{(s.FilesTotal is { } t ? $" of {Math.Max(t, s.FilesSeen)}" : "")} files seen, {s.FilesEmitted} new/changed");
        else if (LastFullScan is { } last) parts.Add($"last full scan {last.CompletedAt}: {last.FilesSeen} files");
        var originals = _store.OriginalCounts();
        var queued = originals.GetValueOrDefault("pending") + originals.GetValueOrDefault("enqueuing");
        var failed = originals.GetValueOrDefault("failed");
        if (queued > 0 || failed > 0)
            parts.Add($"originals: {queued} to upload{(failed > 0 ? $", {failed} unreadable (retried on the next rescan)" : "")}");
        if (_originalsNote is not null) parts.Add(_originalsNote);
        if (_usnNote is not null) parts.Add(_usnNote);
        else if (_usn is null) parts.Add(OperatingSystem.IsWindows() ? "USN journal off; FileSystemWatcher only" : "FileSystemWatcher only (no USN journal on this platform)");
        if (Settings.Roots.Count == 0) parts.Add("no folders selected");
        Detail = string.Join("; ", parts);
    }

    /// <summary>
    /// Import progress for the device report (§6): during a scan, files scanned / counted total with phase
    /// <c>initial</c> (no full scan completed before) or <c>rescan</c>; afterwards <c>incremental</c> with the last
    /// full scan's file count as both numbers. The total is never below what was already scanned (files appear
    /// while scanning).
    /// </summary>
    private ImportProgress? CurrentImport()
    {
        if (_scan is { } s)
            return new ImportProgress(s.FilesTotal is { } t ? Math.Max(t, s.FilesSeen) : null, s.FilesSeen, s.Initial ? ImportPhases.Initial : ImportPhases.Rescan);
        if (LastFullScan is { } last) return new ImportProgress(last.FilesSeen, last.FilesSeen, ImportPhases.Incremental);
        return null;
    }

    private List<string> ExistingRoots() =>
        Settings.Roots.Select(PathUtil.Full).Where(r => _fs.Stat(r) is { IsDirectory: true }).Distinct().ToList();
}
