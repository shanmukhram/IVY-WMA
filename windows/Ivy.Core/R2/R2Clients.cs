using System.Net;
using System.Net.Http;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;

namespace Ivy.Core.R2;

/// <summary>
/// A scoped R2 S3 credential. PROTOCOL.md carries each token as one opaque string
/// (<c>cmdReadToken</c>, <c>upWriteToken</c>); Ivy encodes it as <c>&lt;accessKeyId&gt;:&lt;secretAccessKey&gt;</c>
/// (an R2 API token's S3 credentials). See windows/README.md.
/// </summary>
public sealed class ScopedToken
{
    public ScopedToken(string accessKeyId, string secretAccessKey)
    {
        if (string.IsNullOrEmpty(accessKeyId) || string.IsNullOrEmpty(secretAccessKey)) throw new ArgumentException("token parts must be non-empty");
        AccessKeyId = accessKeyId;
        SecretAccessKey = secretAccessKey;
    }

    public string AccessKeyId { get; }
    internal string SecretAccessKey { get; }

    public static ScopedToken Parse(string token)
    {
        var i = token.IndexOf(':', StringComparison.Ordinal);
        if (i <= 0 || i == token.Length - 1) throw new FormatException("token must be '<accessKeyId>:<secretAccessKey>'");
        return new ScopedToken(token[..i], token[(i + 1)..]);
    }

    public override string ToString() => $"ScopedToken({AccessKeyId}:***)";
}

public sealed record R2Endpoint(string ServiceUrl, string Region = "auto");

/// <summary>
/// Per-call hard deadlines for R2 operations, enforced by Ivy independently of the AWS SDK's own
/// request timeout. These guarantee an operation returns (as a retryable failure) even when the
/// SDK's timeout does not reliably fire on a half-open or black-holed socket after a network change.
/// </summary>
public sealed record R2Timeouts
{
    /// <summary>Deadline for small control-plane calls (put, create/complete/abort multipart, list, get).</summary>
    public TimeSpan SmallOp { get; init; } = TimeSpan.FromSeconds(100);
    /// <summary>Deadline for a single part upload, which streams a multi-megabyte body.</summary>
    public TimeSpan PartUpload { get; init; } = TimeSpan.FromSeconds(180);
    /// <summary>TCP connect timeout for the underlying socket handler.</summary>
    public TimeSpan Connect { get; init; } = TimeSpan.FromSeconds(15);
}

public sealed class R2Exception : Exception
{
    public R2Exception(string message, HttpStatusCode? status, string? errorCode, Exception? inner = null) : base(message, inner)
    {
        StatusCode = status;
        ErrorCode = errorCode;
    }

    public HttpStatusCode? StatusCode { get; }
    public string? ErrorCode { get; }
    public bool IsNoSuchUpload => ErrorCode == "NoSuchUpload";
    public bool IsAccessDenied => StatusCode == HttpStatusCode.Forbidden;
    /// <summary>True when Ivy's own per-call deadline fired (see <see cref="R2Timeouts"/>).</summary>
    public bool IsTimeout => ErrorCode == "Timeout";
}

public sealed record UploadedPart(int PartNumber, string ETag);

/// <summary>
/// The device's up-bucket: WRITE operations only. There is deliberately no read, list or delete
/// member (PRD WU3; token separation is structural).
/// </summary>
public interface IUpBucketClient
{
    string Bucket { get; }
    Task PutAsync(string key, Stream content, long length, CancellationToken ct = default);
    Task<string> CreateMultipartAsync(string key, CancellationToken ct = default);
    Task<string> UploadPartAsync(string key, string uploadId, int partNumber, Stream content, long length, CancellationToken ct = default);
    Task CompleteMultipartAsync(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default);
    Task AbortMultipartAsync(string key, string uploadId, CancellationToken ct = default);
    /// <summary>
    /// Discard the current connection pool and build a fresh one, without restarting the process.
    /// Used by the uploader to heal after a network transition leaves pooled sockets wedged.
    /// The write-only scope and credentials are preserved.
    /// </summary>
    void ResetConnections();
}

