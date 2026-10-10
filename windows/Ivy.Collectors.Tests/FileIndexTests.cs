using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Collectors.Files;
using Ivy.Collectors.Tests.Support;
using Ivy.Collectors.Thumbnails;
using Ivy.Core.Protocol;
using Ivy.Core.Storage;
using SkiaSharp;

namespace Ivy.Collectors.Tests;

public class FileIndexTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly ManualChangeSource _changes = new();
    private readonly string _root;

    public FileIndexTests()
    {
        _env = new TestEnv(_dir);
        _root = _dir.Sub("tree");
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 8, 0, 0, TimeSpan.Zero);

    private void BuildTree()
    {
        _dir.Write("tree/a.txt", "alpha", T0);
        _dir.Write("tree/sub/b.TXT", "bravo", T0);
        _dir.Write("tree/sub/deep/c.md", "charlie", T0);
        _dir.Write("tree/noext", "x", T0);
        _dir.Write("tree/node_modules/pkg/index.js", "module.exports = 1", T0);
        _dir.Write("tree/.git/config", "[core]", T0);
        _dir.Write("tree/sub/.hidden", "dot files are hidden on macOS", T0);
        _dir.Write("tree/build/out.tmp", "excluded by a custom glob", T0);
    }

    private FileIndexCollector NewCollector(CollectorContext? ctx = null, IFileSystemSource? fs = null, IUsnJournal? usn = null,
        IThumbnailGenerator? thumbs = null, int batch = 500, IReadOnlyList<string>? roots = null)
    {
        var c = new FileIndexCollector(ctx ?? _env.Context, fs, _changes, usn, thumbs);
        c.ApplySettings(Host.CollectorHost.Merge(c.GetSettingsJson(), new System.Text.Json.Nodes.JsonObject
        {
            ["roots"] = new System.Text.Json.Nodes.JsonArray((roots ?? new[] { _root }).Select(r => (System.Text.Json.Nodes.JsonNode?)r).ToArray()),
            ["exclusions"] = new System.Text.Json.Nodes.JsonArray(ExclusionMatcher.Defaults.Append("*.tmp").Select(r => (System.Text.Json.Nodes.JsonNode?)r).ToArray()),
            ["scanBatchSize"] = batch,
        }));
        return c;
    }

    private static bool IsDeletion(CapturedRecord r) => r.Has("deleted") && r.Root.GetProperty("deleted").GetBoolean();
    /// <summary>Names of emitted live (non-deletion) file_meta records.</summary>
    private IReadOnlyList<string> EmittedNames() => _env.Sink.Of(Kind.FileMeta).Where(r => !IsDeletion(r)).Select(r => r.Str("name")).OrderBy(n => n, StringComparer.Ordinal).ToList();
    /// <summary>Names of emitted deletion (deleted: true) file_meta records.</summary>
    private IReadOnlyList<string> DeletedNames() => _env.Sink.Of(Kind.FileMeta).Where(IsDeletion).Select(r => r.Str("name")).OrderBy(n => n, StringComparer.Ordinal).ToList();

    [Fact]
    public async Task Import_progress_reports_scanned_of_counted_total_per_phase()
    {
        for (var i = 0; i < 12; i++) _dir.Write($"tree/d{i % 3}/f{i:00}.txt", $"file {i}", T0);
        _dir.Write("tree/node_modules/x.js", "excluded, never counted", T0);
        var c = NewCollector(batch: 5);
        await c.StartAsync(default);
        Assert.Null(c.Import); // nothing scanned yet, no pass started

        // the counting walk runs first in the tick (enumeration only), then one batch of the scan
        c.ScanTick();
        var p = Assert.IsType<Ivy.Core.Records.ImportProgress>(c.Import);
        Assert.Equal(Ivy.Core.Records.ImportPhases.Initial, p.Phase);
        Assert.Equal(12, p.Total);
        Assert.InRange(p.Done, 1, 11);
        Assert.Equal(12, c.CurrentScan!.FilesTotal);

        c.RunScanToCompletion();
        Assert.Equal(new Ivy.Core.Records.ImportProgress(12, 12, Ivy.Core.Records.ImportPhases.Incremental), c.Import);

        // a rescan command: phase rescan, counted again (a file was added meanwhile)
        _dir.Write("tree/d0/new.txt", "13th", T0);
        await c.RescanAsync(null, default);
        c.ScanTick();
        p = c.Import!;
        Assert.Equal(Ivy.Core.Records.ImportPhases.Rescan, p.Phase);
        Assert.Equal(13, p.Total);
        Assert.True(p.Done < 13);
        c.RunScanToCompletion();
        Assert.Equal(new Ivy.Core.Records.ImportProgress(13, 13, Ivy.Core.Records.ImportPhases.Incremental), c.Import);
    }

    [Fact]
    public async Task Import_total_is_counted_again_after_a_restart_mid_scan()
    {
        for (var i = 0; i < 9; i++) _dir.Write($"tree/d{i}/f{i}.txt", $"{i}", T0);
        var c = NewCollector(batch: 4);
        await c.StartAsync(default);
        c.ScanTick();
        Assert.Equal(9, c.Import!.Total);
        var done = c.Import.Done;
        await c.StopAsync();

        var again = NewCollector(ctx: _env.Restart(), batch: 4);
        await again.StartAsync(default);
        Assert.Equal(9, again.CurrentScan!.FilesTotal); // persisted with the scan state
        again.ScanTick();
        Assert.Equal(Ivy.Core.Records.ImportPhases.Initial, again.Import!.Phase);
        Assert.True(again.Import.Done > done);
        again.RunScanToCompletion();
        Assert.Equal(new Ivy.Core.Records.ImportProgress(9, 9, Ivy.Core.Records.ImportPhases.Incremental), again.Import);
    }

    [Fact]
    public async Task Initial_scan_emits_file_meta_for_admitted_files_only()
    {
        BuildTree();
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();

        Assert.Equal(new[] { "a.txt", "b.TXT", "c.md", "noext" }, EmittedNames());
        var a = _env.Sink.Of(Kind.FileMeta).Single(r => r.Str("name") == "a.txt");
        Assert.Equal(Path.Combine(_root, "a.txt"), a.Str("path"));
        Assert.Equal("txt", a.Str("ext"));
        Assert.Equal(5, a.Root.GetProperty("size").GetInt64());
        Assert.Equal(IvyTime.Format(T0), a.Str("mtime"));
        Assert.Equal(IvyTime.Format(T0), a.Str("eventTime"));
        Assert.Equal(IvyTime.Format(_env.Time.GetUtcNow()), a.Str("captureTime"));
        Assert.Matches("^[0-9a-f]{32}$", a.Str("quickHash"));
        Assert.Equal(QuickHash.ComputeFile(Path.Combine(_root, "a.txt")), a.Str("quickHash"));
        Assert.Equal("txt", _env.Sink.Of(Kind.FileMeta).Single(r => r.Str("name") == "b.TXT").Str("ext"));
        Assert.Equal("", _env.Sink.Of(Kind.FileMeta).Single(r => r.Str("name") == "noext").Str("ext"));
        Assert.All(_env.Sink.Records, r => Assert.Equal("files", r.Collector));

        // file_cache rows, with file_id = the oid of the latest file_meta for that path.
        var cache = new FileCacheStore(_env.Db);
        var row = cache.Get(Path.Combine(_root, "a.txt"));
        Assert.NotNull(row);
        Assert.Equal(a.Str("quickHash"), row!.QuickHash);
        Assert.Equal(a.Oid, row.FileId);
        Assert.Null(cache.Get(Path.Combine(_root, "node_modules", "pkg", "index.js")));

        // A second full scan with nothing changed re-reads nothing and emits nothing.
        _env.Sink.Clear();
        await c.RescanAsync(null, default);
        c.RunScanToCompletion();
        Assert.Empty(_env.Sink.Records);
        Assert.NotNull(c.LastFullScan);
        Assert.Contains(_env.Activity.Recent(), e => e.Event == CollectorActivity.Captured && e.Collector == "files");
        Assert.Contains(_env.Activity.Recent(), e => e.Event == CollectorActivity.ScanCompleted);
    }

    [Fact]
    public async Task Hidden_files_are_included_when_the_toggle_is_on()
    {
        BuildTree();
        var c = NewCollector();
        c.ApplySettings(Host.CollectorHost.Merge(c.GetSettingsJson(), new System.Text.Json.Nodes.JsonObject { ["includeHidden"] = true }));
        await c.StartAsync(default);
        c.RunScanToCompletion();
        // .hidden is admitted; .git is still excluded by the glob list even though it is hidden too.
        Assert.Equal(new[] { ".hidden", "a.txt", "b.TXT", "c.md", "noext" }, EmittedNames());
    }

    [Fact]
    public async Task Agent_data_directory_is_never_indexed()
    {
        _dir.Write("doc.txt", "d", T0);
        var c = NewCollector(roots: new[] { _dir.Path });
        await c.StartAsync(default);
        c.RunScanToCompletion();
        Assert.DoesNotContain(_env.Sink.Of(Kind.FileMeta), r => r.Str("path").StartsWith(_env.DataDir, StringComparison.Ordinal));
        Assert.Contains(_env.Sink.Of(Kind.FileMeta), r => r.Str("name") == "doc.txt");
    }

    [Fact]
    public async Task Watcher_changes_add_modify_and_delete()
    {
        BuildTree();
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        Assert.Equal(new[] { _root }, _changes.Watched);
        var oldHash = _env.Sink.Of(Kind.FileMeta).Single(r => r.Str("name") == "a.txt").Str("quickHash");
        _env.Sink.Clear();

        var a = Path.Combine(_root, "a.txt");
        File.WriteAllText(a, "alpha, modified");
        File.SetLastWriteTimeUtc(a, T0.AddHours(1).UtcDateTime);
        var added = _dir.Write("tree/sub/new.pdf", "%PDF-not-really", T0.AddHours(2));
        var gone = Path.Combine(_root, "sub", "deep", "c.md");
        File.Delete(gone);
        var ignored = _dir.Write("tree/node_modules/pkg/other.js", "x", T0);
        foreach (var p in new[] { a, added, gone, ignored }) _changes.Raise(p);

        // Debounced: nothing before the debounce period passes.
        await c.TickAsync(default);
        Assert.Empty(_env.Sink.Records);
        _env.Time.Advance(TimeSpan.FromSeconds(3));
        await c.TickAsync(default);

        var recs = _env.Sink.Of(Kind.FileMeta).Where(r => !IsDeletion(r)).ToList();
        Assert.Equal(new[] { "a.txt", "new.pdf" }, recs.Select(r => r.Str("name")).OrderBy(n => n, StringComparer.Ordinal));
        var mod = recs.Single(r => r.Str("name") == "a.txt");
        Assert.NotEqual(oldHash, mod.Str("quickHash"));
        Assert.Equal(IvyTime.Format(T0.AddHours(1)), mod.Str("mtime"));
        Assert.Equal("pdf", recs.Single(r => r.Str("name") == "new.pdf").Str("ext"));

        // Deletion: a file_meta with deleted:true reaches the Mac, plus tombstone + cache row removed + activity entry.
        var del = _env.Sink.Of(Kind.FileMeta).Single(IsDeletion);
        Assert.Equal("c.md", del.Str("name"));
        Assert.Equal(gone, del.Str("path"));
        Assert.False(del.Has("size"));
        Assert.False(del.Has("mtime"));
        Assert.False(del.Has("quickHash"));
        var cache = new FileCacheStore(_env.Db);
        Assert.Null(cache.Get(gone));
        Assert.True(c.IsTombstoned(gone));
        Assert.Contains(_env.Activity.Recent(), e => e.Event == CollectorActivity.Deleted);

        // A removed folder tombstones everything cached under it.
        Directory.Delete(Path.Combine(_root, "sub"), recursive: true);
        _changes.Raise(Path.Combine(_root, "sub"));
        c.FlushChanges();
        Assert.True(c.IsTombstoned(Path.Combine(_root, "sub", "b.TXT")));
        Assert.True(c.IsTombstoned(added));
        Assert.NotNull(cache.Get(a));
    }

    [Fact]
    public async Task Watcher_delete_emits_a_file_meta_deletion()
    {
        BuildTree();
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        _env.Sink.Clear();

        var gone = Path.Combine(_root, "a.txt");
        File.Delete(gone);
        _changes.Raise(gone);
        c.FlushChanges();

        var del = Assert.Single(_env.Sink.Of(Kind.FileMeta));
        Assert.True(IsDeletion(del));
        Assert.Equal("a.txt", del.Str("name"));
        Assert.Equal(gone, del.Str("path"));
        Assert.Equal("txt", del.Str("ext"));
        Assert.False(del.Has("mtime"));
        Assert.False(del.Has("quickHash"));
        Assert.True(c.IsTombstoned(gone));
        Assert.Contains(_env.Activity.Recent(), e => e.Event == CollectorActivity.Deleted);
    }

    [Fact]
    public async Task Full_rescan_detects_changes_and_emits_a_deletion()
    {
        BuildTree();
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        _env.Sink.Clear();

        var gone = Path.Combine(_root, "noext");
        File.Delete(gone);
        _dir.Write("tree/sub/b.TXT", "bravo2", T0.AddDays(1));
        _env.Time.Advance(TimeSpan.FromMinutes(5));
        var observedAt = IvyTime.Format(_env.Time.GetUtcNow());
        var outcome = await c.RescanAsync(null, default);
        Assert.Equal(Ivy.Core.Records.CommandStatusValues.Done, outcome.Status);
        c.RunScanToCompletion();

        // The changed file is re-emitted live; the missing file is emitted as a deletion.
        Assert.Equal(new[] { "b.TXT" }, EmittedNames());
        Assert.Equal(new[] { "noext" }, DeletedNames());
        var del = _env.Sink.Of(Kind.FileMeta).Single(IsDeletion);
        Assert.Equal(gone, del.Str("path"));
        Assert.Equal(observedAt, del.Str("eventTime")); // for a deletion, eventTime is when it was observed
        Assert.False(del.Has("size"));
        Assert.True(c.IsTombstoned(gone));
        Assert.False(c.IsTombstoned(Path.Combine(_root, "a.txt")));
    }

    [Fact]
    public async Task Periodic_full_rescan_runs_after_the_configured_interval()
    {
        BuildTree();
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        var first = c.LastFullScan!.CompletedAt;
        await c.TickAsync(default);
        Assert.Null(c.CurrentScan); // not due yet
        _env.Time.Advance(TimeSpan.FromHours(24));
        await c.TickAsync(default);
        // The tick started (and, for this small tree, finished) a periodic scan.
        Assert.NotEqual(first, c.LastFullScan!.CompletedAt);
        Assert.Equal("periodic", c.LastFullScan.Reason);
    }

    [Fact]
    public async Task Scoped_rescan_only_walks_the_scope()
    {
        BuildTree();
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        Assert.Equal("error", (await c.RescanAsync("/not/under/root", default)).Status);
        var fs = new RecordingFileSystem();
        var c2 = NewCollector(ctx: _env.Restart(), fs: fs);
        await c2.StartAsync(default);
        Assert.Equal(Ivy.Core.Records.CommandStatusValues.Done, (await c2.RescanAsync(Path.Combine(_root, "sub"), default)).Status);
        c2.RunScanToCompletion();
        Assert.All(fs.Listed, d => Assert.StartsWith(Path.Combine(_root, "sub"), d));
    }

    [Fact]
    public async Task Interrupted_scan_resumes_from_its_checkpoint_after_restart()
    {
        for (var d = 1; d <= 5; d++)
            for (var f = 1; f <= 2; f++)
                _dir.Write($"tree/d{d}/f{f}.txt", $"{d}-{f}", T0);

        // First "process": two ticks of two files each, then it dies.
        var c1 = NewCollector(batch: 2);
        await c1.StartAsync(default);
        await c1.TickAsync(default);
        await c1.TickAsync(default);
        Assert.Equal(4, _env.Sink.Of(Kind.FileMeta).Count);
        Assert.Equal("d2", c1.CurrentScan!.Checkpoint);
        await c1.StopAsync();

        // Second "process" on the same database: continues at d3 without re-listing d1 or re-reading d1/d2.
        var fs = new RecordingFileSystem();
        var c2 = NewCollector(ctx: _env.Restart(), fs: fs, batch: 2);
        await c2.StartAsync(default);
        Assert.NotNull(c2.CurrentScan);
        c2.RunScanToCompletion();

        var names = _env.Sink.Of(Kind.FileMeta).Select(r => r.Str("path")).ToList();
        Assert.Equal(10, names.Count);
        Assert.Equal(10, names.Distinct().Count());
        Assert.DoesNotContain(Path.Combine(_root, "d1"), fs.Listed);
        Assert.DoesNotContain(fs.Opened, p => p.Contains($"{Path.DirectorySeparatorChar}d1{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || p.Contains($"{Path.DirectorySeparatorChar}d2{Path.DirectorySeparatorChar}", StringComparison.Ordinal));
        Assert.Null(c2.CurrentScan);
        Assert.Equal("initial", c2.LastFullScan!.Reason);
        Assert.Equal(10, c2.LastFullScan.FilesSeen);
    }

    [Fact]
    public void Walker_order_and_checkpoint_comparison()
    {
        Assert.True(ScanWalker.Compare(new[] { "a" }, new[] { "a", "b" }) < 0);
        Assert.True(ScanWalker.Compare(new[] { "a", "z" }, new[] { "b" }) < 0);
        Assert.True(ScanWalker.Compare(new[] { "b" }, new[] { "a", "z" }) > 0);
        Assert.Equal(0, ScanWalker.Compare(Array.Empty<string>(), Array.Empty<string>()));
        Assert.True(ScanWalker.IsPrefix(Array.Empty<string>(), new[] { "x" }));
        Assert.False(ScanWalker.IsPrefix(new[] { "x", "y" }, new[] { "x" }));
    }

    [Fact]
    public async Task Usn_journal_changes_are_followed_and_the_cursor_persisted()
    {
        BuildTree();
        var usn = new FakeUsnJournal();
        var c = NewCollector(usn: usn);
        await c.StartAsync(default);
        c.RunScanToCompletion();
        await c.TickAsync(default);                          // first poll: start following at NextUsn
        var cursor = UsnCursor.Parse(c.Cursor);
        Assert.Equal(1000, Assert.Single(cursor).Value.NextUsn);
        _env.Sink.Clear();

        var a = Path.Combine(_root, "a.txt");
        File.WriteAllText(a, "changed via usn");
        File.SetLastWriteTimeUtc(a, T0.AddHours(3).UtcDateTime);
        usn.Add(a, UsnReasons.DataExtend | UsnReasons.Close);
        usn.Add(Path.Combine(_dir.Path, "outside.txt"), UsnReasons.FileCreate);
        _env.Time.Advance(TimeSpan.FromSeconds(31));
        await c.TickAsync(default);

        Assert.Equal("a.txt", Assert.Single(_env.Sink.Of(Kind.FileMeta)).Str("name"));
        Assert.Equal(usn.NextUsn, UsnCursor.Parse(c.Cursor).Single().Value.NextUsn);

        // Restart reads the persisted cursor from collector_state and resumes from it.
        _env.States.RecordRun("files", _env.Time.GetUtcNow(), c.Cursor);
        var c2 = NewCollector(ctx: _env.Restart(), usn: usn);
        await c2.StartAsync(default);
        _env.Time.Advance(TimeSpan.FromSeconds(31));
        usn.ReadsFrom.Clear();
        await c2.TickAsync(default);
        Assert.Empty(usn.ReadsFrom);                          // nothing new since the cursor

        // Journal recreated: events may be lost, so a full rescan is scheduled.
        usn.JournalId = 8;
        _env.Time.Advance(TimeSpan.FromSeconds(31));
        await c2.TickAsync(default);
        Assert.Null(c2.CurrentScan);
        Assert.Equal("usn_journal_reset", c2.LastFullScan!.Reason);
    }

    [Fact]
    public async Task Usn_access_denied_falls_back_to_the_watcher_and_says_so()
    {
        BuildTree();
        var c = NewCollector(usn: new FakeUsnJournal { Denied = true });
        await c.StartAsync(default);
        await c.TickAsync(default);
        Assert.Contains("needs elevation", c.Detail);
    }

    [Fact]
    public async Task Image_files_get_a_thumbnail_blob_referenced_by_thumbBlobOid()
    {
        var png = Images.Png(800, 400);
        var path = _dir.WriteBytes("tree/pic.png", png);
        File.SetLastWriteTimeUtc(path, T0.UtcDateTime);
        _dir.Write("tree/notes.txt", "n", T0);
        var c = NewCollector(thumbs: new ThumbnailGenerator());
        await c.StartAsync(default);
        c.RunScanToCompletion();

        var rec = _env.Sink.Of(Kind.FileMeta).Single(r => r.Str("name") == "pic.png");
        var blob = Assert.Single(_env.Sink.Blobs);
        Assert.Equal(blob.Oid, rec.Str("thumbBlobOid"));
        Assert.Equal(PayloadKinds.Thumbnail, blob.PayloadKind);
        using (var bmp = SKBitmap.Decode(blob.Data)) Assert.Equal((256, 128), (bmp.Width, bmp.Height));
        Assert.False(_env.Sink.Of(Kind.FileMeta).Single(r => r.Str("name") == "notes.txt").Has("thumbBlobOid"));

        // mtime-only change: new file_meta, same thumbnail (not regenerated).
        File.SetLastWriteTimeUtc(path, T0.AddDays(1).UtcDateTime);
        _changes.Raise(path);
        c.FlushChanges();
        Assert.Single(_env.Sink.Blobs);
        Assert.Equal(blob.Oid, _env.Sink.Of(Kind.FileMeta).Last().Str("thumbBlobOid"));
    }

    [Fact]
    public async Task Missing_root_is_an_error_and_never_mass_deletes()
    {
        BuildTree();
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        var moved = _root + "-unplugged";
        Directory.Move(_root, moved);
        await c.RescanAsync(null, default);
        c.LastError = null;
        await c.TickAsync(default);
        c.RunScanToCompletion();
        Assert.Contains("folder not available", c.LastError);
        Assert.False(c.IsTombstoned(Path.Combine(_root, "a.txt")));
        Assert.NotNull(new FileCacheStore(_env.Db).Get(Path.Combine(_root, "a.txt")));
    }
}

public class QuickHashTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Quick_hash_is_stable_and_covers_head_tail_and_size()
    {
        var a = _dir.Write("a", "same content");
        var b = _dir.Write("b", "same content");
        Assert.Equal(QuickHash.ComputeFile(a), QuickHash.ComputeFile(a));
        Assert.Equal(QuickHash.ComputeFile(a), QuickHash.ComputeFile(b));
        Assert.Matches("^[0-9a-f]{32}$", QuickHash.ComputeFile(a));
        Assert.NotEqual(QuickHash.ComputeFile(a), QuickHash.ComputeFile(_dir.Write("c", "same contenT")));

        // Known answer for the small-file form: SHA-256(content || le64(size))[0..16].
        var content = "same content"u8.ToArray();
        var input = content.Concat(BitConverter.GetBytes((long)content.Length)).ToArray();
        Assert.Equal(Bytes.ToHex(System.Security.Cryptography.SHA256.HashData(input).AsSpan(0, 16)), QuickHash.ComputeFile(a));

        var big = new byte[300 * 1024];
        new Random(1).NextBytes(big);
        var bigPath = _dir.WriteBytes("big", big);
        var h = QuickHash.ComputeFile(bigPath);

        var middle = (byte[])big.Clone();
        middle[150 * 1024] ^= 0xff;                        // outside head and tail: by design not detected
        Assert.Equal(h, QuickHash.ComputeFile(_dir.WriteBytes("mid", middle)));
        var tail = (byte[])big.Clone();
        tail[^1] ^= 0xff;
        Assert.NotEqual(h, QuickHash.ComputeFile(_dir.WriteBytes("tail", tail)));
        var head = (byte[])big.Clone();
        head[10] ^= 0xff;
        Assert.NotEqual(h, QuickHash.ComputeFile(_dir.WriteBytes("head", head)));
        Assert.NotEqual(h, QuickHash.ComputeFile(_dir.WriteBytes("longer", big.Concat(new byte[] { 0 }).ToArray())));
    }
}

