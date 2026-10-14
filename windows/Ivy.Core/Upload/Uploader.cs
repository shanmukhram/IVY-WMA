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
    /// <summary>
    /// How many objects upload at once. Uploads are latency-bound (many small records and blobs), so several
    /// in flight make the whole queue drain in a fraction of the time — the point being that a few minutes
    /// after the PC comes on, the Mac already has everything. A shared token bucket still caps total bandwidth.
    /// </summary>
    public int Concurrency { get; init; } = 16;
    /// <summary>Idle re-check interval for <see cref="Uploader.RunAsync"/>.</summary>
    public TimeSpan IdlePoll { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How many consecutive failed uploads across a drain before the uploader rebuilds the R2 connection pool
    /// once (<see cref="IUpBucketClient.ResetConnections"/>). A single R2 timeout rebuilds immediately regardless.
    /// The rebuild happens at most once per bad streak and the streak clears on the next success. 0 disables the
    /// count-based rebuild (a timeout still rebuilds).
    /// </summary>
    public int ResetAfterConsecutiveFailures { get; init; } = 3;

    /// <summary>
    /// The liveness watchdog rebuilds connections and nudges the drain when there is work due but no upload has
    /// completed or failed for at least this long. The default is comfortably longer than the 180 s part-upload
    /// deadline, so a slow-but-progressing drain is never disturbed.
    /// </summary>
    public TimeSpan StallWindow { get; init; } = TimeSpan.FromMinutes(3);

    /// <summary>How often the liveness watchdog checks for a stalled drain.</summary>
    public TimeSpan WatchdogInterval { get; init; } = TimeSpan.FromSeconds(30);
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
    private const string ConcurrencySetting = "uploader.concurrency";
    private readonly int _concurrency;
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

    // --- liveness / health state: written by the drain workers and the watchdog, read by the UI ---
    // Timestamps are kept as UTC ticks (0 = "never") so they can be read and written with Interlocked.
    private long _lastSuccessAtTicks;
    private long _lastErrorAtTicks;
    private long _lastProgressAtTicks;   // updated whenever an item completes OR fails (forward progress)
    private volatile string? _lastError;
    private int _consecutiveFailures;
    private int _resetDoneThisStreak;    // 0/1 guard so one bad streak rebuilds the pool at most once

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
        // how many objects upload at once; tunable at runtime via the uploader.concurrency setting, clamped to a sane range
        var conc = _options.Concurrency;
        if (settingsDb?.GetSetting(ConcurrencySetting) is { } cs && int.TryParse(cs, out var savedConc)) conc = savedConc;
        _concurrency = Math.Clamp(conc, 1, 64);
        _paused = settingsDb?.GetSetting(PausedSetting) == "1";
        _lastProgressAtTicks = _time.GetUtcNow().UtcTicks; // the drain starts "fresh", so the watchdog waits a full window
        _queue.Enqueued += (_, _) => Nudge();
    }

    public event EventHandler<UploadProgress>? Progress;

    /// <summary>When the last object uploaded successfully (null until the first success). For the UI.</summary>
    public DateTimeOffset? LastSuccessfulUploadAt => TicksToOffset(Interlocked.Read(ref _lastSuccessAtTicks));

    /// <summary>The most recent failed-attempt error (trimmed, no secrets), or null. For the UI.</summary>
    public string? LastError => _lastError;

    /// <summary>When the most recent attempt failed (null until the first failure). For the UI.</summary>
    public DateTimeOffset? LastErrorAt => TicksToOffset(Interlocked.Read(ref _lastErrorAtTicks));

    /// <summary>Consecutive failed uploads in the current bad streak; back to 0 after any success.</summary>
    public int ConsecutiveFailures => Volatile.Read(ref _consecutiveFailures);

    /// <summary>Internal "last forward progress" (a completed OR failed item), used by the watchdog.</summary>
    private DateTimeOffset LastProgressAt => new(Interlocked.Read(ref _lastProgressAtTicks), TimeSpan.Zero);

    private static DateTimeOffset? TicksToOffset(long ticks) => ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);

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

    /// <summary>
    /// Upload every item that is currently due, with up to <see cref="UploaderOptions.Concurrency"/> objects in
    /// flight at once. Each worker atomically claims the next due item (so no two take the same one) until the
    /// queue is drained; a failed item is gated by backoff, so it is not retried again within this drain.
    /// Returns the number uploaded.
    /// </summary>
    public async Task<int> DrainAsync(CancellationToken ct = default)
    {
        await _drainLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var done = 0;
            var workers = _concurrency;
            var tasks = new Task[workers];
            for (var i = 0; i < workers; i++) tasks[i] = Task.Run(() => WorkerAsync(ct), ct);
            await Task.WhenAll(tasks).ConfigureAwait(false);
            return Volatile.Read(ref done);

            async Task WorkerAsync(CancellationToken token)
            {
                while (!_paused && !token.IsCancellationRequested)
                {
                    QueueItem? item;
                    try
                    {
                        item = _queue.ClaimNextDue();
                    }
                    catch (Exception e)
                    {
                        // A transient store error (e.g. a briefly locked SQLite file) must never fault the whole
                        // drain / Task.WhenAll. End this worker; RunAsync retries the drain on its next cycle.
                        _logger.LogWarning(e, "claiming the next upload failed; ending this worker for now");
                        break;
                    }
                    if (item is null) break; // nothing due right now; another worker may still be finishing
                    if (await UploadOneAsync(item, token).ConfigureAwait(false)) Interlocked.Increment(ref done);
                }
            }
        }
        finally
        {
            _drainLock.Release();
        }
    }

    /// <summary>Background loop: drain, then sleep until nudged, the next backoff gate, or the idle poll.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        // The liveness watchdog runs on its OWN task with its OWN timer, tied to the same token. It never shares a
        // thread with the drain, so a fully wedged drain cannot starve it: it still rebuilds connections and nudges,
        // which is what lets the fast-lane heartbeat resume. Starting it here keeps VaultAgent's wiring unchanged.
        var watchdog = Task.Run(() => WatchdogAsync(ct), ct);
        try
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
        finally
        {
            try { await watchdog.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
            catch (Exception e) { _logger.LogWarning(e, "upload watchdog ended abnormally"); }
        }
    }

    /// <summary>
    /// Self-contained liveness monitor. Each tick, if there is work due or overdue but the drain has made no forward
    /// progress for <see cref="UploaderOptions.StallWindow"/>, it rebuilds the R2 connections and nudges the drain,
    /// so even a fully wedged drain recovers and the 30-second device-report heartbeat gets back out.
    /// </summary>
    private async Task WatchdogAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(_options.WatchdogInterval, _time);
        try
        {
            while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false))
            {
                try { WatchdogTick(); }
                catch (Exception e) { _logger.LogWarning(e, "upload watchdog tick failed"); }
            }
        }
        catch (OperationCanceledException) { }
    }

    private void WatchdogTick()
    {
        if (_paused) return;
        var now = _time.GetUtcNow();
        var age = now - LastProgressAt;
        if (!ShouldResetForStall(age, _queue.Depth(), _queue.NextAttemptTime(), now, _options.StallWindow)) return;
        _logger.LogWarning("upload stalled: no progress in {Age}; rebuilding connections", age);
        TryResetConnections();
        Nudge();
        // Treat the rebuild itself as progress so a persistent stall gets a full window to recover before the next
        // rebuild, rather than reset-storming on every tick.
        MarkProgress();
    }

    /// <summary>
    /// The watchdog's decision, pure so it can be unit-tested: rebuild only when there is work that is due or
    /// overdue (queue depth &gt; 0 and the next attempt is null or already passed) AND the drain has made no forward
    /// progress — no completed or failed item — for at least <paramref name="window"/>.
    /// </summary>
    internal static bool ShouldResetForStall(TimeSpan progressAge, int queueDepth, DateTimeOffset? nextAttempt, DateTimeOffset now, TimeSpan window)
    {
        if (queueDepth <= 0) return false;
        if (progressAge < window) return false;
        return nextAttempt is null || nextAttempt <= now;
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
                // Reconcile handles this at startup; at runtime treat it as lost rather than spin. DropLost logs it
                // and, if the item's blob has not sent its manifest yet, drops the rest of that blob so no manifest
                // goes out for a blob that can no longer be completed.
                _queue.DropLost(item, "at upload time");
                return false;
            }
            if (item.Size > _options.MultipartThreshold) await UploadMultipartAsync(item, path, ct).ConfigureAwait(false);
            else await UploadSingleAsync(item, path, ct).ConfigureAwait(false);

            _queue.Complete(item.Id);
            OnUploadSucceeded();
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
            OnUploadFailed(e);
            return false;
        }
    }

    private static string Trim(string s) => s.Length > 200 ? s[..200] : s;

    /// <summary>A confirmed upload: record it, mark forward progress, and clear the failure streak and reset guard.</summary>
    private void OnUploadSucceeded()
    {
        var now = _time.GetUtcNow().UtcTicks;
        Interlocked.Exchange(ref _lastSuccessAtTicks, now);
        Interlocked.Exchange(ref _lastProgressAtTicks, now);
        Interlocked.Exchange(ref _consecutiveFailures, 0);
        Interlocked.Exchange(ref _resetDoneThisStreak, 0);
    }

    /// <summary>
    /// A failed attempt: record the error (trimmed, no secrets) and mark forward progress (the drain is moving, even
    /// if failing). Then, once per bad streak, rebuild the R2 connection pool — immediately on an R2 timeout, or
    /// after <see cref="UploaderOptions.ResetAfterConsecutiveFailures"/> consecutive failures. The guard keeps a long
    /// failing streak from reset-storming; the next success clears it.
    /// </summary>
    private void OnUploadFailed(Exception e)
    {
        var now = _time.GetUtcNow().UtcTicks;
        _lastError = Trim(e.Message);
        Interlocked.Exchange(ref _lastErrorAtTicks, now);
        Interlocked.Exchange(ref _lastProgressAtTicks, now);
        var streak = Interlocked.Increment(ref _consecutiveFailures);

        var isTimeout = e is R2Exception { IsTimeout: true };
        var threshold = _options.ResetAfterConsecutiveFailures;
        var reachedThreshold = threshold > 0 && streak >= threshold;
        if (!isTimeout && !reachedThreshold) return;
        if (Interlocked.CompareExchange(ref _resetDoneThisStreak, 1, 0) != 0) return; // already rebuilt this streak

        if (isTimeout) _logger.LogInformation("rebuilding R2 connections after an upload timeout");
        else _logger.LogInformation("rebuilding R2 connections after {Failures} consecutive upload failures", streak);
        TryResetConnections();
    }

    private void MarkProgress() => Interlocked.Exchange(ref _lastProgressAtTicks, _time.GetUtcNow().UtcTicks);

    private void TryResetConnections()
    {
        try { _client.ResetConnections(); }
        catch (Exception e) { _logger.LogWarning(e, "rebuilding R2 connections failed"); }
    }

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