/// <summary>The device's cmd-bucket: READ operations only (list + get). No write or delete member.</summary>
public interface ICmdBucketClient
{
    string Bucket { get; }
    /// <summary>All keys under <paramref name="prefix"/> in ascending order (pages internally).</summary>
    Task<IReadOnlyList<string>> ListKeysAsync(string prefix, string? startAfter = null, CancellationToken ct = default);
    /// <summary>Object bytes, or null if the key does not exist.</summary>
    Task<byte[]?> GetAsync(string key, CancellationToken ct = default);
}

/// <summary>Builds the two clients; each one receives exactly one token.</summary>
public interface IR2ClientFactory
{
    IUpBucketClient CreateUpClient(R2Endpoint endpoint, string bucket, ScopedToken writeToken);
    ICmdBucketClient CreateCmdClient(R2Endpoint endpoint, string bucket, ScopedToken readToken);
}

public sealed class S3R2ClientFactory : IR2ClientFactory
{
    private readonly R2Timeouts _timeouts;

    public S3R2ClientFactory(R2Timeouts? timeouts = null) => _timeouts = timeouts ?? new R2Timeouts();

    public IUpBucketClient CreateUpClient(R2Endpoint endpoint, string bucket, ScopedToken writeToken) => new S3UpBucketClient(endpoint, bucket, writeToken, _timeouts);
    public ICmdBucketClient CreateCmdClient(R2Endpoint endpoint, string bucket, ScopedToken readToken) => new S3CmdBucketClient(endpoint, bucket, readToken, _timeouts);
}

/// <summary>
/// Supplies the AWS SDK with an <see cref="HttpClient"/> over a <see cref="SocketsHttpHandler"/> that
/// recycles pooled connections on a short lifetime and sends TCP keep-alive pings, so a connection left
/// half-open by a network transition is torn down and replaced rather than reused forever. Each factory
/// instance owns exactly one handler/pool; building a new factory gives a brand new pool.
/// </summary>
internal sealed class PooledHttpClientFactory : Amazon.Runtime.HttpClientFactory, IDisposable
{
    private readonly HttpClient _http;