public class ExclusionTests
{
    [Theory]
    [InlineData(@"C:\Windows\System32\drivers\etc\hosts", true)]
    [InlineData(@"C:\Program Files\App\app.exe", true)]
    [InlineData(@"D:\Program Files (x86)\Old\x.dll", true)]
    [InlineData(@"C:\Users\bunny\AppData\Local\Temp\x.tmp", true)]
    [InlineData(@"C:\$Recycle.Bin\S-1-5\file", true)]
    [InlineData(@"D:\code\proj\node_modules\left-pad\index.js", true)]
    [InlineData(@"D:\code\proj\.git\HEAD", true)]
    [InlineData(@"D:\code\proj\.github\workflows\ci.yml", false)]
    [InlineData(@"C:\Users\bunny\Documents\Windows notes.txt", false)]
    [InlineData(@"C:\Users\bunny\Documents\Windows\notes.txt", false)]
    [InlineData(@"C:\Users\bunny\AppData\Local\Programs\x.exe", false)]
    [InlineData("/Users/bunny/proj/node_modules/x", true)]
    public void Default_exclusions(string path, bool excluded) =>
        Assert.Equal(excluded, new ExclusionMatcher(ExclusionMatcher.Defaults).IsExcluded(path));

    [Fact]
    public void Custom_globs()
    {
        var m = new ExclusionMatcher(new[] { "*.tmp", "**/build/**", "D:/archive/*/cache", "~$*" });
        Assert.True(m.IsExcluded(@"C:\x\file.TMP"));
        Assert.True(m.IsExcluded(@"C:\x\build\obj\a.o"));
        Assert.True(m.IsExcluded(@"D:\archive\2024\cache\blob"));
        Assert.False(m.IsExcluded(@"D:\archive\2024\x\cache2"));
        Assert.True(m.IsExcluded(@"C:\docs\~$report.docx"));
        Assert.False(m.IsExcluded(@"C:\docs\report.docx"));
        Assert.True(m.IsExcludedEntry(@"C:\x\build", "build"));
    }
}
