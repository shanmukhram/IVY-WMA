using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Ivy.Core.Tests.Support;

namespace Ivy.Core.Tests.Integration;

public sealed record MockRequest(string? AccessKeyId, string Operation, string? Bucket, string? Key, string Method, int Status);

/// <summary>
/// Starts @ivy/s3-mock as a child process via pnpm from the repo root, with a policy scoping the device
/// up token to write-only on ivy-up-windows and the cmd token to read-only on ivy-cmd-windows.
/// Kills the process tree on dispose.
/// </summary>
public sealed class S3MockFixture : IAsyncLifetime
{
    public const string UpBucket = "ivy-up-windows";
    public const string CmdBucket = "ivy-cmd-windows";
    public const string UpKeyId = "device-up-write";
    public const string CmdKeyId = "device-cmd-read";
    public const string MacKeyId = "mac-admin";
    public const string UpToken = UpKeyId + ":up-secret";
    public const string CmdToken = CmdKeyId + ":cmd-secret";

    private readonly TempDir _dir = new();
    private Process? _process;
    private readonly StringBuilder _log = new();
    private readonly HttpClient _http = new();

    public string S3Url { get; private set; } = "";
    public string AdminUrl { get; private set; } = "";
    public string Root => _dir.Sub("root");

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    public async Task InitializeAsync()
    {
        var policyPath = _dir.Sub("policy.json");
        File.WriteAllText(policyPath, JsonSerializer.Serialize(new Dictionary<string, object>
        {
            [UpKeyId] = new { bucket = UpBucket, operations = new[] { "PutObject", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload" } },
            [CmdKeyId] = new { bucket = CmdBucket, operations = new[] { "ListObjectsV2", "GetObject", "HeadObject" } },
            [MacKeyId] = new[]
            {
                new { bucket = UpBucket, operations = new[] { "ListObjectsV2", "GetObject", "HeadObject", "DeleteObject", "DeleteObjects" } },
                new { bucket = CmdBucket, operations = new[] { "PutObject", "DeleteObject", "ListObjectsV2" } },
            },
        }));
        var harness = Path.Combine(TestPaths.RepoRoot, "windows", "Ivy.Core.Tests", "Integration", "s3mock-harness.mjs");
        var port = FreePort();
        var psi = new ProcessStartInfo("pnpm")
        {
            WorkingDirectory = TestPaths.RepoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
        };
        foreach (var a in new[] { "--silent", "--filter", "@ivy/s3-mock", "exec", "node", harness, "--port", port.ToString(System.Globalization.CultureInfo.InvariantCulture),
                     "--root", Root, "--bucket", UpBucket, "--bucket", CmdBucket, "--policy", policyPath })
            psi.ArgumentList.Add(a);

        var ready = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        try { _process = Process.Start(psi) ?? throw new InvalidOperationException("pnpm did not start"); }
        catch (System.ComponentModel.Win32Exception e) { throw new InvalidOperationException("pnpm not found on PATH; install pnpm to run the s3-mock integration tests", e); }
        _process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            lock (_log) _log.AppendLine(e.Data);
            if (e.Data.StartsWith("IVY-S3-MOCK READY", StringComparison.Ordinal)) ready.TrySetResult(e.Data);
        };
        _process.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (_log) _log.AppendLine("ERR " + e.Data); };
        _process.Exited += (_, _) => ready.TrySetException(new InvalidOperationException("s3-mock exited early:\n" + Log));
        _process.EnableRaisingEvents = true;
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        var winner = await Task.WhenAny(ready.Task, Task.Delay(TimeSpan.FromSeconds(60)));
        if (winner != ready.Task) throw new TimeoutException("s3-mock did not become ready:\n" + Log);
        var line = await ready.Task;
        S3Url = line.Split(' ').Single(p => p.StartsWith("s3=", StringComparison.Ordinal))[3..];
        AdminUrl = line.Split(' ').Single(p => p.StartsWith("admin=", StringComparison.Ordinal))[6..];
        // readiness: the S3 port answers
        using var probe = await _http.GetAsync(S3Url + "/");
    }

    public string Log { get { lock (_log) return _log.ToString(); } }

    public async Task<List<MockRequest>> RequestsAsync()
    {
        var json = await _http.GetStringAsync(AdminUrl + "/requests");
        return JsonSerializer.Deserialize<List<MockRequest>>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    }

    public Task ClearRequestsAsync() => _http.PostAsync(AdminUrl + "/clear", null);

    /// <summary>An S3 client for an arbitrary access key (the Mac's, or an intruder's).</summary>
    public AmazonS3Client Client(string accessKeyId) => new(new BasicAWSCredentials(accessKeyId, "secret"), new AmazonS3Config
    {
        ServiceURL = S3Url, ForcePathStyle = true, AuthenticationRegion = "auto",
        RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED, ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
    });

    public async Task DisposeAsync()
    {
        if (_process is { HasExited: false })
        {
            try { _process.StandardInput.Close(); } catch (IOException) { }
            try { _process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)).ContinueWith(_ => { });
        }
        _process?.Dispose();
        _http.Dispose();
        _dir.Dispose();
    }
}

[CollectionDefinition(Name)]
public sealed class S3MockCollection : ICollectionFixture<S3MockFixture>
{
    public const string Name = "s3-mock";
}

/// <summary>The Mac side over the mock (read on up-bucket, write on cmd-bucket), using Ivy.Core primitives for crypto.</summary>
public sealed class MacOverMock
{
    private readonly S3MockFixture _mock;
    public MacOverMock(S3MockFixture mock) => _mock = mock;
    public MacSim Keys { get; } = new();

    public async Task PutCmdAsync(string key, byte[] body)
    {
        using var s3 = _mock.Client(S3MockFixture.MacKeyId);
        await s3.PutObjectAsync(new PutObjectRequest { BucketName = S3MockFixture.CmdBucket, Key = key, InputStream = new MemoryStream(body), UseChunkEncoding = false });
    }

    public async Task<byte[]?> GetUpAsync(string key)
    {
        using var s3 = _mock.Client(S3MockFixture.MacKeyId);
        try
        {
            using var r = await s3.GetObjectAsync(S3MockFixture.UpBucket, key);
            using var ms = new MemoryStream();
            await r.ResponseStream.CopyToAsync(ms);
            return ms.ToArray();
        }
        catch (AmazonS3Exception e) when (e.StatusCode == HttpStatusCode.NotFound) { return null; }
    }

    public async Task<List<string>> ListUpAsync(string prefix)
    {
        using var s3 = _mock.Client(S3MockFixture.MacKeyId);
        var keys = new List<string>();
        string? token = null;
        do
        {
            var r = await s3.ListObjectsV2Async(new ListObjectsV2Request { BucketName = S3MockFixture.UpBucket, Prefix = prefix, ContinuationToken = token });
            if (r.S3Objects is not null) keys.AddRange(r.S3Objects.Select(o => o.Key));
            token = r.IsTruncated == true ? r.NextContinuationToken : null;
        } while (token is not null);
        return keys;
    }
}