    public PooledHttpClientFactory(R2Timeouts timeouts)
    {
        var handler = new SocketsHttpHandler
        {
            // Retire pooled connections well before any infrastructure idle cut-off, so a stale socket is replaced.
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
            ConnectTimeout = timeouts.Connect,
            // Probe live connections; a black-holed socket fails its keep-alive ping and is dropped.
            KeepAlivePingDelay = TimeSpan.FromSeconds(30),
            KeepAlivePingTimeout = TimeSpan.FromSeconds(10),
            KeepAlivePingPolicy = HttpKeepAlivePingPolicy.Always,
        };
        // Deadlines are enforced per call via a linked CancellationToken, so the HttpClient itself must not
        // impose its default 100 s timeout (which would pre-empt the longer part-upload deadline).
        _http = new HttpClient(handler, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public override HttpClient CreateHttpClient(IClientConfig clientConfig) => _http;

    // Don't let the SDK cache or dispose our client; this factory owns its single HttpClient's lifetime.
    public override bool UseSDKHttpClientCaching(IClientConfig clientConfig) => false;
    public override bool DisposeHttpClientsAfterUse(IClientConfig clientConfig) => false;

    public void Dispose() => _http.Dispose();
}

internal static class S3Setup
{
    public static (AmazonS3Client Client, PooledHttpClientFactory Http) Create(R2Endpoint endpoint, ScopedToken token, R2Timeouts timeouts)
    {
        var http = new PooledHttpClientFactory(timeouts);
        var cfg = new AmazonS3Config
        {
            ServiceURL = endpoint.ServiceUrl,
            ForcePathStyle = true,
            AuthenticationRegion = endpoint.Region,
            // R2 and S3-compatible stores: send/validate flexible checksums only when an operation requires them.
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
            MaxErrorRetry = 2,
            // A backstop below the SDK's old 5 min; the authoritative cap is the per-call deadline in GuardAsync.
            Timeout = TimeSpan.FromSeconds(120),
            HttpClientFactory = http,
        };
        var client = new AmazonS3Client(new BasicAWSCredentials(token.AccessKeyId, token.SecretAccessKey), cfg);
        return (client, http);
    }

    /// <summary>
    /// Runs one R2 SDK call under a hard per-call deadline and maps its failures to <see cref="R2Exception"/>.
    /// A deadline hit (Ivy's own linked token, not the caller's) becomes a retryable R2Exception with a null
    /// status and ErrorCode "Timeout"; a cancellation requested by <paramref name="callerCt"/> is rethrown as
    /// <see cref="OperationCanceledException"/>. Internal so the timeout/classification logic can be unit tested.
    /// </summary>
    internal static async Task<T> GuardAsync<T>(TimeSpan timeout, CancellationToken callerCt, Func<CancellationToken, Task<T>> f)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(callerCt);
        cts.CancelAfter(timeout);
        try
        {
            return await f(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (callerCt.IsCancellationRequested)
        {
            throw; // the caller asked to stop; not a timeout.
        }
        catch (OperationCanceledException)
        {
            // Our deadline fired (or the SDK's own Timeout did): surface as a normal retryable failure.
            throw new R2Exception("R2 operation timed out", null, "Timeout");
        }
        catch (AmazonS3Exception e) { throw new R2Exception(e.Message, e.StatusCode, e.ErrorCode, e); }
        catch (AmazonServiceException e) { throw new R2Exception(e.Message, e.StatusCode, e.ErrorCode, e); }
    }
}

/// <summary>Up-bucket client constructed with ONLY the write token.</summary>
public sealed class S3UpBucketClient : IUpBucketClient, IDisposable
{
    private readonly R2Endpoint _endpoint;
    private readonly ScopedToken _writeToken;
    private readonly R2Timeouts _timeouts;
    private readonly object _gate = new();
    private AmazonS3Client _s3;
    private PooledHttpClientFactory _http;

    public S3UpBucketClient(R2Endpoint endpoint, string bucket, ScopedToken writeToken, R2Timeouts? timeouts = null)
    {
        Bucket = bucket;
        _endpoint = endpoint;
        _writeToken = writeToken;
        _timeouts = timeouts ?? new R2Timeouts();
        (_s3, _http) = S3Setup.Create(_endpoint, _writeToken, _timeouts);
    }

    public string Bucket { get; }

    private AmazonS3Client Current() { lock (_gate) return _s3; }

    public Task PutAsync(string key, Stream content, long length, CancellationToken ct = default)
    {
        var s3 = Current();
        return S3Setup.GuardAsync(_timeouts.SmallOp, ct, async token =>
        {
            var req = new PutObjectRequest
            {
                BucketName = Bucket, Key = key, InputStream = content, AutoCloseStream = false, AutoResetStreamPosition = false,
                ContentType = "application/octet-stream", UseChunkEncoding = false,
            };
            req.Headers.ContentLength = length;
            await s3.PutObjectAsync(req, token).ConfigureAwait(false);
            return 0;
        });
    }

    public Task<string> CreateMultipartAsync(string key, CancellationToken ct = default)
    {
        var s3 = Current();
        return S3Setup.GuardAsync(_timeouts.SmallOp, ct, async token =>
            (await s3.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest
            {
                BucketName = Bucket, Key = key, ContentType = "application/octet-stream",
            }, token).ConfigureAwait(false)).UploadId);
    }

    public Task<string> UploadPartAsync(string key, string uploadId, int partNumber, Stream content, long length, CancellationToken ct = default)
    {
        var s3 = Current();
        return S3Setup.GuardAsync(_timeouts.PartUpload, ct, async token =>
        {
            var r = await s3.UploadPartAsync(new UploadPartRequest
            {
                BucketName = Bucket, Key = key, UploadId = uploadId, PartNumber = partNumber, InputStream = content, PartSize = length,
                UseChunkEncoding = false,
            }, token).ConfigureAwait(false);
            return r.ETag;
        });
    }

    public Task CompleteMultipartAsync(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default)
    {
        var s3 = Current();
        return S3Setup.GuardAsync(_timeouts.SmallOp, ct, async token =>
        {
            await s3.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest
            {
                BucketName = Bucket, Key = key, UploadId = uploadId,
                PartETags = parts.OrderBy(p => p.PartNumber).Select(p => new PartETag(p.PartNumber, p.ETag)).ToList(),
            }, token).ConfigureAwait(false);
            return 0;
        });
    }

    public Task AbortMultipartAsync(string key, string uploadId, CancellationToken ct = default)
    {
        var s3 = Current();
        return S3Setup.GuardAsync(_timeouts.SmallOp, ct, async token =>
        {
            await s3.AbortMultipartUploadAsync(new AbortMultipartUploadRequest { BucketName = Bucket, Key = key, UploadId = uploadId }, token).ConfigureAwait(false);
            return 0;
        });
    }

    public void ResetConnections()
    {
        // Build the fresh pool outside the lock, then swap and dispose the old one. The rebuild uses the
        // same endpoint/bucket and the same write token, so the write-only scope is preserved. The token
        // is never logged or exposed here.
        var (fresh, freshHttp) = S3Setup.Create(_endpoint, _writeToken, _timeouts);
        AmazonS3Client oldClient;
        PooledHttpClientFactory oldHttp;
        lock (_gate)
        {
            oldClient = _s3;
            oldHttp = _http;
            _s3 = fresh;
            _http = freshHttp;
        }
        oldClient.Dispose();
        oldHttp.Dispose();
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _s3.Dispose();
            _http.Dispose();
        }
    }
}

