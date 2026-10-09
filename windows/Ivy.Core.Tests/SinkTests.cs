using System.Text;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;
using Ivy.Core.Upload;

namespace Ivy.Core.Tests;

public class SinkTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Enqueue_encrypts_to_mac_and_binds_key_and_kind()
    {
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity);
        var json = """{"v":1,"kind":"windows_notification","deviceId":"dev-1","eventTime":"2026-10-01T00:00:00.000Z","captureTime":"2026-10-10T00:00:00.000Z","app":"Mail","title":"Hi","text":"body","postedAt":"2026-10-01T00:00:00.000Z"}""";
        var r = sink.Enqueue(Kind.WindowsNotification, "up/wnotif", json, "notifications");
        Assert.StartsWith("up/wnotif/", r.ObjectKey);
        var item = p.Queue.All().Single();
        Assert.Equal(r.ObjectKey, item.ObjectKey);
        Assert.Equal("notifications", item.Collector);
        var bytes = File.ReadAllBytes(p.Queue.FullPathOf(item));
        Assert.Equal(json, Encoding.UTF8.GetString(_mac.Open(r.ObjectKey, bytes, Kind.WindowsNotification)));
        Assert.Equal(new[] { ActivityEvents.Queued, ActivityEvents.Encrypted }, p.Activity.Recent().Select(e => e.Event));
    }

    [Fact]
    public void Enqueue_rejects_mismatched_prefix_kind_or_bad_json()
    {
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1");
        const string ok = """{"v":1,"kind":"usage_event","deviceId":"d","eventTime":"t","captureTime":"t","app":"a","startedAt":"t","endedAt":"t"}""";
        Assert.Throws<ArgumentException>(() => sink.Enqueue(Kind.UsageEvent, "up/file", ok));
        Assert.Throws<ArgumentException>(() => sink.Enqueue(Kind.FileMeta, "up/file", ok));
        Assert.Throws<ArgumentException>(() => sink.Enqueue(Kind.UsageEvent, "up/usg", "{not json"));
        Assert.Throws<ArgumentException>(() => sink.Enqueue(Kind.UsageEvent, "up/usg", ok.Replace("\"v\":1", "\"v\":2")));
        Assert.Throws<ArgumentException>(() => sink.Enqueue(Kind.UsageEvent, "up/usg", ok.Replace("\"captureTime\":\"t\",", "")));
        Assert.Throws<ArgumentException>(() => sink.Enqueue(Kind.Manifest, "up/blob", ok));
        Assert.Empty(p.Queue.All());
        sink.Enqueue(Kind.UsageEvent, "up/usg/", ok);
        Assert.Single(p.Queue.All());
    }

    [Fact]
    public void Typed_enqueue_validates()
    {
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1");
        var bad = new FileMetaRecord { DeviceId = "d", EventTime = "t", CaptureTime = "t", Path = "p", Name = "n", Size = -5, Ext = "", Mtime = "t", QuickHash = "q" };
        Assert.Throws<RecordValidationException>(() => sink.Enqueue(bad));
        var r = sink.Enqueue(bad with { Size = 5 }, "files");
        var item = p.Queue.All().Single();
        var plain = _mac.Open(r.ObjectKey, File.ReadAllBytes(p.Queue.FullPathOf(item)), Kind.FileMeta);
        Assert.Equal(bad with { Size = 5 }, RecordJson.Parse<FileMetaRecord>(plain));
    }

    [Fact]
    public void Blob_is_manifest_first_and_decrypts_on_the_mac()
    {
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", options: new RecordSinkOptions { ChunkSize = 4096 });
        var data = new byte[10_000];
        Random.Shared.NextBytes(data);
        var blob = sink.EnqueueBlob(new MemoryStream(data), Kind.Screenshot, "screenshots");
        Assert.Equal(3, blob.TotalChunks);
        Assert.Equal(Bytes.ToHex(Bytes.Sha256(data)), blob.PlaintextSha256);
        var items = p.Queue.All();
        Assert.Equal(blob.ManifestKey, items[0].ObjectKey);
        Assert.All(items, i => Assert.Equal(blob.Oid, i.GroupKey));
        var parts = items.Skip(1).ToDictionary(i => ObjectKeys.Parse(i.ObjectKey).ChunkIndex!.Value, i => File.ReadAllBytes(p.Queue.FullPathOf(i)));
        var (manifest, plain) = Chunked.Decrypt(_mac.SecretKey, blob.ManifestKey, File.ReadAllBytes(p.Queue.FullPathOf(items[0])), parts);
        Assert.Equal(data, plain);
        Assert.Equal("screenshot", manifest.PayloadKind);
        Assert.Equal(Bytes.ToHex(Oids.ToBytes(blob.Oid)), manifest.ObjectId);
    }

    [Fact]
    public void Blob_with_wrong_declared_length_leaves_nothing_behind()
    {
        using var p = new AgentProcess(_dir.Path);
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", options: new RecordSinkOptions { ChunkSize = 1000 });
        Assert.Throws<IOException>(() => sink.EnqueueBlob(new MemoryStream(new byte[3000]), Kind.FileMeta, length: 5000));
        Assert.Throws<IOException>(() => sink.EnqueueBlob(new MemoryStream(new byte[3000]), Kind.FileMeta, length: 2000));
        Assert.Empty(p.Queue.All());
        Assert.Empty(Directory.GetFiles(p.Queue.QueueDirectory));
    }
}

