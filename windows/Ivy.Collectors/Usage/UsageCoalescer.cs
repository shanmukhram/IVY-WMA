namespace Ivy.Collectors.Usage;

/// <summary>A closed foreground interval, ready to become a <c>usage_event</c>.</summary>
public sealed record UsageInterval(string App, string? Exe, string? Title, DateTimeOffset StartedAt, DateTimeOffset EndedAt);

/// <summary>The open interval (persisted so a crash loses at most one sample period).</summary>
public sealed record OpenUsage(string App, string? Exe, string? Title, DateTimeOffset StartedAt, DateTimeOffset LastSeenAt);

/// <summary>
/// Pure WC4 coalescing. Consecutive samples with the same exe + (recorded) title extend one interval.
/// An interval closes when the foreground changes (ended at the new sample's time), when there is no
/// foreground window, after <c>idle</c> of no input (ended at the last input), or after
/// <c>maxEvent</c> (flushed; the session continues as a new interval starting at that instant).
/// </summary>
public sealed class UsageCoalescer
{
    private readonly TimeSpan _idle;
    private readonly TimeSpan _maxEvent;

    public UsageCoalescer(TimeSpan idleThreshold, TimeSpan maxEvent, OpenUsage? restored = null)
    {
        _idle = idleThreshold;
        _maxEvent = maxEvent;
        Current = restored;
    }

    public OpenUsage? Current { get; private set; }

    /// <param name="sample">Foreground at <paramref name="now"/> (title already filtered), or null for none.</param>
    /// <param name="idle">Time since last input at <paramref name="now"/>.</param>
    public IReadOnlyList<UsageInterval> Observe(DateTimeOffset now, string? app, string? exe, string? title, TimeSpan idle)
    {
        var closed = new List<UsageInterval>(2);
        if (idle >= _idle)
        {
            if (Current is { } c)
            {
                // The user stopped interacting at the last input; the interval ends there (never before it began).
                var lastInput = now - idle;
                closed.Add(Close(c, lastInput < c.StartedAt ? c.StartedAt : lastInput));
                Current = null;
            }
            return closed;
        }
        if (app is null)
        {
            if (Current is { } c) closed.Add(Close(c, now));
            Current = null;
            return closed;
        }
        if (Current is { } cur && SameKey(cur, exe, title, app))
        {
            if (now - cur.StartedAt >= _maxEvent)
            {
                closed.Add(Close(cur, now));
                Current = cur with { StartedAt = now, LastSeenAt = now };
            }
            else Current = cur with { LastSeenAt = now };
            return closed;
        }
        if (Current is { } prev) closed.Add(Close(prev, now));
        Current = new OpenUsage(app, exe, title, now, now);
        return closed;
    }

    /// <summary>Close whatever is open (stop, pause, shutdown).</summary>
    public UsageInterval? Flush(DateTimeOffset now)
    {
        if (Current is not { } c) return null;
        Current = null;
        return Close(c, now < c.StartedAt ? c.StartedAt : now);
    }

    /// <summary>After a crash: close the restored interval at the last time it was seen.</summary>
    public UsageInterval? FlushAtLastSeen()
    {
        if (Current is not { } c) return null;
        Current = null;
        return Close(c, c.LastSeenAt);
    }

    private static bool SameKey(OpenUsage c, string? exe, string? title, string app) =>
        string.Equals(c.Exe ?? c.App, exe ?? app, StringComparison.OrdinalIgnoreCase) && string.Equals(c.Title, title, StringComparison.Ordinal);

    private static UsageInterval Close(OpenUsage c, DateTimeOffset end) => new(c.App, c.Exe, c.Title, c.StartedAt, end);
}