/// <summary>Cmd-bucket client constructed with ONLY the read token.</summary>
public sealed class S3CmdBucketClient : ICmdBucketClient, IDisposable
{
    private readonly R2Timeouts _timeouts;
    private readonly AmazonS3Client _s3;
    private readonly PooledHttpClientFactory _http;

    public S3CmdBucketClient(R2Endpoint endpoint, string bucket, ScopedToken readToken, R2Timeouts? timeouts = null)
    {
        Bucket = bucket;
        _timeouts = timeouts ?? new R2Timeouts();
        (_s3, _http) = S3Setup.Create(endpoint, readToken, _timeouts);
    }

    public string Bucket { get; }

    public async Task<IReadOnlyList<string>> ListKeysAsync(string prefix, string? startAfter = null, CancellationToken ct = default)
    {
        var keys = new List<string>();
        string? token = null;
        do
        {
            var pageToken = token;
            // One deadline per page, so each network round trip is independently bounded.
            var page = await S3Setup.GuardAsync(_timeouts.SmallOp, ct, async linked =>
            {
                var req = new ListObjectsV2Request { BucketName = Bucket, Prefix = prefix, ContinuationToken = pageToken };
                if (pageToken is null && startAfter is not null) req.StartAfter = startAfter;
                return await _s3.ListObjectsV2Async(req, linked).ConfigureAwait(false);
            }).ConfigureAwait(false);
            if (page.S3Objects is not null) keys.AddRange(page.S3Objects.Select(o => o.Key));
            token = page.IsTruncated == true ? page.NextContinuationToken : null;
        } while (token is not null);
        keys.Sort(StringComparer.Ordinal);
        return keys;
    }

    public async Task<byte[]?> GetAsync(string key, CancellationToken ct = default)
    {
        try
        {
            return await S3Setup.GuardAsync(_timeouts.SmallOp, ct, async token =>
            {
                using var r = await _s3.GetObjectAsync(new GetObjectRequest { BucketName = Bucket, Key = key }, token).ConfigureAwait(false);
                using var ms = new MemoryStream();
                await r.ResponseStream.CopyToAsync(ms, token).ConfigureAwait(false);
                return ms.ToArray();
            }).ConfigureAwait(false);
        }
        catch (R2Exception e) when (e.StatusCode == HttpStatusCode.NotFound || e.ErrorCode == "NoSuchKey")
        {
            return null;
        }
    }

    public void Dispose()
    {
        _s3.Dispose();
        _http.Dispose();
    }
}
