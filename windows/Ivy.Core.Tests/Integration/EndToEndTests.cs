using System.Text;
using Ivy.Core.Agent;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.R2;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;
using Ivy.Core.Upload;

namespace Ivy.Core.Tests.Integration;

[Collection(S3MockCollection.Name)]
public sealed class EndToEndTests : IDisposable
{
    private readonly S3MockFixture _mock;
    private readonly MacOverMock _mac;
    private readonly TempDir _dir = new();

    public EndToEndTests(S3MockFixture mock)
    {
        _mock = mock;
        _mac = new MacOverMock(mock);
    }

    public void Dispose() => _dir.Dispose();

    private VaultAgent NewAgent(string name = "agent") => new(new VaultAgentOptions
    {
        DataDirectory = _dir.Sub(name),
        Sink = new RecordSinkOptions { ChunkSize = 64 * 1024 },
        Poller = new Ivy.Core.Commands.CommandPollerOptions { Interval = TimeSpan.FromHours(1) },
        Reporter = new DeviceReporterOptions { Interval = TimeSpan.FromHours(1), AppVersion = "test" },
        Uploader = new UploaderOptions { IdlePoll = TimeSpan.FromMilliseconds(200) },
    }, new FileKeyStore(_dir.Sub(name + "-keys")));

    /// <summary>Mac side of pairing: write the sealed bootstrap into the cmd-bucket and build the pairing string.</summary>
    private async Task<(string PairingString, string PairingId)> MacStartsPairingAsync()
    {
        var secret = SystemRandomSource.Instance.Bytes(32);
        var pairingId = Bytes.ToHex(SystemRandomSource.Instance.Bytes(16));
        var sealedBootstrap = PairingCodec.SealBootstrap(new BootstrapPayload { UpBucket = S3MockFixture.UpBucket, UpWriteToken = S3MockFixture.UpToken, PairingId = pairingId }, secret);
        await _mac.PutCmdAsync(ObjectKeys.PairingBootstrap(pairingId), IvyJson.SerializeToUtf8(sealedBootstrap));
        var s = PairingCodec.Encode(new PairingPayload
        {
            R2Endpoint = _mock.S3Url, Role = "windows", CmdBucket = S3MockFixture.CmdBucket, UpBucket = S3MockFixture.UpBucket,
            CmdReadToken = S3MockFixture.CmdToken, MacPublicKey = _mac.Keys.PublicKeyB64, MacFingerprint = _mac.Keys.Fingerprint,
            PairingId = pairingId, Secret = Bytes.ToBase64(secret), Exp = DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeMilliseconds(),
        });
        return (s, pairingId);
    }

    private async Task<(VaultAgent Agent, PairingResult Result, string PairingId)> PairedAgentAsync(string name = "agent")
    {
        var agent = NewAgent(name);
        await agent.StartAsync();
        Assert.False(agent.Pairing.IsPaired);
        var (s, id) = await MacStartsPairingAsync();
        var result = await agent.PairAsync(s);
        return (agent, result, id);
    }

    private async Task<string> MacSendsCommandAsync(PairingState device, CommandParams ps)
    {
        var key = ObjectKeys.Command(Oids.New());
        var now = IvyTime.Now();
        var cmd = new CommandRecord { DeviceId = "mac", EventTime = now, CaptureTime = now, CommandId = Guid.NewGuid().ToString(), IssuedAt = now, Params = ps };
        await _mac.PutCmdAsync(key, Envelope.Encrypt(Bytes.FromBase64(device.DevicePublicKey), Kind.Command, key, IvyJson.SerializeToUtf8(cmd)));
        return cmd.CommandId;
    }

    private async Task<List<(string Key, T Record)>> MacReadsAsync<T>(string prefix, Kind kind) where T : IvyRecord
    {
        var list = new List<(string, T)>();
        foreach (var k in await _mac.ListUpAsync(prefix))
        {
            try { list.Add((k, RecordJson.Parse<T>(_mac.Keys.Open(k, (await _mac.GetUpAsync(k))!, kind)))); }
            catch (IvyCryptoException) { /* another test's Mac key */ }
        }
        return list;
    }

