using System.Net;
using Amazon.Runtime;
using Amazon.S3;
using Ivy.Core.R2;

namespace Ivy.Core.Tests;

/// <summary>
/// Unit tests for the per-call timeout and failure classification in <see cref="S3Setup.GuardAsync"/>.
/// These do not touch the network; they drive the helper directly with controllable delegates.
/// </summary>
public sealed class R2ClientsTests
{
    [Fact]
    public async Task GuardAsync_passes_result_through_on_success()
    {
        var result = await S3Setup.GuardAsync(TimeSpan.FromSeconds(5), CancellationToken.None, _ => Task.FromResult(42));
        Assert.Equal(42, result);
    }

    [Fact]
    public async Task GuardAsync_deadline_fires_throws_R2Exception_Timeout()
    {
        // The delegate never completes; only the per-call deadline can end it.
        var ex = await Assert.ThrowsAsync<R2Exception>(() =>
            S3Setup.GuardAsync<int>(TimeSpan.FromMilliseconds(20), CancellationToken.None,
                async token => { await Task.Delay(Timeout.Infinite, token); return 0; }));

        Assert.Equal("Timeout", ex.ErrorCode);
        Assert.Null(ex.StatusCode);
        Assert.True(ex.IsTimeout);
    }

    [Fact]
    public async Task GuardAsync_caller_cancellation_rethrows_OperationCanceled()
    {
        using var caller = new CancellationTokenSource();
        caller.Cancel();

        var ex = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            S3Setup.GuardAsync<int>(TimeSpan.FromSeconds(30), caller.Token,
                async token => { await Task.Delay(Timeout.Infinite, token); return 0; }));

        // Caller cancellation must not be disguised as a retryable timeout.
        Assert.IsNotType<R2Exception>(ex);
    }

    [Fact]
    public async Task GuardAsync_maps_AmazonS3Exception_to_R2Exception()
    {
        var ex = await Assert.ThrowsAsync<R2Exception>(() =>
            S3Setup.GuardAsync<int>(TimeSpan.FromSeconds(5), CancellationToken.None,
                _ => throw new AmazonS3Exception("denied", ErrorType.Sender, "AccessDenied", "req-1", HttpStatusCode.Forbidden)));

        Assert.Equal("AccessDenied", ex.ErrorCode);
        Assert.Equal(HttpStatusCode.Forbidden, ex.StatusCode);
        Assert.True(ex.IsAccessDenied);
    }

    [Fact]
    public async Task GuardAsync_maps_AmazonServiceException_to_R2Exception()
    {
        var ex = await Assert.ThrowsAsync<R2Exception>(() =>
            S3Setup.GuardAsync<int>(TimeSpan.FromSeconds(5), CancellationToken.None,
                _ => throw new AmazonServiceException("boom") { ErrorCode = "SlowDown", StatusCode = HttpStatusCode.ServiceUnavailable }));

        Assert.Equal("SlowDown", ex.ErrorCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, ex.StatusCode);
    }
}
