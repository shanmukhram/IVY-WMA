using System.Net;
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
    public IUpBucketClient CreateUpClient(R2Endpoint endpoint, string bucket, ScopedToken writeToken) => new S3UpBucketClient(endpoint, bucket, writeToken);
    public ICmdBucketClient CreateCmdClient(R2Endpoint endpoint, string bucket, ScopedToken readToken) => new S3CmdBucketClient(endpoint, bucket, readToken);
}

internal static class S3Setup
{
    public static AmazonS3Client Create(R2Endpoint endpoint, ScopedToken token)
    {
        var cfg = new AmazonS3Config
        {
            ServiceURL = endpoint.ServiceUrl,
            ForcePathStyle = true,
            AuthenticationRegion = endpoint.Region,
            // R2 and S3-compatible stores: send/validate flexible checksums only when an operation requires them.
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
            MaxErrorRetry = 2,
            Timeout = TimeSpan.FromMinutes(5),
        };
        return new AmazonS3Client(new BasicAWSCredentials(token.AccessKeyId, token.SecretAccessKey), cfg);
    }

    public static async Task<T> Wrap<T>(Func<Task<T>> f)
    {
        try { return await f().ConfigureAwait(false); }
        catch (AmazonS3Exception e) { throw new R2Exception(e.Message, e.StatusCode, e.ErrorCode, e); }
        catch (AmazonServiceException e) { throw new R2Exception(e.Message, e.StatusCode, e.ErrorCode, e); }
    }
}

/// <summary>Up-bucket client constructed with ONLY the write token.</summary>
public sealed class S3UpBucketClient : IUpBucketClient, IDisposable
{
    private readonly AmazonS3Client _s3;

    public S3UpBucketClient(R2Endpoint endpoint, string bucket, ScopedToken writeToken)
    {
        Bucket = bucket;
        _s3 = S3Setup.Create(endpoint, writeToken);
    }

    public string Bucket { get; }

    public Task PutAsync(string key, Stream content, long length, CancellationToken ct = default) => S3Setup.Wrap(async () =>
    {
        var req = new PutObjectRequest
        {
            BucketName = Bucket, Key = key, InputStream = content, AutoCloseStream = false, AutoResetStreamPosition = false,
            ContentType = "application/octet-stream", UseChunkEncoding = false,
        };
        req.Headers.ContentLength = length;
        await _s3.PutObjectAsync(req, ct).ConfigureAwait(false);
        return 0;
    });

    public Task<string> CreateMultipartAsync(string key, CancellationToken ct = default) => S3Setup.Wrap(async () =>
        (await _s3.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest
        {
            BucketName = Bucket, Key = key, ContentType = "application/octet-stream",
        }, ct).ConfigureAwait(false)).UploadId);

    public Task<string> UploadPartAsync(string key, string uploadId, int partNumber, Stream content, long length, CancellationToken ct = default) => S3Setup.Wrap(async () =>
    {
        var r = await _s3.UploadPartAsync(new UploadPartRequest
        {
            BucketName = Bucket, Key = key, UploadId = uploadId, PartNumber = partNumber, InputStream = content, PartSize = length,
            UseChunkEncoding = false,
        }, ct).ConfigureAwait(false);
        return r.ETag;
    });

    public Task CompleteMultipartAsync(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default) => S3Setup.Wrap(async () =>
    {
        await _s3.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest
        {
            BucketName = Bucket, Key = key, UploadId = uploadId,
            PartETags = parts.OrderBy(p => p.PartNumber).Select(p => new PartETag(p.PartNumber, p.ETag)).ToList(),
        }, ct).ConfigureAwait(false);
        return 0;
    });

    public Task AbortMultipartAsync(string key, string uploadId, CancellationToken ct = default) => S3Setup.Wrap(async () =>
    {
        await _s3.AbortMultipartUploadAsync(new AbortMultipartUploadRequest { BucketName = Bucket, Key = key, UploadId = uploadId }, ct).ConfigureAwait(false);
        return 0;
    });

    public void Dispose() => _s3.Dispose();
}

/// <summary>Cmd-bucket client constructed with ONLY the read token.</summary>
public sealed class S3CmdBucketClient : ICmdBucketClient, IDisposable
{
    private readonly AmazonS3Client _s3;

    public S3CmdBucketClient(R2Endpoint endpoint, string bucket, ScopedToken readToken)
    {
        Bucket = bucket;
        _s3 = S3Setup.Create(endpoint, readToken);
    }

    public string Bucket { get; }

    public Task<IReadOnlyList<string>> ListKeysAsync(string prefix, string? startAfter = null, CancellationToken ct = default) => S3Setup.Wrap(async () =>
    {
        var keys = new List<string>();
        string? token = null;
        do
        {
            var req = new ListObjectsV2Request { BucketName = Bucket, Prefix = prefix, ContinuationToken = token };
            if (token is null && startAfter is not null) req.StartAfter = startAfter;
            var r = await _s3.ListObjectsV2Async(req, ct).ConfigureAwait(false);
            if (r.S3Objects is not null) keys.AddRange(r.S3Objects.Select(o => o.Key));
            token = r.IsTruncated == true ? r.NextContinuationToken : null;
        } while (token is not null);
        keys.Sort(StringComparer.Ordinal);
        return (IReadOnlyList<string>)keys;
    });

    public async Task<byte[]?> GetAsync(string key, CancellationToken ct = default)
    {
        try
        {
            return await S3Setup.Wrap(async () =>
            {
                using var r = await _s3.GetObjectAsync(new GetObjectRequest { BucketName = Bucket, Key = key }, ct).ConfigureAwait(false);
                using var ms = new MemoryStream();
                await r.ResponseStream.CopyToAsync(ms, ct).ConfigureAwait(false);
                return ms.ToArray();
            }).ConfigureAwait(false);
        }
        catch (R2Exception e) when (e.StatusCode == HttpStatusCode.NotFound || e.ErrorCode == "NoSuchKey")
        {
            return null;
        }
    }

    public void Dispose() => _s3.Dispose();
}