    [Fact]
    public async Task Pairing_end_to_end()
    {
        var (agent, result, pairingId) = await PairedAgentAsync();
        await using (agent)
        {
            Assert.True(agent.Pairing.IsPaired);
            Assert.Equal(_mac.Keys.Fingerprint, result.MacFingerprint);

            // Mac ingests pair/<id>/device and decrypts it with its private key
            var key = ObjectKeys.PairingDevice(pairingId);
            var env = await _mac.GetUpAsync(key);
            Assert.NotNull(env);
            var rec = RecordJson.Parse<PairingDeviceRecord>(_mac.Keys.Open(key, env!, Kind.PairingDevice));
            Assert.Equal(pairingId, rec.PairingId);
            Assert.Equal("windows", rec.Role);
            Assert.Equal(result.DeviceFingerprint, rec.Fingerprint);
            Assert.Equal(Fingerprint.OfBase64(rec.PublicKey), result.DeviceFingerprint); // both screens show the same value
            Assert.Equal(rec.PublicKey, agent.PairingState!.DevicePublicKey);
            Assert.Equal(Bytes.FromBase64(rec.PublicKey), X25519.PublicKeyFromSecret(agent.Keys.LoadSecretKey()));

            // the workers are running: a device report reaches the bucket, wrapped to the Mac
            await agent.SyncNowAsync();
            var reports = await MacReadsAsync<DeviceReportRecord>("up/status/", Kind.DeviceReport);
            Assert.Contains(reports, r => r.Record.DeviceId == result.DeviceId && r.Record.Role == "windows" && r.Record.AppVersion == "test");
        }

        // re-opening the agent (reboot) resumes as paired from the key store
        await using var again = NewAgent();
        await again.StartAsync();
        Assert.True(again.Pairing.IsPaired);
        Assert.NotNull(again.Uploader);
    }

    [Fact]
    public async Task File_request_round_trip_produces_decryptable_blob_and_status()
    {
        var (agent, result, _) = await PairedAgentAsync();
        await using (agent)
        {
            var file = _dir.Sub("invoice.pdf");
            var data = new byte[300_000]; // 5 chunks at 64 KiB
            Random.Shared.NextBytes(data);
            await File.WriteAllBytesAsync(file, data);
            var okId = await MacSendsCommandAsync(agent.PairingState!, new FileRequestParams { Path = file });
            var missingId = await MacSendsCommandAsync(agent.PairingState!, new FileRequestParams { Path = _dir.Sub("missing.pdf") });

            await agent.SyncNowAsync();
            Assert.Equal(0, agent.Queue.Depth());

            var statuses = (await MacReadsAsync<CommandStatusRecord>("up/cstat/", Kind.CommandStatus)).Select(s => s.Record).ToDictionary(s => s.CommandId);
            Assert.Equal(CommandStatusValues.NotFound, statuses[missingId].Status);
            var ok = statuses[okId];
            Assert.Equal(CommandStatusValues.Uploaded, ok.Status);
            Assert.Equal(result.DeviceId, ok.DeviceId);
            var blobOid = ok.ResultOid!;

            // Mac downloads the manifest, then every part, and verifies + decrypts
            var manifestKey = ObjectKeys.BlobManifest(blobOid);
            var manifestEnv = (await _mac.GetUpAsync(manifestKey))!;
            var manifest = Chunked.OpenManifest(_mac.Keys.SecretKey, manifestKey, manifestEnv);
            Assert.Equal(5, manifest.TotalChunks);
            var parts = new Dictionary<int, byte[]>();
            for (var i = 0; i < manifest.TotalChunks; i++) parts[i] = (await _mac.GetUpAsync(ObjectKeys.BlobChunk(blobOid, i)))!;
            var (_, plain) = Chunked.Decrypt(_mac.Keys.SecretKey, manifestKey, manifestEnv, parts);
            Assert.Equal(data, plain);

            // a repeat poll does not re-execute (the device cannot delete; PLAN decision 4)
            var before = (await _mac.ListUpAsync("up/cstat/")).Count;
            await agent.Poller!.PollOnceAsync();
            await agent.Uploader!.DrainAsync();
            Assert.Equal(before, (await _mac.ListUpAsync("up/cstat/")).Count);
        }
    }

