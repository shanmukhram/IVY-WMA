using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Collectors.Files;
using Ivy.Collectors.Host;
using Ivy.Collectors.Screenshots;
using Ivy.Collectors.Tests.Support;
using Ivy.Core.Agent;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;

namespace Ivy.Collectors.Tests;

/// <summary>Physical file system that can deny opening chosen files (a locked file / access denied).</summary>
public sealed class DenyingFileSystem : IFileSystemSource
{
    public HashSet<string> Denied { get; } = new(StringComparer.Ordinal);
    public bool DenyAsLocked { get; set; }
    public ConcurrentBag<string> Opened { get; } = new();

    public IEnumerable<FsEntry> EnumerateDirectory(string directory) => PhysicalFileSystemSource.Instance.EnumerateDirectory(directory);
    public FsEntry? Stat(string path) => PhysicalFileSystemSource.Instance.Stat(path);
    public bool IsReadableWithoutWriters(string path) => !Denied.Contains(path) && PhysicalFileSystemSource.Instance.IsReadableWithoutWriters(path);

    public Stream OpenRead(string path)
    {
        if (Denied.Contains(path))
            throw DenyAsLocked ? new IOException("The process cannot access the file because it is being used by another process.") : new UnauthorizedAccessException("Access to the path is denied.");
        Opened.Add(path);
        return PhysicalFileSystemSource.Instance.OpenRead(path);
    }
}

