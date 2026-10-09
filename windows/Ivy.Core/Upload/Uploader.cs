using Ivy.Core.R2;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Core.Upload;

public sealed class UploaderOptions
{
    /// <summary>Objects larger than this use S3 multipart upload (resumable).</summary>
    public long MultipartThreshold { get; init; } = 16L * 1024 * 1024;
    /// <summary>S3 part size for multipart (≥ 5 MiB except the last part).</summary>
    public long PartSize { get; init; } = 8L * 1024 * 1024;
    /// <summary>Initial bandwidth cap in bytes/second; 0 = unlimited.</summary>
    public long BandwidthBytesPerSecond { get; init; }
    /// <summary>Idle re-check interval for <see cref="Uploader.RunAsync"/>.</summary>
    public TimeSpan IdlePoll { get; init; } = TimeSpan.FromSeconds(30);
}

public enum UploadPhase { Started, Progress, Completed, Failed }

/// <summary>Per-object progress for the UI.</summary>
public sealed record UploadProgress(string ObjectKey, string? Collector, long BytesSent, long TotalBytes, UploadPhase Phase, string? Error = null);

/// <summary>
/// Drains the <see cref="UploadQueue"/> in order into the up-bucket, honoring a pause flag and a
/// token-bucket bandwidth cap. Large objects use resumable multipart: the upload id and every
/// completed part's ETag are persisted so a restarted process continues after the last completed part.
/// </summary>
public sealed class Uploader
{
    private const string PausedSetting = "uploader.paused";
    private const string BandwidthSetting = "uploader.bandwidth";
    private readonly UploadQueue _queue;
    private readonly IUpBucketClient _client;
    private readonly UploaderOptions _options;
    private readonly ActivityLog? _activity;
    private readonly VaultDb? _settingsDb;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly TokenBucket _bucket;
    private readonly SemaphoreSlim _wake = new(0);
    private readonly SemaphoreSlim _drainLock = new(1, 1);
    private volatile bool _paused;

    public Uploader(UploadQueue queue, IUpBucketClient client, UploaderOptions? options = null, ActivityLog? activity = null,
        VaultDb? settingsDb = null, TimeProvider? time = null, ILogger<Uploader>? logger = null)
    {
        _queue = queue;
        _client = client;
        _options = options ?? new UploaderOptions();
        if (_options.PartSize < 5L * 1024 * 1024) throw new ArgumentException("PartSize must be at least 5 MiB", nameof(options));
        _activity = activity;
        _settingsDb = settingsDb;
        _time = time ?? TimeProvider.System;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
        var bw = _options.BandwidthBytesPerSecond;
        if (settingsDb?.GetSetting(BandwidthSetting) is { } s && long.TryParse(s, out var saved)) bw = saved;
        _bucket = new TokenBucket(bw, _time);
        _paused = settingsDb?.GetSetting(PausedSetting) == "1";
        _queue.Enqueued += (_, _) => Nudge();
    }

    public event EventHandler<UploadProgress>? Progress;

    /// <summary>Pause/resume uploads (persisted). An in-flight object finishes its current part, then stops.</summary>
    public bool Paused
    {
        get => _paused;
        set
        {
            if (_paused == value) return;
            _paused = value;
            _settingsDb?.SetSetting(PausedSetting, value ? "1" : "0");
            _activity?.Append(null, value ? ActivityEvents.Paused : ActivityEvents.Resumed);
            if (!value) Nudge();
        }
    }

