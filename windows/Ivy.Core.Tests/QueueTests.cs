using Ivy.Core.Protocol;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;
using Ivy.Core.Upload;
using Microsoft.Extensions.Time.Testing;

namespace Ivy.Core.Tests;

/// <summary>One "process": database + queue (+ uploader) over a data directory that outlives it.</summary>
internal sealed class AgentProcess : IDisposable
{
    public AgentProcess(string dir, TimeProvider? time = null, BackoffPolicy? backoff = null)
    {
        Db = new VaultDb(Path.Combine(dir, VaultDb.FileName));
        Activity = new ActivityLog(Db, time);
        Queue = new UploadQueue(Db, Path.Combine(dir, "queue"), backoff, time, Activity);
    }

    public VaultDb Db { get; }
    public ActivityLog Activity { get; }
    public UploadQueue Queue { get; }

    public void Dispose() => Db.Dispose();
}

public class QueueTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    public void Dispose() => _dir.Dispose();

    private byte[] Envelope(string key, Kind kind = Kind.FileMeta, int size = 100) =>
        Protocol.Envelope.Encrypt(_mac.PublicKey, kind, key, new byte[size]);

    [Fact]
    public void Enqueue_writes_file_before_row_and_drains_in_order()
    {
        using var p = new AgentProcess(_dir.Path);
        var keys = Enumerable.Range(0, 5).Select(_ => ObjectKeys.Up(Kind.FileMeta, Oids.New())).ToList();
        foreach (var k in keys) p.Queue.EnqueueCiphertext(k, Kind.FileMeta, Envelope(k), "files");
        var all = p.Queue.All();
        Assert.Equal(keys, all.Select(i => i.ObjectKey));
        Assert.All(all, i => Assert.True(File.Exists(p.Queue.FullPathOf(i))));
        Assert.All(all, i => Assert.Equal(QueueStatus.Queued, i.Status));
        Assert.Equal(5, p.Queue.Depth());
        Assert.Equal(5, p.Queue.Depth("files"));
        Assert.Equal(keys[0], p.Queue.NextDue()!.ObjectKey);

        var first = p.Queue.NextDue()!;
        p.Queue.Complete(first.Id);
        Assert.False(File.Exists(p.Queue.FullPathOf(first)));
        Assert.Null(p.Queue.Get(first.Id));
        Assert.Equal(keys[1], p.Queue.NextDue()!.ObjectKey);
    }

    [Fact]
    public void Group_items_are_strictly_ordered_but_do_not_block_others()
    {
        using var p = new AgentProcess(_dir.Path);
        var oid = Oids.New();
        var files = new List<PartFile>
        {
            p.Queue.WritePartFile(ObjectKeys.BlobManifest(oid), Kind.Manifest, Envelope(ObjectKeys.BlobManifest(oid), Kind.Manifest)),
            p.Queue.WritePartFile(ObjectKeys.BlobChunk(oid, 0), Kind.BlobChunk, new byte[64]),
        };
        p.Queue.Enqueue(files, groupKey: oid);
        var other = ObjectKeys.Up(Kind.UsageEvent, Oids.New());
        p.Queue.EnqueueCiphertext(other, Kind.UsageEvent, Envelope(other, Kind.UsageEvent));

        var manifest = p.Queue.NextDue()!;
        Assert.EndsWith("/manifest", manifest.ObjectKey);
        p.Queue.MarkFailed(manifest.Id, "boom"); // backs off
        // the part must wait for its manifest; the unrelated record proceeds
        Assert.Equal(other, p.Queue.NextDue()!.ObjectKey);
    }

    [Fact]
    public void Failure_increments_attempts_with_exponential_backoff()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-10-10T00:00:00Z"));
        var backoff = new BackoffPolicy { BaseDelay = TimeSpan.FromSeconds(5), MaxDelay = TimeSpan.FromSeconds(60) };
        using var p = new AgentProcess(_dir.Path, time, backoff);
        var key = ObjectKeys.Up(Kind.FileMeta, Oids.New());
        p.Queue.EnqueueCiphertext(key, Kind.FileMeta, Envelope(key));
        var expected = new[] { 5, 10, 20, 40, 60, 60 };
        for (var n = 0; n < expected.Length; n++)
        {
            var item = p.Queue.NextDue()!;
            Assert.Equal(n, item.Attempts);
            var delay = p.Queue.MarkFailed(item.Id, "network down");
            Assert.Equal(TimeSpan.FromSeconds(expected[n]), delay);
            Assert.Null(p.Queue.NextDue());
            time.Advance(delay - TimeSpan.FromMilliseconds(1));
            Assert.Null(p.Queue.NextDue());
            time.Advance(TimeSpan.FromMilliseconds(1));
            var again = p.Queue.NextDue()!;
            Assert.Equal(n + 1, again.Attempts);
            Assert.Equal("network down", again.LastError);
        }
    }

    [Fact]
    public void Reconcile_repairs_every_crash_window()
    {
        var keep = ObjectKeys.Up(Kind.FileMeta, Oids.New());
        var missing = ObjectKeys.Up(Kind.FileMeta, Oids.New());
        var inflight = ObjectKeys.Up(Kind.FileMeta, Oids.New());
        var doneKey = ObjectKeys.Up(Kind.FileMeta, Oids.New());
        var orphanSingle = ObjectKeys.Up(Kind.UsageEvent, Oids.New());
        var blobOid = Oids.New();
        var halfBlobOid = Oids.New();
        string doneFile;
        using (var p = new AgentProcess(_dir.Path))
        {
            foreach (var k in new[] { keep, missing, inflight, doneKey }) p.Queue.EnqueueCiphertext(k, Kind.FileMeta, Envelope(k));
            var items = p.Queue.All().ToDictionary(i => i.ObjectKey);
            File.Delete(p.Queue.FullPathOf(items[missing]));         // row without part
            p.Queue.MarkUploading(items[inflight].Id);              // crashed mid-upload
            doneFile = p.Queue.FullPathOf(items[doneKey]);
            using (var c = p.Db.Open())
            using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = $"UPDATE pending_uploads SET status='done' WHERE id='{items[doneKey].Id}'"; // crashed after confirm
                cmd.ExecuteNonQuery();
            }
            // part written, process died before the row insert
            p.Queue.WritePartFile(orphanSingle, Kind.UsageEvent, Envelope(orphanSingle, Kind.UsageEvent));
            // complete blob written (manifest + all parts) but never enqueued
            var blob = Chunked.Encrypt(_mac.PublicKey, blobOid, Oids.ToBytes(blobOid), PayloadKinds.Screenshot, new byte[600], 256);
            foreach (var part in blob.Parts) p.Queue.WritePartFile(part.ObjectKey, Kind.BlobChunk, part.Bytes);
            p.Queue.WritePartFile(blob.ManifestKey, Kind.Manifest, blob.ManifestEnvelope);
            // incomplete blob: parts only, crashed before the manifest
            var half = Chunked.Encrypt(_mac.PublicKey, halfBlobOid, Oids.ToBytes(halfBlobOid), PayloadKinds.Screenshot, new byte[600], 256);
            p.Queue.WritePartFile(half.Parts[0].ObjectKey, Kind.BlobChunk, half.Parts[0].Bytes);
            // a torn temp write
            File.WriteAllBytes(Path.Combine(p.Queue.QueueDirectory, "x.ivy.123.tmp"), new byte[10]);
        }

        using (var p = new AgentProcess(_dir.Path))
        {
            var report = p.Queue.Reconcile();
            Assert.Equal(new ReconcileReport(ResetUploading: 1, OrphansRequeued: 1 + 4, OrphansDeleted: 1, TempFilesDeleted: 1, RowsMissingFile: 1, DoneRowsFinalized: 1), report);
            var keys = p.Queue.All().Select(i => i.ObjectKey).ToList();
            Assert.Contains(keep, keys);
            Assert.Contains(inflight, keys);
            Assert.DoesNotContain(missing, keys);
            Assert.DoesNotContain(doneKey, keys);
            Assert.False(File.Exists(doneFile));
            Assert.Contains(orphanSingle, keys);
            Assert.Equal("usage_event", p.Queue.All().Single(i => i.ObjectKey == orphanSingle).Kind);
            var blobKeys = keys.Where(k => k.Contains(blobOid)).ToList();
            Assert.Equal(new[] { ObjectKeys.BlobManifest(blobOid), ObjectKeys.BlobChunk(blobOid, 0), ObjectKeys.BlobChunk(blobOid, 1), ObjectKeys.BlobChunk(blobOid, 2) }, blobKeys);
            Assert.DoesNotContain(keys, k => k.Contains(halfBlobOid));
            Assert.Empty(Directory.GetFiles(p.Queue.QueueDirectory, "*.tmp"));
            Assert.Contains(p.Activity.Recent(), e => e.Event == ActivityEvents.Lost);
            // every remaining row has its file and every file has its row
            var files = Directory.GetFiles(p.Queue.QueueDirectory).Select(Path.GetFileName).OrderBy(f => f, StringComparer.Ordinal);
            Assert.Equal(p.Queue.All().Select(i => i.PartPath).OrderBy(f => f, StringComparer.Ordinal), files);
            // idempotent
            Assert.Equal(new ReconcileReport(0, 0, 0, 0, 0, 0), p.Queue.Reconcile());
        }
    }

    [Fact]
    public async Task Multipart_resumes_from_last_completed_part_after_restart()
    {
        var server = new FakeBucketServer();
        var options = new UploaderOptions { MultipartThreshold = 6 * 1024 * 1024, PartSize = 5 * 1024 * 1024 };
        var blob = new byte[13 * 1024 * 1024]; // 3 parts: 5 + 5 + 3 MiB
        Random.Shared.NextBytes(blob);
        var key = ObjectKeys.BlobChunk(Oids.New(), 0);

        // process 1: dies (cancellation) while uploading part 2
        using (var p = new AgentProcess(_dir.Path))
        {
            p.Queue.EnqueueCiphertext(key, Kind.BlobChunk, blob);
            using var crash = new CancellationTokenSource();
            var client = new FakeUpClient(server) { BeforeUploadPart = (n, _) => { if (n == 2) crash.Cancel(); } };
            var uploader = new Uploader(p.Queue, client, options, p.Activity, p.Db);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => uploader.DrainAsync(crash.Token));
            var item = p.Queue.All().Single();
            Assert.NotNull(item.UploadId);
            Assert.Equal(new[] { 1 }, p.Queue.GetCompletedParts(item.Id).Select(x => x.PartNumber));
        }
        Assert.Single(server.Calls, c => c.StartsWith("part ") && c.EndsWith(" 1"));

        // process 2: reconcile + resume; only parts 2 and 3 are sent, with the same upload id
        using (var p = new AgentProcess(_dir.Path))
        {
            p.Queue.Reconcile();
            var uploadId = p.Queue.All().Single().UploadId;
            var uploader = new Uploader(p.Queue, new FakeUpClient(server), options, p.Activity, p.Db);
            Assert.Equal(1, await uploader.DrainAsync());
            Assert.Empty(p.Queue.All());
            Assert.Empty(Directory.GetFiles(p.Queue.QueueDirectory));
            var parts = server.Calls.Where(c => c.StartsWith("part ")).ToList();
            Assert.Equal(new[] { $"part {key} {uploadId} 1", $"part {key} {uploadId} 2", $"part {key} {uploadId} 3" }, parts);
            Assert.Single(server.Calls, c => c.StartsWith("create "));
            Assert.Equal(blob, server.Up[key]);
        }
    }

    [Fact]
    public async Task Multipart_restarts_when_server_forgot_the_upload()
    {
        var server = new FakeBucketServer();
        var options = new UploaderOptions { MultipartThreshold = 6 * 1024 * 1024, PartSize = 5 * 1024 * 1024 };
        var blob = new byte[11 * 1024 * 1024];
        var key = ObjectKeys.BlobChunk(Oids.New(), 0);
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        using var p = new AgentProcess(_dir.Path, time);
        p.Queue.EnqueueCiphertext(key, Kind.BlobChunk, blob);
        var uploader = new Uploader(p.Queue, new FakeUpClient(server) { BeforeUploadPart = (n, _) => { if (n == 2) server.Uploads.Clear(); } }, options, time: time);
        Assert.Equal(0, await uploader.DrainAsync());
        var item = p.Queue.All().Single();
        Assert.Null(item.UploadId);
        Assert.Equal(1, item.Attempts);
        time.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(1, await new Uploader(p.Queue, new FakeUpClient(server), options, time: time).DrainAsync());
        Assert.Equal(blob, server.Up[key]);
    }
}

