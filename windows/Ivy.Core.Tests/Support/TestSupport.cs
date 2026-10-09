using System.Collections.Concurrent;
using System.Reflection;
using Ivy.Core.Protocol;
using Ivy.Core.R2;

namespace Ivy.Core.Tests.Support;

public static class TestPaths
{
    private static string Meta(string key) =>
        typeof(TestPaths).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().Single(a => a.Key == key).Value!;

    public static string RepoRoot => Meta("IvyRepoRoot");
    public static string VectorsDir => Meta("IvyTestVectorsDir");
    public static string Vector(string name) => Path.Combine(VectorsDir, name);
}

/// <summary>A temp directory deleted on dispose.</summary>
public sealed class TempDir : IDisposable
{
    public TempDir()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ivy-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path);
    }

    public string Path { get; }
    public string Sub(string name) => System.IO.Path.Combine(Path, name);

    public void Dispose()
    {
        try { Directory.Delete(Path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

/// <summary>The Mac side of the protocol, simulated with Ivy.Core's own primitives.</summary>
public sealed class MacSim
{
    public MacSim()
    {
        (SecretKey, PublicKey) = X25519.GenerateKeyPair();
    }

    public byte[] SecretKey { get; }
    public byte[] PublicKey { get; }
    public string PublicKeyB64 => Bytes.ToBase64(PublicKey);
    public string Fingerprint => Protocol.Fingerprint.Of(PublicKey);

    public byte[] Open(string key, byte[] envelope, Kind kind) => Envelope.Decrypt(SecretKey, key, envelope, kind).Plaintext;
}

/// <summary>In-memory S3 "server" shared by the fake clients; records every call.</summary>
public sealed class FakeBucketServer
{
    public ConcurrentDictionary<string, byte[]> Up { get; } = new();
    public ConcurrentDictionary<string, byte[]> Cmd { get; } = new();
    public ConcurrentDictionary<string, ConcurrentDictionary<int, byte[]>> Uploads { get; } = new();
    public ConcurrentQueue<string> Calls { get; } = new();
    private int _uploadCounter;

    public string NewUploadId() => "u" + Interlocked.Increment(ref _uploadCounter);
}

public sealed class FakeUpClient : IUpBucketClient
{
    private readonly FakeBucketServer _server;
    public FakeUpClient(FakeBucketServer server) => _server = server;
    public string Bucket => "ivy-up-windows";

    /// <summary>Hook invoked before each UploadPart (partNumber, ct); may throw to simulate a crash/failure.</summary>
    public Action<int, CancellationToken>? BeforeUploadPart { get; set; }
    /// <summary>Hook invoked before each Put; may throw.</summary>
    public Action<string>? BeforePut { get; set; }

    private static async Task<byte[]> ReadAll(Stream s, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        await s.CopyToAsync(ms, ct);
        return ms.ToArray();
    }

    public async Task PutAsync(string key, Stream content, long length, CancellationToken ct = default)
    {
        BeforePut?.Invoke(key);
        var b = await ReadAll(content, ct);
        Assert.Equal(length, b.Length);
        _server.Up[key] = b;
        _server.Calls.Enqueue($"put {key}");
    }

    public Task<string> CreateMultipartAsync(string key, CancellationToken ct = default)
    {
        var id = _server.NewUploadId();
        _server.Uploads[id] = new ConcurrentDictionary<int, byte[]>();
        _server.Calls.Enqueue($"create {key} {id}");
        return Task.FromResult(id);
    }

    public async Task<string> UploadPartAsync(string key, string uploadId, int partNumber, Stream content, long length, CancellationToken ct = default)
    {
        BeforeUploadPart?.Invoke(partNumber, ct);
        ct.ThrowIfCancellationRequested();
        var b = await ReadAll(content, ct);
        Assert.Equal(length, b.Length);
        if (!_server.Uploads.TryGetValue(uploadId, out var parts)) throw new R2Exception("no such upload", System.Net.HttpStatusCode.NotFound, "NoSuchUpload");
        parts[partNumber] = b;
        _server.Calls.Enqueue($"part {key} {uploadId} {partNumber}");
        return "etag-" + partNumber + "-" + Bytes.ToHex(Bytes.Sha256(b))[..8];
    }

    public Task CompleteMultipartAsync(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default)
    {
        var stored = _server.Uploads[uploadId];
        using var ms = new MemoryStream();
        foreach (var p in parts.OrderBy(p => p.PartNumber))
        {
            var b = stored[p.PartNumber];
            Assert.Equal("etag-" + p.PartNumber + "-" + Bytes.ToHex(Bytes.Sha256(b))[..8], p.ETag);
            ms.Write(b);
        }
        _server.Up[key] = ms.ToArray();
        _server.Uploads.TryRemove(uploadId, out _);
        _server.Calls.Enqueue($"complete {key} {uploadId} {parts.Count}");
        return Task.CompletedTask;
    }

    public Task AbortMultipartAsync(string key, string uploadId, CancellationToken ct = default)
    {
        _server.Uploads.TryRemove(uploadId, out _);
        return Task.CompletedTask;
    }
}

public sealed class FakeCmdClient : ICmdBucketClient
{
    private readonly FakeBucketServer _server;
    public FakeCmdClient(FakeBucketServer server) => _server = server;
    public string Bucket => "ivy-cmd-windows";
    public int Gets { get; private set; }

    public Task<IReadOnlyList<string>> ListKeysAsync(string prefix, string? startAfter = null, CancellationToken ct = default) =>
        Task.FromResult((IReadOnlyList<string>)_server.Cmd.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).OrderBy(k => k, StringComparer.Ordinal).ToList());

    public Task<byte[]?> GetAsync(string key, CancellationToken ct = default)
    {
        Gets++;
        return Task.FromResult(_server.Cmd.TryGetValue(key, out var b) ? b : null);
    }
}

public sealed class FakeR2Factory : IR2ClientFactory
{
    public FakeR2Factory(FakeBucketServer server) => Server = server;
    public FakeBucketServer Server { get; }
    public List<(string Kind, string Bucket, string AccessKeyId)> Created { get; } = new();

    public IUpBucketClient CreateUpClient(R2Endpoint endpoint, string bucket, ScopedToken writeToken)
    {
        Created.Add(("up", bucket, writeToken.AccessKeyId));
        return new FakeUpClient(Server);
    }

    public ICmdBucketClient CreateCmdClient(R2Endpoint endpoint, string bucket, ScopedToken readToken)
    {
        Created.Add(("cmd", bucket, readToken.AccessKeyId));
        return new FakeCmdClient(Server);
    }
}