    private sealed class CrashingUpClient : IUpBucketClient
    {
        private readonly IUpBucketClient _inner;
        private readonly CancellationTokenSource _crash;
        public CrashingUpClient(IUpBucketClient inner, CancellationTokenSource crash) { _inner = inner; _crash = crash; }
        public string Bucket => _inner.Bucket;
        public Task PutAsync(string key, Stream content, long length, CancellationToken ct = default) => _inner.PutAsync(key, content, length, ct);
        public Task<string> CreateMultipartAsync(string key, CancellationToken ct = default) => _inner.CreateMultipartAsync(key, ct);
        public Task<string> UploadPartAsync(string key, string uploadId, int partNumber, Stream content, long length, CancellationToken ct = default)
        {
            if (partNumber == 2) { _crash.Cancel(); ct.ThrowIfCancellationRequested(); }
            return _inner.UploadPartAsync(key, uploadId, partNumber, content, length, ct);
        }
        public Task CompleteMultipartAsync(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default) => _inner.CompleteMultipartAsync(key, uploadId, parts, ct);
        public Task AbortMultipartAsync(string key, string uploadId, CancellationToken ct = default) => _inner.AbortMultipartAsync(key, uploadId, ct);
    }

    [Fact]
    public async Task Multipart_upload_resumes_after_restart_against_mock()
    {
        var options = new UploaderOptions { MultipartThreshold = 6 * 1024 * 1024, PartSize = 5 * 1024 * 1024 };
        var endpoint = new R2Endpoint(_mock.S3Url);
        var key = ObjectKeys.BlobChunk(Oids.New(), 0);
        var data = new byte[12 * 1024 * 1024 + 123];
        Random.Shared.NextBytes(data);
        var dir = _dir.Sub("mp");

        using (var p = new AgentProcess(dir))
        {
            p.Queue.EnqueueCiphertext(key, Kind.BlobChunk, data);
            using var crash = new CancellationTokenSource();
            using var real = new S3UpBucketClient(endpoint, S3MockFixture.UpBucket, ScopedToken.Parse(S3MockFixture.UpToken));
            var uploader = new Uploader(p.Queue, new CrashingUpClient(real, crash), options, p.Activity, p.Db);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => uploader.DrainAsync(crash.Token));
        }
        Assert.Null(await _mac.GetUpAsync(key));