/// <summary>PRD "Zero plaintext": nothing readable in the local queue or vault-agent.db.</summary>
public class ZeroPlaintextTests : IDisposable
{
    private const string Marker = "IVY-ZERO-PLAINTEXT-MARKER-7f3a9c1e";
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    public void Dispose() => _dir.Dispose();

    internal static void AssertNoMarker(string root, string marker)
    {
        var needles = new[] { Encoding.UTF8.GetBytes(marker), Encoding.Unicode.GetBytes(marker), Encoding.UTF8.GetBytes(Convert.ToBase64String(Encoding.UTF8.GetBytes(marker))) };
        var scanned = 0;
        foreach (var f in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            byte[] bytes;
            using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var ms = new MemoryStream())
            {
                fs.CopyTo(ms);
                bytes = ms.ToArray();
            }
            scanned++;
            foreach (var n in needles) Assert.True(bytes.AsSpan().IndexOf(n) < 0, $"plaintext marker found in {f}");
        }
        Assert.True(scanned > 0, "nothing scanned");
    }

    [Fact]
    public async Task Queue_dir_and_database_never_contain_record_plaintext()
    {
        using (var p = new AgentProcess(_dir.Path))
        {
            var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity, new RecordSinkOptions { ChunkSize = 512 });
            const string t = "2026-10-10T00:00:00.000Z";
            sink.Enqueue(new WindowsNotificationRecord { DeviceId = "dev-1", EventTime = t, CaptureTime = t, App = "Mail", Title = Marker, Text = $"text {Marker}", PostedAt = t }, "notifications");
            sink.Enqueue(new UsageEventRecord { DeviceId = "dev-1", EventTime = t, CaptureTime = t, App = Marker, Title = Marker, StartedAt = t, EndedAt = t }, "usage");
            sink.Enqueue(Kind.FileMeta, "up/file", $$"""{"v":1,"kind":"file_meta","deviceId":"dev-1","eventTime":"{{t}}","captureTime":"{{t}}","path":"C:\\{{Marker}}.pdf","name":"{{Marker}}.pdf","size":1,"ext":"pdf","mtime":"{{t}}","quickHash":"q"}""", "files");
            var content = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat(Marker + "\n", 200)));
            sink.EnqueueBlob(new MemoryStream(content), Kind.Screenshot, "screenshots");

            // half-drained queue, with a failed attempt recorded in last_error
            var server = new FakeBucketServer();
            var n = 0;
            var client = new FakeUpClient(server) { BeforePut = _ => { if (n++ == 3) throw new HttpRequestException("offline"); } };
            await new Uploader(p.Queue, client, activity: p.Activity).DrainAsync();
            Assert.NotEmpty(p.Queue.All());
            Assert.NotEmpty(Directory.GetFiles(p.Queue.QueueDirectory));

            AssertNoMarker(_dir.Path, Marker); // live: db + -wal + -shm + queue/
            // and what reached the "bucket" is ciphertext too
            foreach (var (_, bytes) in server.Up) Assert.True(bytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(Marker)) < 0);
            p.Db.Checkpoint();
        }
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        AssertNoMarker(_dir.Path, Marker); // after checkpoint/close
    }
}
