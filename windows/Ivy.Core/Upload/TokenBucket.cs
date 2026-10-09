namespace Ivy.Core.Upload;

/// <summary>
/// Token bucket for the upload bandwidth cap (WU5). Rate is bytes/second; capacity is one second of
/// rate (minimum 64 KiB) so bursts stay short. A rate of 0 means unlimited. Thread-safe.
/// </summary>
public sealed class TokenBucket
{
    private readonly TimeProvider _time;
    private readonly object _lock = new();
    private long _rate;
    private double _tokens;
    private long _lastTicks;

    public TokenBucket(long bytesPerSecond, TimeProvider? time = null)
    {
        _time = time ?? TimeProvider.System;
        _lastTicks = _time.GetTimestamp();
        Rate = bytesPerSecond;
    }

    /// <summary>Bytes per second; 0 = unlimited. May be changed while uploads run.</summary>
    public long Rate
    {
        get { lock (_lock) return _rate; }
        set
        {
            if (value < 0) throw new ArgumentOutOfRangeException(nameof(value));
            lock (_lock)
            {
                Refill();
                _rate = value;
                _tokens = Math.Min(_tokens, Capacity);
            }
        }
    }

    private double Capacity => Math.Max(_rate, 64 * 1024);

    private void Refill()
    {
        var now = _time.GetTimestamp();
        var elapsed = _time.GetElapsedTime(_lastTicks, now).TotalSeconds;
        _lastTicks = now;
        if (_rate > 0) _tokens = Math.Min(Capacity, _tokens + elapsed * _rate);
    }

    /// <summary>Wait until <paramref name="bytes"/> may be sent. Large requests are taken in capacity-sized slices.</summary>
    public async Task TakeAsync(long bytes, CancellationToken ct = default)
    {
        while (bytes > 0)
        {
            TimeSpan wait;
            lock (_lock)
            {
                if (_rate == 0) return;
                Refill();
                var want = Math.Min(bytes, (long)Capacity);
                if (_tokens >= want)
                {
                    _tokens -= want;
                    bytes -= want;
                    continue;
                }
                wait = TimeSpan.FromSeconds((want - _tokens) / _rate);
            }
            if (wait < TimeSpan.FromMilliseconds(1)) wait = TimeSpan.FromMilliseconds(1);
            await Task.Delay(wait, _time, ct).ConfigureAwait(false);
        }
    }
}

/// <summary>
/// Read-only, seekable stream over an in-memory buffer that charges the token bucket for bytes read
/// past the high-water mark (so an SDK that re-reads the body to sign it is not charged twice) and
/// reports progress.
/// </summary>
internal sealed class ThrottledBufferStream : Stream
{
    private readonly byte[] _buffer;
    private readonly TokenBucket _bucket;
    private readonly Action<long>? _progress;
    private long _pos;
    private long _highWater;

    public ThrottledBufferStream(byte[] buffer, TokenBucket bucket, Action<long>? progress)
    {
        _buffer = buffer;
        _bucket = bucket;
        _progress = progress;
    }

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => _buffer.Length;
    public override long Position { get => _pos; set => _pos = Math.Clamp(value, 0, _buffer.Length); }

    private const int Slice = 64 * 1024;

    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count).GetAwaiter().GetResult();

    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        await ReadAsync(buffer.AsMemory(offset, count), cancellationToken).ConfigureAwait(false);

    public override async ValueTask<int> ReadAsync(Memory<byte> destination, CancellationToken cancellationToken = default)
    {
        var n = (int)Math.Min(Math.Min(destination.Length, Slice), _buffer.Length - _pos);
        if (n <= 0) return 0;
        var end = _pos + n;
        if (end > _highWater)
        {
            await _bucket.TakeAsync(end - Math.Max(_pos, _highWater), cancellationToken).ConfigureAwait(false);
            _highWater = end;
            _progress?.Invoke(_highWater);
        }
        _buffer.AsMemory((int)_pos, n).CopyTo(destination);
        _pos = end;
        return n;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        Position = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _pos + offset,
            _ => _buffer.Length + offset,
        };
        return _pos;
    }

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