        using (var p = new AgentProcess(dir))
        {
            p.Queue.Reconcile();
            var item = p.Queue.All().Single();
            Assert.Equal(new[] { 1 }, p.Queue.GetCompletedParts(item.Id).Select(x => x.PartNumber));
            using var real = new S3UpBucketClient(endpoint, S3MockFixture.UpBucket, ScopedToken.Parse(S3MockFixture.UpToken));
            Assert.Equal(1, await new Uploader(p.Queue, real, options, p.Activity, p.Db).DrainAsync());
            Assert.Empty(p.Queue.All());
        }
        Assert.Equal(data, await _mac.GetUpAsync(key));
        var reqs = (await _mock.RequestsAsync()).Where(r => r.Key == key).ToList();
        Assert.Single(reqs, r => r.Operation == "CreateMultipartUpload");
        Assert.Equal(3, reqs.Count(r => r.Operation == "UploadPart" && r.Status == 200)); // part 1 once, then 2 and 3
        Assert.Single(reqs, r => r.Operation == "CompleteMultipartUpload" && r.Status == 200);
    }

    [Fact]
    public async Task Up_token_never_reads_and_cmd_token_never_writes()
    {
        await _mock.ClearRequestsAsync();
        var (agent, _, _) = await PairedAgentAsync("sep");
        await using (agent)
        {
            var file = _dir.Sub("x.bin");
            await File.WriteAllBytesAsync(file, new byte[200_000]);
            await MacSendsCommandAsync(agent.PairingState!, new FileRequestParams { Path = file });
            await MacSendsCommandAsync(agent.PairingState!, new RescanParams { Collector = "files" });
            await agent.SyncNowAsync();
            Assert.Equal(0, agent.Queue.Depth());
        }

        var reqs = await _mock.RequestsAsync();
        var up = reqs.Where(r => r.AccessKeyId == S3MockFixture.UpKeyId).ToList();
        var cmd = reqs.Where(r => r.AccessKeyId == S3MockFixture.CmdKeyId).ToList();
        Assert.NotEmpty(up);
        Assert.NotEmpty(cmd);
        var writeOps = new[] { "PutObject", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload" };
        var readOps = new[] { "ListObjectsV2", "GetObject", "HeadObject" };
        Assert.All(up, r =>
        {
            Assert.Contains(r.Operation, writeOps);
            Assert.Equal(S3MockFixture.UpBucket, r.Bucket);
            Assert.Equal(200, r.Status);
        });
        Assert.All(cmd, r =>
        {
            Assert.Contains(r.Operation, readOps);
            Assert.Equal(S3MockFixture.CmdBucket, r.Bucket);
            Assert.Equal(200, r.Status);
        });
        Assert.Contains(cmd, r => r.Operation == "ListObjectsV2");
        Assert.Contains(cmd, r => r.Operation == "GetObject" && r.Key!.StartsWith("pair/", StringComparison.Ordinal));
        Assert.Contains(up, r => r.Operation == "PutObject" && r.Key!.StartsWith("up/cstat/", StringComparison.Ordinal));
        // only the three expected identities ever talked to the mock
        Assert.All(reqs, r => Assert.Contains(r.AccessKeyId, new[] { S3MockFixture.UpKeyId, S3MockFixture.CmdKeyId, S3MockFixture.MacKeyId }));

        // and the policy is real: the cmd token cannot write, the up token cannot read
        using var cmdAsWriter = _mock.Client(S3MockFixture.CmdKeyId);
        var e1 = await Assert.ThrowsAsync<Amazon.S3.AmazonS3Exception>(() => cmdAsWriter.PutObjectAsync(new Amazon.S3.Model.PutObjectRequest
        { BucketName = S3MockFixture.CmdBucket, Key = "cmd/forged", InputStream = new MemoryStream(new byte[1]), UseChunkEncoding = false }));
        Assert.Equal(System.Net.HttpStatusCode.Forbidden, e1.StatusCode);
        using var upAsReader = _mock.Client(S3MockFixture.UpKeyId);
        var e2 = await Assert.ThrowsAsync<Amazon.S3.AmazonS3Exception>(() => upAsReader.ListObjectsV2Async(new Amazon.S3.Model.ListObjectsV2Request { BucketName = S3MockFixture.UpBucket }));
        Assert.Equal(System.Net.HttpStatusCode.Forbidden, e2.StatusCode);
    }

    [Fact]
    public async Task Bucket_and_local_state_hold_no_plaintext()
    {
        const string marker = "IVY-E2E-PLAINTEXT-MARKER-c0ffee42";
        var (agent, result, _) = await PairedAgentAsync("zp");
        await using (agent)
        {
            var now = IvyTime.Now();
            agent.Sink!.Enqueue(new WindowsNotificationRecord { DeviceId = result.DeviceId, EventTime = now, CaptureTime = now, App = marker, Title = marker, Text = marker, PostedAt = now }, "notifications");
            var file = _dir.Sub(marker + ".txt");
            await File.WriteAllTextAsync(file, string.Concat(Enumerable.Repeat(marker, 5000)));
            await MacSendsCommandAsync(agent.PairingState!, new FileRequestParams { Path = file });
            await agent.SyncNowAsync();
            Assert.Equal(0, agent.Queue.Depth());
            ZeroPlaintextTests.AssertNoMarker(_dir.Sub("zp"), marker);
        }
        ZeroPlaintextTests.AssertNoMarker(_mock.Root, marker);
        var notifs = await MacReadsAsync<WindowsNotificationRecord>("up/wnotif/", Kind.WindowsNotification);
        Assert.Contains(notifs, n => n.Record.Title == marker); // the Mac can read it; nobody else can
    }
}
