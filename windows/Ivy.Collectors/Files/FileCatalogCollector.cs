using System.Text.Json.Nodes;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Core.Commands;
using Ivy.Core.Policy;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;

namespace Ivy.Collectors.Files;

/// <summary>Resumable state of a full catalogue pass, persisted so it continues after a restart.</summary>
public sealed class CatalogScanState
{
    /// <summary>Monotonic id of this pass. A catalogue row left at an older generation after the pass is a deletion.</summary>
    public required long Generation { get; init; }
    public required string StartedAt { get; init; }
    /// <summary>Index into the roots list of the root being walked.</summary>
    public int RootIndex { get; set; }
    /// <summary>The last fully-listed directory (relative to the current root); the walk resumes after it. Null = start of the root.</summary>
    public string? Checkpoint { get; set; }
    public long FilesSeen { get; set; }
    public long FilesEmitted { get; set; }
}

/// <summary>
/// The <c>catalog</c> collector: a metadata-only listing of the user's files (names, sizes, dates — no
/// content) so the Mac can browse everything on this PC and fetch any file's bytes on demand. It walks each
/// configured root deterministically (<see cref="ScanWalker"/>, resumable), emits one
/// <c>file_meta</c> with <c>catalogOnly = true</c> per new or changed file, and after a full pass emits a
/// deletion for any file it no longer finds. Unchanged files (same size and mtime) are not re-emitted. It
/// never opens a file, so it is cheap and safe to run across the whole profile and data drives.
/// </summary>
public sealed class FileCatalogCollector : Collector<FileCatalogSettings>
{
    public const string CollectorName = "catalog";
    private const string ScanKey = "scan";
    private const string LastScanKey = "lastScanCompletedAt";

    private readonly IFileSystemSource _fs;
    private readonly CatalogStore _store;

    private ExclusionMatcher _exclusions;
    private CatalogScanState? _scan;
    private IEnumerator<DirectoryBatch>? _walk;
    private string? _pendingRescanReason;

    public FileCatalogCollector(CollectorContext context, IFileSystemSource? fs = null, FileCatalogSettings? settings = null)
        : base(CollectorName, context, settings)
    {
        _fs = fs ?? PhysicalFileSystemSource.Instance;
        CollectorDb.EnsureSchema(context.Db);
        _store = new CatalogStore(context.Db);
        _exclusions = new ExclusionMatcher(Settings.Exclusions);
    }

    public override TimeSpan Interval => TimeSpan.FromSeconds(2);

    public CatalogScanState? CurrentScan => _scan;

    protected override void Validate(FileCatalogSettings s)
    {
        if (s.ScanBatchSize is < 1 or > 1_000_000) throw new ArgumentException("scanBatchSize must be 1..1000000");
        if (s.FullRescanHours < 0) throw new ArgumentException("fullRescanHours must be >= 0");
        foreach (var r in s.Roots)
            if (!string.IsNullOrWhiteSpace(r) && !Path.IsPathFullyQualified(r)) throw new ArgumentException($"root must be an absolute path: {r}");
    }

    protected override void OnSettingsChanged(FileCatalogSettings previous, FileCatalogSettings current)
    {
        _exclusions = new ExclusionMatcher(current.Exclusions);
        // the roots or filter changed, so the current pass is stale; restart cleanly on the next tick
        _scan = null;
        _walk = null;
        _pendingRescanReason = "settings_changed";
    }

    public override Task StartAsync(CancellationToken ct)
    {
        _scan = Context.Settings.Load<CatalogScanState>(Name, ScanKey);
        _walk = null; // recreated from the checkpoint on the next scan step
        return Task.CompletedTask;
    }

    public override Task<CommandOutcome> RescanAsync(string? scope, CancellationToken ct)
    {
        _pendingRescanReason = "command";
        return Task.FromResult(CommandOutcome.Done("re-catalogue scheduled"));
    }

    public override Task TickAsync(CancellationToken ct)
    {
        var sink = Sink;
        if (sink is null) return Task.CompletedTask; // not paired
        var roots = ExistingRoots();
        if (roots.Count == 0)
        {
            Detail = Settings.Roots.Count == 0 ? "no folders to catalogue" : "none of the catalogue folders are available";
            return Task.CompletedTask;
        }
        StartScanIfDue();
        if (_scan is not null) ScanStep(sink, roots, Settings.ScanBatchSize, ct);
        UpdateDetail(roots);
        return Task.CompletedTask;
    }

    // ---------------------------------------------------------------- scan

    private IReadOnlyList<string> ExistingRoots() =>
        Settings.Roots.Where(r => !string.IsNullOrWhiteSpace(r) && _fs.Stat(r) is { IsDirectory: true }).ToList();

    private void StartScanIfDue()
    {
        if (_scan is not null) return;
        var due = _pendingRescanReason is not null || DueForRescan();
        if (!due) return;
        _pendingRescanReason = null;
        _scan = new CatalogScanState { Generation = _store.MaxGeneration() + 1, StartedAt = IvyTime.Format(Now) };
        _walk = null;
        SaveScan();
    }

    private bool DueForRescan()
    {
        var last = Context.Settings.LoadJson(Name, LastScanKey)?.GetValue<string>();
        if (last is null) return true; // never catalogued
        if (Settings.FullRescanHours <= 0) return false;
        return !DateTimeOffset.TryParse(last, out var t) || Now - t >= TimeSpan.FromHours(Settings.FullRescanHours);
    }