public class UploaderTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task Drains_in_order_with_progress_and_deletes_after_confirmation()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity, new RecordSinkOptions { ChunkSize = 1024 });
        var blob = sink.EnqueueBlob(new MemoryStream(new byte[5000]), PayloadKinds.Screenshot, "screenshots");
        var rec = sink.Enqueue(Kind.UsageEvent, "up/usg", """{"v":1,"kind":"usage_event","deviceId":"dev-1","eventTime":"t","captureTime":"t","app":"a","startedAt":"t","endedAt":"t"}""", "usage");

        var uploader = new Uploader(p.Queue, new FakeUpClient(server), activity: p.Activity);
        var events = new List<UploadProgress>();
        uploader.Progress += (_, e) => { lock (events) events.Add(e); };
        Assert.Equal(7, await uploader.DrainAsync());

        var puts = server.Calls.Select(c => c.Split(' ')[1]).ToList();
        Assert.Equal(blob.ManifestKey, puts[0]);
        Assert.Equal(Enumerable.Range(0, 5).Select(i => ObjectKeys.BlobChunk(blob.Oid, i)), puts.Skip(1).Take(5));
        Assert.Equal(rec.ObjectKey, puts[6]);
        Assert.Empty(p.Queue.All());
        Assert.Empty(Directory.GetFiles(p.Queue.QueueDirectory));
        Assert.Equal(7, events.Count(e => e.Phase == UploadPhase.Completed));
        Assert.All(events.GroupBy(e => e.ObjectKey), g =>
        {
            Assert.Equal(UploadPhase.Started, g.First().Phase);
            Assert.Equal(UploadPhase.Completed, g.Last().Phase);
            Assert.Equal(g.Last().TotalBytes, g.Last().BytesSent);
        });
        Assert.Contains(p.Activity.Recent(), e => e.Event == ActivityEvents.Uploaded && e.Collector == "screenshots");
    }

    [Fact]
    public async Task Bulk_lane_drains_after_normal_items_and_a_preallocated_oid_is_used()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity, new RecordSinkOptions { ChunkSize = 1024 });
        var oid = Oids.New();
        var bulk = sink.EnqueueBlob(new MemoryStream(new byte[2000]), PayloadKinds.Photo, "files", oid: oid, bulk: true);
        Assert.Equal(oid, bulk.Oid);
        Assert.Equal(ObjectKeys.BlobManifest(oid), bulk.ManifestKey);
        Assert.True(p.Queue.Contains(bulk.ManifestKey));
        Assert.True(p.Queue.BulkBytes("files") > 2000);
        Assert.Equal(0, p.Queue.BulkBytes("screenshots"));
        // enqueued later, but in the normal lane: uploads first
        var rec = sink.Enqueue(Kind.UsageEvent, "up/usg", """{"v":1,"kind":"usage_event","deviceId":"dev-1","eventTime":"t","captureTime":"t","app":"a","startedAt":"t","endedAt":"t"}""", "usage");
        var shot = sink.EnqueueBlob(new MemoryStream(new byte[10]), PayloadKinds.Screenshot, "screenshots");
        Assert.Throws<ArgumentException>(() => sink.EnqueueBlob(new MemoryStream(new byte[1]), PayloadKinds.Photo, oid: "not-an-oid"));

        Assert.Equal(6, await new Uploader(p.Queue, new FakeUpClient(server)).DrainAsync());
        var puts = server.Calls.Select(c => c.Split(' ')[1]).ToList();
        Assert.Equal(new[] { rec.ObjectKey, shot.ManifestKey, ObjectKeys.BlobChunk(shot.Oid, 0), bulk.ManifestKey, ObjectKeys.BlobChunk(oid, 0), ObjectKeys.BlobChunk(oid, 1) }, puts);
        Assert.Equal(0, p.Queue.BulkBytes("files"));
        Assert.False(p.Queue.Contains(bulk.ManifestKey));
    }

    [Fact]
    public async Task Default_options_send_large_originals_via_multipart()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1"); // production defaults
        var data = new byte[40 * 1024 * 1024];
        Random.Shared.NextBytes(data);
        var blob = sink.EnqueueBlob(new MemoryStream(data), PayloadKinds.FileOriginal, "files");
        Assert.Equal(2, blob.TotalChunks); // 32 MiB + 8 MiB
        Assert.Equal(3, await new Uploader(p.Queue, new FakeUpClient(server)).DrainAsync());
        var chunk0 = ObjectKeys.BlobChunk(blob.Oid, 0);
        Assert.Single(server.Calls, c => c.StartsWith($"create {chunk0} ", StringComparison.Ordinal));
        Assert.Equal(5, server.Calls.Count(c => c.StartsWith($"part {chunk0} ", StringComparison.Ordinal))); // 4 x 8 MiB + 48-byte tail
        Assert.Contains($"put {ObjectKeys.BlobChunk(blob.Oid, 1)}", server.Calls);
        var (_, plain) = Chunked.Decrypt(_mac.SecretKey, blob.ManifestKey, server.Up[blob.ManifestKey],
            new Dictionary<int, byte[]> { [0] = server.Up[chunk0], [1] = server.Up[ObjectKeys.BlobChunk(blob.Oid, 1)] });
        Assert.Equal(data, plain);
    }

    [Fact]
    public async Task Pause_stops_and_resume_continues_and_is_persisted()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var key = ObjectKeys.Up(Kind.FileMeta, Oids.New());
        p.Queue.EnqueueCiphertext(key, Kind.FileMeta, Envelope.Encrypt(_mac.PublicKey, Kind.FileMeta, key, new byte[10]));
        var uploader = new Uploader(p.Queue, new FakeUpClient(server), settingsDb: p.Db) { Paused = true };
        Assert.Equal(0, await uploader.DrainAsync());
        Assert.Empty(server.Up);
        Assert.True(new Uploader(p.Queue, new FakeUpClient(server), settingsDb: p.Db).Paused); // survives restart
        uploader.Paused = false;
        Assert.Equal(1, await uploader.DrainAsync());
        Assert.True(server.Up.ContainsKey(key));
    }

    [Fact]
    public async Task Failed_upload_is_retried_later_not_lost()
    {
        var server = new FakeBucketServer();
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        using var p = new AgentProcess(_dir.Path, time);
        var key = ObjectKeys.Up(Kind.FileMeta, Oids.New());
        p.Queue.EnqueueCiphertext(key, Kind.FileMeta, Envelope.Encrypt(_mac.PublicKey, Kind.FileMeta, key, new byte[10]));
        var failing = new FakeUpClient(server) { BeforePut = _ => throw new HttpRequestException("offline") };
        Assert.Equal(0, await new Uploader(p.Queue, failing, time: time).DrainAsync());
        var item = p.Queue.All().Single();
        Assert.Equal(1, item.Attempts);
        Assert.True(File.Exists(p.Queue.FullPathOf(item)));
        time.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal(1, await new Uploader(p.Queue, new FakeUpClient(server), time: time).DrainAsync());
        Assert.Empty(p.Queue.All());
    }

    [Fact]
    public async Task Bandwidth_cap_limits_throughput()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var key = ObjectKeys.BlobChunk(Oids.New(), 0);
        p.Queue.EnqueueCiphertext(key, Kind.BlobChunk, new byte[150_000]);
        var uploader = new Uploader(p.Queue, new FakeUpClient(server), new UploaderOptions { BandwidthBytesPerSecond = 100_000 });
        var sw = System.Diagnostics.Stopwatch.StartNew();
        Assert.Equal(1, await uploader.DrainAsync());
        sw.Stop();
        // the bucket starts empty: 150 kB at 100 kB/s needs ~1.5 s
        Assert.InRange(sw.Elapsed.TotalSeconds, 1.2, 10);
        uploader.BandwidthBytesPerSecond = 0;
        Assert.Equal(0, uploader.BandwidthBytesPerSecond);
    }

    [Fact]
    public async Task Token_bucket_with_fake_clock()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var bucket = new TokenBucket(100_000, time);
        var take = bucket.TakeAsync(250_000);
        Assert.False(take.IsCompleted);
        for (var i = 0; i < 40 && !take.IsCompleted; i++)
        {
            time.Advance(TimeSpan.FromMilliseconds(100));
            await Task.Delay(5);
        }
        Assert.True(take.IsCompleted);
        Assert.True(bucket.TakeAsync(0).IsCompleted);
        Assert.True(new TokenBucket(0, time).TakeAsync(10_000_000).IsCompleted);
    }
}
