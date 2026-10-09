using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Ivy.Collectors.Common;
using Ivy.Collectors.Host;
using Ivy.Collectors.Screenshots;
using Ivy.Collectors.Tests.Support;
using Ivy.Core.Protocol;

namespace Ivy.Collectors.Tests;

public class ScreenshotTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly ManualChangeSource _changes = new();
    private readonly RecordingFileSystem _fs = new();
    private readonly string _shots;

    public ScreenshotTests()
    {
        _env = new TestEnv(_dir);
        _shots = _dir.Sub("Pictures", "Screenshots");
        Directory.CreateDirectory(_shots);
    }

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private ScreenshotCollector NewCollector(Common.CollectorContext? ctx = null, bool uploadExisting = true, params string[] extraRoots)
    {
        var c = new ScreenshotCollector(ctx ?? _env.Context, _fs, _changes, localZone: TimeZoneInfo.Utc);
        var roots = new JsonArray(new[] { _shots }.Concat(extraRoots).Select(r => (JsonNode?)r).ToArray());
        c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), new JsonObject { ["roots"] = roots, ["uploadExisting"] = uploadExisting }));
        return c;
    }

    private Task Tick(ScreenshotCollector c, double advanceSeconds = 0)
    {
        if (advanceSeconds > 0) _env.Time.Advance(TimeSpan.FromSeconds(advanceSeconds));
        return c.TickAsync(default);
    }

    [Fact]
    public async Task New_screenshot_is_uploaded_once_it_is_stable_with_blob_and_record()
    {
        var c = NewCollector();
        await c.StartAsync(default);
        await Tick(c);                                         // initial sweep: folder empty

        var png = Images.Png(1920, 1080, transparent: false);
        var path = Path.Combine(_shots, "Screenshot 2026-10-10 120000.png");
        await File.WriteAllBytesAsync(path, png[..1000]);       // partially written
        _changes.Raise(path);
        await Tick(c);
        Assert.Empty(_env.Sink.Records);
        await Tick(c, 1);
        Assert.Empty(_env.Sink.Records);

        await File.WriteAllBytesAsync(path, png);               // still growing: debounce restarts
        await Tick(c, 1.5);
        Assert.Empty(_env.Sink.Records);
        await Tick(c, 1);
        Assert.Empty(_env.Sink.Records);                        // only 1 s stable so far
        await Tick(c, 1.5);

        var blob = Assert.Single(_env.Sink.Blobs);
        Assert.Equal(png, blob.Data);
        Assert.Equal(Kind.Screenshot, blob.PayloadKind);
        Assert.Equal("screenshots", blob.Collector);
        var rec = Assert.Single(_env.Sink.Of(Kind.Screenshot));
        Assert.Equal(blob.Oid, rec.Str("blobOid"));
        Assert.Equal(Bytes.ToHex(SHA256.HashData(png)), rec.Str("sha256"));
        Assert.Equal(path, rec.Str("sourcePath"));
        Assert.Equal(1920, rec.Root.GetProperty("width").GetInt32());
        Assert.Equal(1080, rec.Root.GetProperty("height").GetInt32());
        var fi = new FileInfo(path);
        Assert.Equal(IvyTime.Format(new DateTimeOffset(fi.LastWriteTimeUtc)), rec.Str("savedAt"));
        Assert.Equal(IvyTime.Format(new DateTimeOffset(fi.CreationTimeUtc)), rec.Str("takenAt"));   // no EXIF in a PNG
        Assert.Equal(rec.Str("takenAt"), rec.Str("eventTime"));
        Assert.Equal(IvyTime.Format(_env.Time.GetUtcNow()), rec.Str("captureTime"));
        Assert.Equal("seen:1", c.Cursor);

        // Nothing more on later ticks or sweeps.
        await Tick(c, 120);
        Assert.Single(_env.Sink.Blobs);
    }

    [Fact]
    public async Task File_still_open_for_writing_is_not_uploaded()
    {
        var c = NewCollector();
        await c.StartAsync(default);
        var path = Path.Combine(_shots, "locked.png");
        await File.WriteAllBytesAsync(path, Images.Png(64, 64));
        _fs.Locked.Add(path);
        _changes.Raise(path);
        await Tick(c);
        await Tick(c, 5);
        await Tick(c, 5);
        Assert.Empty(_env.Sink.Blobs);
        Assert.Equal(1, c.PendingCandidates);
        _fs.Locked.Clear();
        await Tick(c, 1);
        Assert.Single(_env.Sink.Blobs);
    }

    [Fact]
    public async Task Duplicates_are_skipped_by_sha256_across_names_and_restarts()
    {
        var bytes = Images.Png(300, 200);
        var a = Path.Combine(_shots, "a.png");
        await File.WriteAllBytesAsync(a, bytes);
        var c = NewCollector();
        await c.StartAsync(default);
        await Tick(c);
        await Tick(c, 3);
        Assert.Single(_env.Sink.Blobs);

        var copy = Path.Combine(_shots, "a - Copy.png");
        File.Copy(a, copy);
        _changes.Raise(copy);
        await Tick(c);
        await Tick(c, 3);
        Assert.Single(_env.Sink.Blobs);
        Assert.Single(_env.Sink.Of(Kind.Screenshot));

        // Not a screenshot type / not in the folder: ignored.
        var txt = Path.Combine(_shots, "notes.txt");
        await File.WriteAllTextAsync(txt, "x");
        _changes.Raise(txt);
        _changes.Raise(_dir.Write("elsewhere/b.png", "png?"));
        await Tick(c, 3);
        await Tick(c, 3);
        Assert.Single(_env.Sink.Blobs);

        // Restart: the sweep finds both files but neither is re-sent.
        await c.StopAsync();
        var c2 = NewCollector(_env.Restart());
        await c2.StartAsync(default);
        await Tick(c2);
        await Tick(c2, 3);
        Assert.Single(_env.Sink.Blobs);
        Assert.Equal("seen:1", c2.Cursor);
    }

    [Fact]
    public async Task Exif_DateTimeOriginal_sets_takenAt_and_multiple_roots_are_watched()
    {
        var second = _dir.Sub("OneDrive", "Screenshots");
        Directory.CreateDirectory(second);
        var jpeg = Images.WithExif(Images.Jpeg(640, 480), "2025:12:24 18:30:00");
        var path = Path.Combine(second, "photo.jpg");
        await File.WriteAllBytesAsync(path, jpeg);
        var c = NewCollector(extraRoots: second);
        await c.StartAsync(default);
        Assert.Equal(new[] { _shots, second }, _changes.Watched);
        await Tick(c);
        await Tick(c, 3);
        var rec = Assert.Single(_env.Sink.Of(Kind.Screenshot));
        Assert.Equal("2025-12-24T18:30:00.000Z", rec.Str("takenAt"));
        Assert.Equal("2025-12-24T18:30:00.000Z", rec.Str("eventTime"));
        Assert.Equal(640, rec.Root.GetProperty("width").GetInt32());
    }

    [Fact]
    public async Task UploadExisting_false_only_uploads_files_newer_than_the_first_start()
    {
        var old = Path.Combine(_shots, "old.png");
        await File.WriteAllBytesAsync(old, Images.Png(10, 10));
        File.SetLastWriteTimeUtc(old, _env.Time.GetUtcNow().AddDays(-1).UtcDateTime);
        var c = NewCollector(uploadExisting: false);
        await c.StartAsync(default);
        await Tick(c);
        await Tick(c, 3);
        Assert.Empty(_env.Sink.Blobs);

        var fresh = Path.Combine(_shots, "new.png");
        await File.WriteAllBytesAsync(fresh, Images.Png(12, 12));
        File.SetLastWriteTimeUtc(fresh, _env.Time.GetUtcNow().AddMinutes(1).UtcDateTime);
        await Tick(c, 61);                                      // periodic sweep picks it up without a watcher event
        await Tick(c, 3);
        Assert.Equal(fresh, Assert.Single(_env.Sink.Of(Kind.Screenshot)).Str("sourcePath"));
    }

    [Fact]
    public async Task Missing_folder_is_reported()
    {
        Directory.Delete(_shots);
        var c = NewCollector();
        await c.StartAsync(default);
        await Tick(c);
        Assert.Contains("screenshot folder not found", c.LastError);
    }
}