    /// <summary>List up to <paramref name="budget"/> files, emitting catalog records for new/changed ones.</summary>
    private void ScanStep(IRecordSink sink, IReadOnlyList<string> roots, int budget, CancellationToken ct)
    {
        var scan = _scan!;
        var nowStr = IvyTime.Format(Now);
        var deviceId = DeviceId(sink);
        using var batch = _store.BeginBatch();
        var processed = 0;

        while (processed < budget && !ct.IsCancellationRequested)
        {
            if (scan.RootIndex >= roots.Count) { FinishScan(sink, batch, nowStr, deviceId); break; }
            _walk ??= new ScanWalker(_fs, _exclusions, Settings.IncludeHidden, Settings.IncludeSystem)
                .Walk(roots[scan.RootIndex], scan.Checkpoint).GetEnumerator();

            if (!_walk.MoveNext())
            {
                // this root is done; advance to the next and start it from the beginning
                _walk.Dispose();
                _walk = null;
                scan.RootIndex++;
                scan.Checkpoint = null;
                SaveScan();
                continue;
            }

            var dir = _walk.Current;
            foreach (var f in dir.Files)
            {
                scan.FilesSeen++;
                var mtime = IvyTime.Format(f.LastWriteUtc);
                var prior = batch.Get(f.FullPath);
                if (prior is { } p && p.Size == f.Size && p.Mtime == mtime)
                {
                    batch.Touch(f.FullPath, scan.Generation); // unchanged: keep it, do not re-emit
                }
                else
                {
                    EmitCatalog(sink, deviceId, f, mtime, nowStr);
                    batch.Upsert(f.FullPath, f.Size, mtime, scan.Generation);
                    scan.FilesEmitted++;
                }
                processed++;
            }
            // the directory's files are all listed, so it is a safe resume point
            scan.Checkpoint = dir.RelativePath;
            batch.Commit();
            SaveScan();
        }
        batch.Commit();
    }

    private void FinishScan(IRecordSink sink, CatalogStore.Batch batch, string nowStr, string deviceId)
    {
        // any file not seen in this generation has gone: emit a deletion and drop its row
        foreach (var path in _store.Stale(_scan!.Generation))
        {
            EmitDeletion(sink, deviceId, path, nowStr);
            batch.Remove(path);
        }
        batch.Commit();
        Context.Settings.SaveJson(Name, LastScanKey, JsonValue.Create(nowStr));
        Context.Settings.Save<CatalogScanState>(Name, ScanKey, null);
        Activity(CollectorActivity.ScanCompleted, $"catalogue complete: {_scan.FilesSeen} files, {_scan.FilesEmitted} new or changed");
        _scan = null;
        _walk?.Dispose();
        _walk = null;
    }

    private void EmitCatalog(IRecordSink sink, string deviceId, FsEntry f, string mtime, string nowStr) =>
        Emit(sink, new FileMetaRecord
        {
            DeviceId = deviceId,
            EventTime = mtime,
            CaptureTime = nowStr,
            Path = f.FullPath,
            Name = f.Name,
            Size = f.Size,
            Ext = PathUtil.Ext(f.Name),
            Mtime = mtime,
            CatalogOnly = true,
        });

    private void EmitDeletion(IRecordSink sink, string deviceId, string path, string nowStr) =>
        Emit(sink, new FileMetaRecord
        {
            DeviceId = deviceId,
            EventTime = nowStr,
            CaptureTime = nowStr,
            Path = path,
            Name = Path.GetFileName(path),
            Ext = PathUtil.Ext(Path.GetFileName(path)),
            CatalogOnly = true,
            Deleted = true,
        });

    private void SaveScan() => Context.Settings.Save(Name, ScanKey, _scan);

    private void UpdateDetail(IReadOnlyList<string> roots)
    {
        if (_scan is not null)
        {
            var root = _scan.RootIndex < roots.Count ? roots[_scan.RootIndex] : "finishing";
            Detail = $"cataloguing {root} ({_scan.FilesSeen} files, {_scan.FilesEmitted} new or changed)";
            Cursor = $"gen={_scan.Generation} root={_scan.RootIndex} seen={_scan.FilesSeen}";
            Import = new ImportProgress(null, _scan.FilesSeen, "cataloguing");
        }
        else
        {
            var last = Context.Settings.LoadJson(Name, LastScanKey)?.GetValue<string>();
            Detail = last is null ? "not catalogued yet" : $"catalogue up to date (last pass {last})";
            Import = null;
        }
    }

    // ---------------------------------------------------------------- test helpers (no host)

    /// <summary>Run the current (or a due) catalogue pass to completion now.</summary>
    public void RunScanToCompletion(CancellationToken ct = default)
    {
        var sink = Sink ?? throw new InvalidOperationException("no sink (not paired)");
        var roots = ExistingRoots();
        StartScanIfDue();
        while (_scan is not null && !ct.IsCancellationRequested) ScanStep(sink, roots, Settings.ScanBatchSize, ct);
        UpdateDetail(roots);
    }

    /// <summary>Process one tick's worth of the scan without the host.</summary>
    public void ScanTick()
    {
        var sink = Sink ?? throw new InvalidOperationException("no sink (not paired)");
        var roots = ExistingRoots();
        StartScanIfDue();
        if (_scan is not null) ScanStep(sink, roots, Settings.ScanBatchSize, default);
        UpdateDetail(roots);
    }
}
