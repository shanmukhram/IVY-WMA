using Ivy.Core.Protocol;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;
using Ivy.Core.Upload;

namespace Ivy.Core.Tests;

/// <summary>
/// A blob's manifest must never be left alone in R2: its parts follow it promptly, survive a restart, are not held
/// back indefinitely by the meta lane, and a part that is truly gone is logged rather than silently dropped.
/// </summary>
public class BlobDeliveryTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    public void Dispose() => _dir.Dispose();

    private static readonly BackoffPolicy NoBackoff = new() { BaseDelay = TimeSpan.Zero, MaxDelay = TimeSpan.Zero };

    private const string UsageJson = """{"v":1,"kind":"usage_event","deviceId":"dev-1","eventTime":"t","captureTime":"t","app":"a","startedAt":"t","endedAt":"t"}""";

    private string EnqueueMeta(UploadQueue q)
    {
        var key = ObjectKeys.Up(Kind.FileMeta, Oids.New());
        q.EnqueueCiphertext(key, Kind.FileMeta, Envelope.Encrypt(_mac.PublicKey, Kind.FileMeta, key, new byte[64]), "files", lane: UploadQueue.MetaLane);
        return key;
    }

    private static List<string> Puts(FakeBucketServer server) =>
        server.Calls.Where(c => c.StartsWith("put ", StringComparison.Ordinal)).Select(c => c.Split(' ')[1]).ToList();

    private sealed class PartRefused : Exception { public PartRefused() : base("network down") { } }

    [Fact]
    public async Task One_part_photo_blob_uploads_manifest_then_its_part_behind_a_meta_backlog()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity);
        var meta = Enumerable.Range(0, 30).Select(_ => EnqueueMeta(p.Queue)).ToList();
        var photo = sink.EnqueueBlob(new MemoryStream(new byte[2000]), PayloadKinds.Photo, "files", bulk: true);
        var rec = sink.Enqueue(Kind.UsageEvent, "up/usg", UsageJson, "usage");
        Assert.Equal(1, photo.TotalChunks);

        Assert.Equal(33, await new Uploader(p.Queue, new FakeUpClient(server), new UploaderOptions { Concurrency = 1 }).DrainAsync());

        var puts = Puts(server);
        Assert.Equal(rec.ObjectKey, puts[0]);                                     // conversations first, still
        var m = puts.IndexOf(photo.ManifestKey);
        Assert.InRange(m, 1, p.Queue.BulkFairShare + 1);                           // the bulk lane got its turn early
        Assert.Equal(ObjectKeys.BlobChunk(photo.Oid, 0), puts[m + 1]);             // and the part followed its manifest at once
        Assert.True(server.Up.ContainsKey(ObjectKeys.BlobChunk(photo.Oid, 0)));
        Assert.All(meta, k => Assert.True(server.Up.ContainsKey(k)));
        Assert.Empty(p.Queue.All());
    }

    [Fact]
    public async Task Parallel_drain_never_leaves_a_manifest_without_its_part()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity);
        var blobs = new List<EnqueuedBlob>();
        for (var i = 0; i < 20; i++)
        {
            for (var j = 0; j < 5; j++) EnqueueMeta(p.Queue);
            blobs.Add(sink.EnqueueBlob(new MemoryStream(new byte[3000]), PayloadKinds.Photo, "files", bulk: true));
        }
        await new Uploader(p.Queue, new FakeUpClient(server), new UploaderOptions { Concurrency = 16 }).DrainAsync();
        Assert.All(blobs, b =>
        {
            Assert.True(server.Up.ContainsKey(b.ManifestKey));
            Assert.True(server.Up.ContainsKey(ObjectKeys.BlobChunk(b.Oid, 0)));
        });
        Assert.Empty(p.Queue.All());
    }

    [Fact]
    public async Task Restart_between_manifest_and_part_still_uploads_the_part()
    {
        var server = new FakeBucketServer();
        EnqueuedBlob photo;
        using (var p = new AgentProcess(_dir.Path, backoff: NoBackoff))
        {
            var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity);
            photo = sink.EnqueueBlob(new MemoryStream(new byte[2000]), PayloadKinds.Photo, "files", bulk: true);
            var client = new FakeUpClient(server) { BeforePut = k => { if (k.Contains("/p/", StringComparison.Ordinal)) throw new PartRefused(); } };
            // concurrency 1 and no backoff would retry the part forever inside one drain: pause after the failure
            var uploader = new Uploader(p.Queue, client, new UploaderOptions { Concurrency = 1 });
            uploader.Progress += (_, e) => { if (e.Phase == UploadPhase.Failed) uploader.Paused = true; };
            await uploader.DrainAsync();
            Assert.True(server.Up.ContainsKey(photo.ManifestKey));
            Assert.False(server.Up.ContainsKey(ObjectKeys.BlobChunk(photo.Oid, 0)));
            // the process then dies while the part is in flight
            var part = p.Queue.All().Single();
            p.Queue.MarkUploading(part.Id);
        }

        using (var p = new AgentProcess(_dir.Path, backoff: NoBackoff))
        {
            var report = p.Queue.Reconcile();
            Assert.Equal(1, report.ResetUploading);
            Assert.Equal(0, report.RowsMissingFile);
            Assert.Equal(1, await new Uploader(p.Queue, new FakeUpClient(server), new UploaderOptions { Concurrency = 1 }).DrainAsync());
            Assert.True(server.Up.ContainsKey(ObjectKeys.BlobChunk(photo.Oid, 0)));
            Assert.Empty(p.Queue.All());
        }
    }

    [Fact]
    public async Task Startup_requeues_a_part_whose_manifest_already_went_out_when_its_file_still_exists()
    {
        var server = new FakeBucketServer();
        EnqueuedBlob doc;
        using (var p = new AgentProcess(_dir.Path))
        {
            var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity, new RecordSinkOptions { ChunkSize = 1024 });
            doc = sink.EnqueueBlob(new MemoryStream(new byte[3000]), PayloadKinds.Document, "files", bulk: true); // 3 parts
            var client = new FakeUpClient(server);
            // the manifest and part 0 go out ...
            for (var i = 0; i < 2; i++)
            {
                var item = p.Queue.ClaimNextDue()!;
                await using (var fs = File.OpenRead(p.Queue.FullPathOf(item)))
                    await client.PutAsync(item.ObjectKey, fs, item.Size);
                p.Queue.Complete(item.Id);
            }
            // ... then the rows of parts 1 and 2 are lost while their files stay on disk
            using var c = p.Db.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "DELETE FROM pending_uploads";
            cmd.ExecuteNonQuery();
        }

        using (var p = new AgentProcess(_dir.Path))
        {
            var report = p.Queue.Reconcile();
            Assert.Equal(2, report.OrphansRequeued);
            Assert.Equal(0, report.OrphansDeleted);
            Assert.Equal(new[] { ObjectKeys.BlobChunk(doc.Oid, 1), ObjectKeys.BlobChunk(doc.Oid, 2) }, p.Queue.All().Select(i => i.ObjectKey));
            Assert.Equal(2, await new Uploader(p.Queue, new FakeUpClient(server), new UploaderOptions { Concurrency = 1 }).DrainAsync());
            Assert.Equal(new[] { ObjectKeys.BlobChunk(doc.Oid, 1), ObjectKeys.BlobChunk(doc.Oid, 2) }, Puts(server).Skip(2));
            Assert.Contains(p.Activity.Recent(), e => e.Event == ActivityEvents.Reconciled && e.Detail!.Contains(doc.Oid, StringComparison.Ordinal));
        }
    }

    [Fact]
    public async Task A_lost_part_before_its_manifest_went_out_drops_the_whole_blob_and_says_so()
    {
        var server = new FakeBucketServer();
        EnqueuedBlob doc;
        using (var p = new AgentProcess(_dir.Path))
        {
            var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity, new RecordSinkOptions { ChunkSize = 1024 });
            doc = sink.EnqueueBlob(new MemoryStream(new byte[2000]), PayloadKinds.Document, "files", bulk: true); // 2 parts
            var other = sink.Enqueue(Kind.UsageEvent, "up/usg", UsageJson, "usage");
            File.Delete(p.Queue.FullPathOf(p.Queue.All().Single(i => i.ObjectKey == ObjectKeys.BlobChunk(doc.Oid, 1))));
        }

        using (var p = new AgentProcess(_dir.Path))
        {
            var report = p.Queue.Reconcile();
            Assert.Equal(3, report.RowsMissingFile);                                   // the lost part, then the manifest and part 0
            Assert.DoesNotContain(p.Queue.All(), i => i.ObjectKey.Contains(doc.Oid, StringComparison.Ordinal));
            Assert.Equal(1, await new Uploader(p.Queue, new FakeUpClient(server), new UploaderOptions { Concurrency = 1 }).DrainAsync());
            Assert.DoesNotContain(server.Up.Keys, k => k.Contains(doc.Oid, StringComparison.Ordinal)); // no manifest left alone
            var lost = p.Activity.Recent().Where(e => e.Event == ActivityEvents.Lost).Select(e => e.Detail!).ToList();
            Assert.Contains(lost, d => d.Contains(ObjectKeys.BlobChunk(doc.Oid, 1), StringComparison.Ordinal) && d.Contains("cannot be completed", StringComparison.Ordinal));
            Assert.Equal(3, lost.Count(d => d.Contains(doc.Oid, StringComparison.Ordinal)));
            Assert.Empty(Directory.GetFiles(p.Queue.QueueDirectory));
        }
    }

    [Fact]
    public async Task A_part_lost_after_its_manifest_went_out_is_logged_honestly_at_upload_time()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity);
        var photo = sink.EnqueueBlob(new MemoryStream(new byte[2000]), PayloadKinds.Photo, "files", bulk: true);
        var client = new FakeUpClient(server)
        {
            // the part's file disappears right after the manifest is confirmed
            BeforePut = k => { if (k == photo.ManifestKey) File.Delete(Path.Combine(p.Queue.QueueDirectory, UploadQueue.FileNameFor(ObjectKeys.BlobChunk(photo.Oid, 0)))); },
        };
        Assert.Equal(1, await new Uploader(p.Queue, client, new UploaderOptions { Concurrency = 1 }, p.Activity).DrainAsync());
        Assert.True(server.Up.ContainsKey(photo.ManifestKey));
        Assert.Empty(p.Queue.All());
        Assert.Contains(p.Activity.Recent(), e => e.Event == ActivityEvents.Lost
            && e.Detail!.Contains(ObjectKeys.BlobChunk(photo.Oid, 0), StringComparison.Ordinal)
            && e.Detail.Contains("already uploaded", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Bulk_lane_is_not_starved_by_a_continuous_stream_of_meta_items()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity);
        EnqueueMeta(p.Queue);
        var photo = sink.EnqueueBlob(new MemoryStream(new byte[2000]), PayloadKinds.Photo, "files", bulk: true);
        // every upload brings a new file listing, as during a first index pass: the meta lane never empties
        var added = 0;
        var client = new FakeUpClient(server) { BeforePut = _ => { if (Interlocked.Increment(ref added) <= 200) EnqueueMeta(p.Queue); } };
        await new Uploader(p.Queue, client, new UploaderOptions { Concurrency = 1 }).DrainAsync();

        var puts = Puts(server);
        var m = puts.IndexOf(photo.ManifestKey);
        Assert.InRange(m, 0, p.Queue.BulkFairShare);                               // bounded wait, not "after all 200"
        Assert.Equal(ObjectKeys.BlobChunk(photo.Oid, 0), puts[m + 1]);
        Assert.Equal(203, puts.Count);
        Assert.Empty(p.Queue.All());
    }

    [Fact]
    public async Task Fast_lane_still_goes_before_a_started_blob_and_the_meta_lane()
    {
        var server = new FakeBucketServer();
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity, new RecordSinkOptions { ChunkSize = 1024 });
        var doc = sink.EnqueueBlob(new MemoryStream(new byte[3000]), PayloadKinds.Document, "files", bulk: true);
        string? fast = null;
        var client = new FakeUpClient(server)
        {
            BeforePut = k => { if (k == doc.ManifestKey) { EnqueueMeta(p.Queue); fast = sink.Enqueue(Kind.UsageEvent, "up/usg", UsageJson, "usage").ObjectKey; } },
        };
        await new Uploader(p.Queue, client, new UploaderOptions { Concurrency = 1 }).DrainAsync();
        var puts = Puts(server);
        Assert.Equal(doc.ManifestKey, puts[0]);
        Assert.Equal(fast, puts[1]);                                                // a message arriving mid-blob goes first
        Assert.Equal(Enumerable.Range(0, 3).Select(i => ObjectKeys.BlobChunk(doc.Oid, i)), puts.Skip(2).Take(3)); // then the blob finishes
        Assert.StartsWith("up/file/", puts[5]);                                    // before new meta work
    }

    [Fact]
    public void A_blob_oid_still_in_the_queue_is_refused_without_touching_its_files()
    {
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity);
        var oid = Oids.New();
        sink.EnqueueBlob(new MemoryStream(new byte[2000]), PayloadKinds.Photo, "files", oid: oid, bulk: true);
        var before = p.Queue.All().ToDictionary(i => i.ObjectKey, i => File.ReadAllBytes(p.Queue.FullPathOf(i)));

        Assert.Throws<InvalidOperationException>(() => sink.EnqueueBlob(new MemoryStream(new byte[2000]), PayloadKinds.Photo, "files", oid: oid, bulk: true));

        var after = p.Queue.All();
        Assert.Equal(before.Keys, after.Select(i => i.ObjectKey));
        Assert.All(after, i => Assert.Equal(before[i.ObjectKey], File.ReadAllBytes(p.Queue.FullPathOf(i))));
        Assert.True(p.Queue.ContainsBlob(oid));
        Assert.False(p.Queue.ContainsBlob(Oids.New()));
    }
}