/// <summary>PLAN decision 8: images and documents in indexed roots upload their originals automatically.</summary>
public class MediaPolicyTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly ManualChangeSource _changes = new();
    private readonly DenyingFileSystem _fs = new();
    private readonly string _root;
    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 8, 0, 0, TimeSpan.Zero);

    public MediaPolicyTests()
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

    private FileIndexCollector NewCollector(JsonObject? extra = null, CollectorContext? ctx = null)
    {
        var c = new FileIndexCollector(ctx ?? _env.Context, _fs, _changes);
        var patch = new JsonObject
        {
            ["roots"] = new JsonArray((JsonNode?)_root),
            ["thumbnails"] = false,
        };
        foreach (var (k, v) in extra ?? new JsonObject()) patch[k] = v?.DeepClone();
        c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), patch));
        return c;
    }

    private string Write(string rel, byte[] bytes)
    {
        var p = _dir.WriteBytes("tree/" + rel, bytes);
        File.SetLastWriteTimeUtc(p, T0.UtcDateTime);
        return p;
    }

    private static byte[] Bytes(int n, int seed)
    {
        var b = new byte[n];
        new Random(seed).NextBytes(b);
        return b;
    }

    private IReadOnlyList<CapturedRecord> Meta(string name) =>
        _env.Sink.Of(Kind.FileMeta).Where(r => r.Str("name") == name && !r.Has("deleted")).ToList();

    private static string? Original(CapturedRecord r) => r.Has("originalBlobOid") ? r.Str("originalBlobOid") : null;

    private CapturedBlob BlobOf(string oid) => Assert.Single(_env.Sink.Blobs, b => b.Oid == oid);

    [Fact]
    public async Task Images_and_documents_under_their_caps_upload_as_photo_and_document_after_their_metadata()
    {
        var png = Images.Png(64, 32);
        var jpg = Images.Jpeg(40, 40);
        var pic = Write("pic.png", png);
        Write("sub/photo.JPG", jpg);
        Write("big.png", Bytes(20_000, 1));                       // over the 10 KB image cap below
        var notes = Write("notes.txt", "remember the milk"u8.ToArray());
        Write("docs/report.pdf", Images.Pdf());
        Write("docs/sheet.xlsx", Bytes(800, 2));
        Write("docs/long.md", Bytes(3000, 3));                     // over the 2 KB document cap below
        Write("archive.zip", Bytes(500, 4));                        // neither set: metadata only
        Write("empty.txt", Array.Empty<byte>());                    // nothing to upload
        var c = NewCollector(new JsonObject { ["imageCapMB"] = 10.0 / 1024, ["documentCapMB"] = 2.0 / 1024, ["scanBatchSize"] = 2 });
        await c.StartAsync(default);

        // the counting pass never reads file contents: only the files the scan has reached were opened
        c.ScanTick();
        c.RunCountToCompletion();
        Assert.Equal(9, c.CurrentScan!.FilesTotal);
        Assert.True(_fs.Opened.Distinct().Count() <= c.CurrentScan.FilesSeen);
        c.RunScanToCompletion();

        // metadata first: every file has its file_meta, the eligible ones name an original, nothing is uploaded yet
        Assert.Empty(_env.Sink.Blobs);
        var expected = new Dictionary<string, string?>
        {
            ["pic.png"] = PayloadKinds.Photo, ["photo.JPG"] = PayloadKinds.Photo, ["notes.txt"] = PayloadKinds.Document,
            ["report.pdf"] = PayloadKinds.Document, ["sheet.xlsx"] = PayloadKinds.Document,
            ["big.png"] = null, ["long.md"] = null, ["archive.zip"] = null, ["empty.txt"] = null,
        };
        foreach (var (name, kind) in expected)
        {
            var rec = Assert.Single(Meta(name));
            Assert.Equal(kind is not null, rec.Has("originalBlobOid"));
        }
        Assert.Contains("originals: 5 to upload", c.Detail);

        c.RunOriginalsToCompletion();
        Assert.Equal(5, _env.Sink.Blobs.Count);
        foreach (var (name, kind) in expected.Where(e => e.Value is not null))
        {
            var rec = Meta(name).Single();
            var blob = BlobOf(Original(rec)!);
            Assert.Equal(kind, blob.PayloadKind);
            Assert.True(blob.Bulk);
            Assert.Equal("files", blob.Collector);
            Assert.Equal(File.ReadAllBytes(rec.Str("path")), blob.Data);
        }
        Assert.Equal(png, BlobOf(Original(Meta("pic.png").Single())!).Data);
        Assert.Equal(1, _env.Sink.Of(Kind.FileMeta).Count(r => r.Str("path") == notes)); // one record per file, not two
        Assert.DoesNotContain("originals:", c.Detail);

        // a rescan of unchanged files emits and uploads nothing more
        _env.Sink.Clear();
        await c.RescanAsync(null, default);
        c.RunScanToCompletion();
        c.RunOriginalsToCompletion();
        Assert.Empty(_env.Sink.Records);
        Assert.Empty(_env.Sink.Blobs);
        Assert.NotNull(pic);
    }

    [Fact]
    public async Task Moved_and_copied_files_are_not_uploaded_again_but_a_modified_file_is()
    {
        var notes = Write("notes.txt", "version one"u8.ToArray());
        var pic = Write("pic.png", Images.Png(30, 30));
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        c.RunOriginalsToCompletion();
        Assert.Equal(2, _env.Sink.Blobs.Count);
        var notesOid = Original(Meta("notes.txt").Single())!;
        var picOid = Original(Meta("pic.png").Single())!;

        // copy (same quick hash + size) and move (rename) seen by the watcher
        var copy = Path.Combine(_root, "sub", "copy of notes.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
        File.Copy(notes, copy);
        var moved = Path.Combine(_root, "moved.png");
        File.Move(pic, moved);
        _changes.Raise(copy);
        _changes.Raise(pic);
        _changes.Raise(moved);
        c.FlushChanges();
        c.RunOriginalsToCompletion();
        Assert.Equal(2, _env.Sink.Blobs.Count); // nothing re-uploaded
        Assert.Equal(notesOid, Original(Meta("copy of notes.txt").Single()));
        Assert.Equal(picOid, Original(Meta("moved.png").Single()));

        // modified: new content, new original
        File.WriteAllText(notes, "version two, longer");
        File.SetLastWriteTimeUtc(notes, T0.AddDays(1).UtcDateTime);
        _changes.Raise(notes);
        c.FlushChanges();
        c.RunOriginalsToCompletion();
        var newOid = Original(Meta("notes.txt").Last())!;
        Assert.NotEqual(notesOid, newOid);
        Assert.Equal(3, _env.Sink.Blobs.Count);
        Assert.Equal("version two, longer"u8.ToArray(), BlobOf(newOid).Data);
        Assert.Equal(PayloadKinds.Document, BlobOf(newOid).PayloadKind);

        // a copy queued in the same batch as its source names the same (not yet uploaded) original, uploaded once
        Write("a/twin1.md", "# twin"u8.ToArray());
        Write("b/twin2.md", "# twin"u8.ToArray());
        await c.RescanAsync(null, default);
        c.RunScanToCompletion();
        c.RunOriginalsToCompletion();
        var t1 = Original(Meta("twin1.md").Single());
        Assert.Equal(t1, Original(Meta("twin2.md").Single()));
        Assert.Single(_env.Sink.Blobs, b => b.Oid == t1);
        Assert.Equal(4, _env.Sink.Blobs.Count);
    }

    [Fact]
    public async Task A_source_deleted_before_upload_falls_back_to_a_copy_or_is_dropped()
    {
        var a = Write("a.txt", "shared bytes"u8.ToArray());
        var b = Write("b.txt", "shared bytes"u8.ToArray());
        var solo = Write("solo.txt", "only here"u8.ToArray());
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        var oid = Original(Meta("a.txt").Single())!;
        Assert.Equal(oid, Original(Meta("b.txt").Single()));
        File.Delete(a);      // the source of the shared original
        File.Delete(solo);   // the only copy
        c.RunOriginalsToCompletion();
        var blob = Assert.Single(_env.Sink.Blobs);
        Assert.Equal(oid, blob.Oid);
        Assert.Equal("shared bytes"u8.ToArray(), blob.Data);
        Assert.DoesNotContain("originals:", c.Detail); // the solo original is forgotten, not stuck
        Assert.NotNull(b);
    }

    [Fact]
    public async Task Images_directly_in_the_Screenshots_folder_are_left_to_the_screenshots_collector()
    {
        var shots = _dir.Sub("tree", "Screenshots");
        Directory.CreateDirectory(shots);
        var shot = Write("Screenshots/Screenshot 1.png", Images.Png(50, 20, transparent: false));
        Write("Screenshots/old/kept.png", Images.Png(10, 10));     // a subfolder is not watched by the screenshots collector
        Write("Screenshots/notes.txt", "a document in there"u8.ToArray());

        // the screenshots collector watches the same folder; its settings are persisted as the host does
        var sc = new ScreenshotCollector(_env.Context, PhysicalFileSystemSource.Instance, _changes, localZone: TimeZoneInfo.Utc);
        sc.ApplySettings(CollectorHost.Merge(sc.GetSettingsJson(), new JsonObject { ["roots"] = new JsonArray((JsonNode?)shots) }));
        _env.Context.Settings.SaveSettings(CollectorNames.Screenshots, sc.GetSettingsJson());

        var files = NewCollector();
        await files.StartAsync(default);
        files.RunScanToCompletion();
        files.RunOriginalsToCompletion();
        await sc.StartAsync(default);
        await sc.TickAsync(default);
        _env.Time.Advance(TimeSpan.FromSeconds(3));
        await sc.TickAsync(default);

        // the screenshot has metadata from the index, and exactly one upload: the screenshots collector's
        Assert.False(Meta("Screenshot 1.png").Single().Has("originalBlobOid"));
        var forShot = _env.Sink.Blobs.Where(b => b.Data.SequenceEqual(File.ReadAllBytes(shot))).ToList();
        Assert.Equal(PayloadKinds.Screenshot, Assert.Single(forShot).PayloadKind);
        Assert.Equal(forShot[0].Oid, Assert.Single(_env.Sink.Of(Kind.Screenshot)).Str("blobOid"));
        // a subfolder image is a photo, a document there is a document
        Assert.Equal(PayloadKinds.Photo, BlobOf(Original(Meta("kept.png").Single())!).PayloadKind);
        Assert.Equal(PayloadKinds.Document, BlobOf(Original(Meta("notes.txt").Single())!).PayloadKind);
        Assert.Equal(3, _env.Sink.Blobs.Count);
    }

    [Fact]
    public async Task A_file_that_cannot_be_opened_keeps_its_metadata_is_logged_and_retried_on_the_next_rescan()
    {
        var locked = Write("locked.docx", Bytes(700, 5));
        var denied = Write("denied.png", Images.Png(20, 20));
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        _fs.Denied.Add(locked);
        _fs.Denied.Add(denied);
        _fs.DenyAsLocked = true;
        c.RunOriginalsToCompletion();
        _fs.DenyAsLocked = false;

        Assert.Empty(_env.Sink.Blobs);
        Assert.NotNull(Original(Meta("locked.docx").Single()));      // metadata kept (and names the original to come)
        Assert.NotNull(Original(Meta("denied.png").Single()));
        var failures = _env.Activity.Recent().Where(e => e.Event == CollectorActivity.OriginalFailed).ToList();
        Assert.Equal(2, failures.Count);
        Assert.Contains(failures, e => e.Detail!.Contains("locked or unreadable", StringComparison.Ordinal));
        Assert.DoesNotContain(failures, e => e.Detail!.Contains("locked.docx", StringComparison.Ordinal)); // no paths in activity
        Assert.Contains("2 unreadable (retried on the next rescan)", c.Detail);
        Assert.Null(c.LastError);

        // not retried on every tick ...
        await c.TickAsync(default);
        Assert.Empty(_env.Sink.Blobs);
        // ... but on the next rescan, once readable
        _fs.Denied.Clear();
        await c.RescanAsync(null, default);
        c.RunScanToCompletion();
        c.RunOriginalsToCompletion();
        Assert.Equal(2, _env.Sink.Blobs.Count);
        Assert.Equal(Original(Meta("locked.docx").Single()), _env.Sink.Blobs.Single(b => b.PayloadKind == PayloadKinds.Document).Oid);
        Assert.Single(Meta("locked.docx")); // the rescan did not re-emit metadata for the unchanged file
    }

    [Fact]
    public async Task Files_indexed_before_the_policy_applied_get_their_original_once_it_does()
    {
        Write("a.pdf", Images.Pdf());
        Write("b.png", Images.Png(12, 12));
        Write("c.csv", "x,y\n1,2\n"u8.ToArray());
        var c = NewCollector(new JsonObject { ["autoUploadImages"] = false, ["autoUploadDocuments"] = false });
        await c.StartAsync(default);
        c.RunScanToCompletion();
        c.RunOriginalsToCompletion();
        Assert.Empty(_env.Sink.Blobs);
        Assert.All(_env.Sink.Of(Kind.FileMeta), r => Assert.False(r.Has("originalBlobOid")));

        // turning the policy on is a settings change: the next tick rescans; unchanged files are linked (no re-hash)
        c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), new JsonObject { ["autoUploadImages"] = true, ["autoUploadDocuments"] = true, ["documentExtensions"] = new JsonArray("PDF", ".csv") }));
        _env.Sink.Clear();
        var opened = _fs.Opened.Count;
        c.RunScanToCompletion(); // starts the settings_changed rescan
        Assert.Equal(new[] { "a.pdf", "b.png", "c.csv" }, _env.Sink.Of(Kind.FileMeta).Select(r => r.Str("name")).Order());
        Assert.All(_env.Sink.Of(Kind.FileMeta), r => Assert.True(r.Has("originalBlobOid")));
        Assert.Equal(opened, _fs.Opened.Count); // linking read nothing
        c.RunOriginalsToCompletion();
        Assert.Equal(3, _env.Sink.Blobs.Count);

        // turning documents off: queued document originals wait, images still go
        Write("d.txt", "later"u8.ToArray());
        c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), new JsonObject { ["documentExtensions"] = new JsonArray("txt") }));
        c.RunScanToCompletion();
        c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), new JsonObject { ["autoUploadDocuments"] = false }));
        c.RunOriginalsToCompletion();
        Assert.Equal(3, _env.Sink.Blobs.Count);
        Assert.Contains("originals: 1 to upload", c.Detail);
    }

    [Fact]
    public async Task An_upload_interrupted_by_a_crash_never_reuses_its_oid()
    {
        Write("a.txt", "alpha"u8.ToArray());
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        var first = Original(Meta("a.txt").Single())!;
        // the process died after marking the original "enqueuing": whether the blob reached the queue is unknown
        using (var conn = _env.Db.Open())
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "UPDATE file_originals SET status = 'enqueuing'";
            Assert.Equal(1, cmd.ExecuteNonQuery());
        }
        var again = NewCollector(ctx: _env.Restart());
        await again.StartAsync(default);
        again.RunOriginalsToCompletion();
        var blob = Assert.Single(_env.Sink.Blobs);
        Assert.NotEqual(first, blob.Oid);
        var relinked = Meta("a.txt").Last();
        Assert.Equal(blob.Oid, Original(relinked));          // a new file_meta names the new oid
        Assert.Equal(2, Meta("a.txt").Count);
    }

    [Fact]
    public void Invalid_policy_settings_are_rejected()
    {
        var c = NewCollector();
        foreach (var bad in new[]
        {
            new JsonObject { ["imageCapMB"] = 0 }, new JsonObject { ["documentCapMB"] = -1 }, new JsonObject { ["imageCapMB"] = 1_000_000 },
            new JsonObject { ["imageExtensions"] = new JsonArray("png", " ") }, new JsonObject { ["documentExtensions"] = new JsonArray("*.pdf") },
            new JsonObject { ["originalsBytesPerTick"] = 0 },
        })
            Assert.Throws<ArgumentException>(() => c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), bad)));
        Assert.Equal(25, c.Settings.ImageCapMB);
        Assert.Equal(10, c.Settings.DocumentCapMB);
        Assert.True(c.Settings.AutoUploadImages);
        Assert.True(c.Settings.AutoUploadDocuments);
        Assert.Equal(new[] { "png", "jpg", "jpeg", "heic", "heif", "webp", "gif", "bmp", "tiff" }, c.Settings.ImageExtensions);
        Assert.Equal(new[] { "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "txt", "md", "rtf", "csv" }, c.Settings.DocumentExtensions);
    }

    [Fact]
    public async Task Policy_settings_arrive_by_collector_config_and_persist()
    {
        var root = _root;
        Write("x.log", "a log file is a document now"u8.ToArray());
        Write("y.png", Images.Png(8, 8));
        Write("z.pdf", Images.Pdf());
        await using var host = CollectorHost.Create(_env.Context, new CollectorHostOptions { UsePlatformDefaults = false, ChangeSources = _changes, Time = _env.Time });
        await host.StartAsync();
        var p = new CollectorConfigParams
        {
            Collector = "files",
            Settings = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>($$"""
                {"roots":[{{JsonSerializer.Serialize(root)}}],"autoUploadImages":false,"imageCapMB":5,"autoUploadDocuments":true,"documentCapMB":0.5,
                 "imageExtensions":["png"],"documentExtensions":["txt","log"]}
                """)!,
        };
        var cmd = new CommandRecord { DeviceId = "dev-test", EventTime = "2026-10-10T00:00:00.000Z", CaptureTime = "2026-10-10T00:00:00.000Z", CommandId = Guid.NewGuid().ToString(), IssuedAt = "2026-10-10T00:00:00.000Z", Params = p };
        var outcome = await host.HandleCollectorConfigAsync(cmd, p, default);
        Assert.Equal(CommandStatusValues.Done, outcome.Status);
        var s = host.Get<FileIndexCollector>().Settings;
        Assert.False(s.AutoUploadImages);
        Assert.Equal(5, s.ImageCapMB);
        Assert.Equal(0.5, s.DocumentCapMB);
        Assert.Equal(new[] { "txt", "log" }, s.DocumentExtensions);

        await host.TickNowAsync("files"); // serialized with the host's own loop
        await host.TickNowAsync("files");
        Assert.Equal(PayloadKinds.Document, Assert.Single(_env.Sink.Blobs, b => b.PayloadKind != PayloadKinds.Thumbnail).PayloadKind);
        Assert.NotNull(Original(Meta("x.log").Single()));
        Assert.Null(Original(Meta("y.png").Single()));
        Assert.Null(Original(Meta("z.pdf").Single()));

        var bad = new CollectorConfigParams { Collector = "files", Settings = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>("""{"documentCapMB":0}""")! };
        Assert.Equal(CommandStatusValues.Error, (await host.HandleCollectorConfigAsync(cmd with { Params = bad }, bad, default)).Status);
        await host.StopAsync();

        await using var host2 = CollectorHost.Create(_env.Restart(), new CollectorHostOptions { UsePlatformDefaults = false, ChangeSources = _changes, Time = _env.Time });
        await host2.StartAsync();
        Assert.Equal(new[] { "png" }, host2.Get<FileIndexCollector>().Settings.ImageExtensions);
        Assert.Equal(0.5, host2.Get<FileIndexCollector>().Settings.DocumentCapMB);
    }

    [Fact]
    public async Task Originals_go_to_the_bulk_lane_behind_records_and_hold_back_while_the_queue_is_full()
    {
        var (_, macPublic) = X25519.GenerateKeyPair();
        var sink = new RecordSink(_env.Queue, macPublic, "dev-real", _env.Activity, new RecordSinkOptions { ChunkSize = 4096 }, time: _env.Time);
        var ctx = new CollectorContext(_env.Db, () => sink, _env.Activity, _env.States, _env.Queue, _env.Time);
        for (var i = 0; i < 4; i++) Write($"doc{i}.txt", Bytes(3000, 10 + i));
        var c = NewCollector(new JsonObject { ["maxQueuedOriginalBytes"] = 5000, ["originalsBytesPerTick"] = 1 }, ctx);
        await c.StartAsync(default);
        await c.TickAsync(default); // scan (4 file_meta) + at most one original (byte budget 1 = one file per tick)
        c.RunScanToCompletion();
        var kinds = _env.Queue.All().Select(i => i.Kind).ToList();
        Assert.Equal(4, kinds.Count(k => k == "file_meta"));
        Assert.Equal(1, kinds.Count(k => k == "manifest"));
        await c.TickAsync(default); // second original: the queue holds ~3 KB < 5 KB
        await c.TickAsync(default); // now ~6 KB of originals wait: held back
        Assert.Equal(2, _env.Queue.All().Count(i => i.Kind == "manifest"));
        Assert.Contains("originals waiting for the uploader", c.Detail);
        Assert.Contains("originals: 2 to upload", c.Detail);
        // the uploader drains records first, then the bulk lane
        var next = _env.Queue.NextDue()!;
        Assert.Equal("file_meta", next.Kind);
    }
}