    /// <summary>Bandwidth cap in bytes/second (0 = unlimited), persisted.</summary>
    public long BandwidthBytesPerSecond
    {
        get => _bucket.Rate;
        set
        {
            _bucket.Rate = value;
            _settingsDb?.SetSetting(BandwidthSetting, value.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    /// <summary>Wake the run loop (new items, "Sync now").</summary>
    public void Nudge()
    {
        if (_wake.CurrentCount == 0) _wake.Release();
    }

    /// <summary>Upload every item that is currently due, in order. Returns the number uploaded.</summary>
    public async Task<int> DrainAsync(CancellationToken ct = default)
    {
        await _drainLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var done = 0;
            var failed = new HashSet<string>(StringComparer.Ordinal);
            while (!_paused && !ct.IsCancellationRequested)
            {
                var item = _queue.NextDue();
                if (item is null || failed.Contains(item.Id)) break;
                if (await UploadOneAsync(item, ct).ConfigureAwait(false)) done++;
                else failed.Add(item.Id);
            }
            return done;
        }
        finally
        {
            _drainLock.Release();
        }
    }

    /// <summary>Background loop: drain, then sleep until nudged, the next backoff gate, or the idle poll.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await DrainAsync(ct).ConfigureAwait(false); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception e) { _logger.LogError(e, "uploader drain failed"); }

            var wait = _options.IdlePoll;
            if (!_paused && _queue.NextAttemptTime() is { } next)
            {
                var until = next - _time.GetUtcNow();
                if (until < wait) wait = until < TimeSpan.FromMilliseconds(50) ? TimeSpan.FromMilliseconds(50) : until;
            }
            try { await _wake.WaitAsync(wait, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    private void Emit(UploadProgress p)
    {
        try { Progress?.Invoke(this, p); }
        catch (Exception e) { _logger.LogWarning(e, "progress handler threw"); }
    }

    private async Task<bool> UploadOneAsync(QueueItem item, CancellationToken ct)
    {
        var path = _queue.FullPathOf(item);
        _queue.MarkUploading(item.Id);
        Emit(new UploadProgress(item.ObjectKey, item.Collector, 0, item.Size, UploadPhase.Started));
        try
        {
            if (!File.Exists(path))
            {
                // Reconcile handles this at startup; at runtime treat as lost rather than spin.
                _queue.Complete(item.Id);
                _activity?.Append(item.Collector, ActivityEvents.Lost, $"{item.ObjectKey} part file missing");
                return false;
            }
            if (item.Size > _options.MultipartThreshold) await UploadMultipartAsync(item, path, ct).ConfigureAwait(false);
            else await UploadSingleAsync(item, path, ct).ConfigureAwait(false);

            _queue.Complete(item.Id);
            _activity?.Append(item.Collector, ActivityEvents.Uploaded, $"{item.ObjectKey} {item.Size} bytes");
            Emit(new UploadProgress(item.ObjectKey, item.Collector, item.Size, item.Size, UploadPhase.Completed));
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _queue.Requeue(item.Id);
            throw;
        }
        catch (PausedException)
        {
            _queue.Requeue(item.Id);
            return false;
        }
        catch (Exception e)
        {
            var delay = _queue.MarkFailed(item.Id, e.Message);
            _logger.LogWarning("upload of {ObjectKey} failed (retry in {Delay}): {Error}", item.ObjectKey, delay, e.Message);
            _activity?.Append(item.Collector, ActivityEvents.UploadFailed, $"{item.ObjectKey} attempt {item.Attempts + 1}: {Trim(e.Message)}");
            Emit(new UploadProgress(item.ObjectKey, item.Collector, 0, item.Size, UploadPhase.Failed, e.Message));
            return false;
        }
    }

    private static string Trim(string s) => s.Length > 200 ? s[..200] : s;

    private sealed class PausedException : Exception { }

    private async Task UploadSingleAsync(QueueItem item, string path, CancellationToken ct)
    {
        var bytes = await File.ReadAllBytesAsync(path, ct).ConfigureAwait(false);
        await using var s = new ThrottledBufferStream(bytes, _bucket,
            sent => Emit(new UploadProgress(item.ObjectKey, item.Collector, sent, item.Size, UploadPhase.Progress)));
        await _client.PutAsync(item.ObjectKey, s, bytes.Length, ct).ConfigureAwait(false);
    }

    private async Task UploadMultipartAsync(QueueItem item, string path, CancellationToken ct)
    {
        var uploadId = item.UploadId;
        var partSize = item.PartSize ?? _options.PartSize;
        if (uploadId is null)
        {
            uploadId = await _client.CreateMultipartAsync(item.ObjectKey, ct).ConfigureAwait(false);
            _queue.SetMultipartUpload(item.Id, uploadId, partSize);
        }

        var completed = _queue.GetCompletedParts(item.Id).ToDictionary(p => p.PartNumber);
        var totalParts = (int)((item.Size + partSize - 1) / partSize);
        long sentBase = completed.Values.Sum(p => p.Size);
        try
        {
            await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, useAsync: true);
            for (var n = 1; n <= totalParts; n++)
            {
                if (completed.ContainsKey(n)) continue;
                if (_paused) throw new PausedException();
                var offset = (n - 1) * partSize;
                var len = (int)Math.Min(partSize, item.Size - offset);
                var buf = new byte[len];
                fs.Seek(offset, SeekOrigin.Begin);
                await fs.ReadExactlyAsync(buf, ct).ConfigureAwait(false);
                var baseSent = sentBase;
                await using var s = new ThrottledBufferStream(buf, _bucket,
                    sent => Emit(new UploadProgress(item.ObjectKey, item.Collector, baseSent + sent, item.Size, UploadPhase.Progress)));
                var etag = await _client.UploadPartAsync(item.ObjectKey, uploadId, n, s, len, ct).ConfigureAwait(false);
                _queue.AddCompletedPart(item.Id, n, etag, len);
                completed[n] = new CompletedPart(n, etag, len);
                sentBase += len;
            }
            await _client.CompleteMultipartAsync(item.ObjectKey, uploadId,
                completed.Values.OrderBy(p => p.PartNumber).Select(p => new UploadedPart(p.PartNumber, p.ETag)).ToList(), ct).ConfigureAwait(false);
        }
        catch (R2Exception e) when (e.IsNoSuchUpload)
        {
            // The server forgot the upload (expired/aborted): restart from scratch next attempt.
            _queue.ResetMultipart(item.Id);
            throw;
        }
    }
}
