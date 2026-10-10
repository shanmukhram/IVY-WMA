namespace Ivy.App.Core.Diagnostics;

/// <summary>What the watchdog thread should do after one <see cref="UiWatchdogMonitor.Step"/>.</summary>
public sealed record WatchdogStep(bool PostHeartbeat, string? Warning, string? Info, bool WriteDump)
{
    public static readonly WatchdogStep None = new(false, null, null, false);
}

/// <summary>
/// The UI watchdog's state machine, without threads or Win32 (the shell's <c>UiWatchdog</c> drives it once a
/// second from a background thread). One heartbeat is in flight at a time: posted to the UI thread, acknowledged
/// there. Unacknowledged for <see cref="Threshold"/>: one "unresponsive" warning and one dump per incident;
/// acknowledged again: "recovered after N ms". Once per <see cref="HeartbeatEvery"/> an info line with the
/// last UI sample, whether or not the UI answers.
/// </summary>
public sealed class UiWatchdogMonitor
{
    private readonly object _lock = new();
    private DateTimeOffset? _postedAt;
    private DateTimeOffset? _incidentSince;
    private TimeSpan? _recoveredAfter;
    private DateTimeOffset? _lastHeartbeatLog;
    private UiSample? _sample;

    public UiWatchdogMonitor(TimeSpan? threshold = null, TimeSpan? heartbeatEvery = null)
    {
        Threshold = threshold ?? TimeSpan.FromSeconds(5);
        HeartbeatEvery = heartbeatEvery ?? TimeSpan.FromMinutes(1);
    }

    public TimeSpan Threshold { get; }
    public TimeSpan HeartbeatEvery { get; }
    public bool InIncident { get { lock (_lock) return _incidentSince is not null; } }
    public UiSample? LastSample { get { lock (_lock) return _sample; } }

    /// <summary>
    /// Called by the watchdog thread. <paramref name="uiBreadcrumb"/> and <paramref name="others"/> are read only
    /// when an incident starts.
    /// </summary>
    public WatchdogStep Step(DateTimeOffset now, Func<string> uiBreadcrumb, Func<IEnumerable<string>>? others = null)
    {
        lock (_lock)
        {
            string? warning = null, info = null;
            var dump = false;
            var post = false;

            if (_recoveredAfter is { } r)
            {
                info = HangReport.Recovered(r);
                _recoveredAfter = null;
            }

            if (_postedAt is null)
            {
                _postedAt = now;
                post = true;
            }
            else if (_incidentSince is null && now - _postedAt.Value >= Threshold)
            {
                _incidentSince = _postedAt;
                warning = HangReport.Unresponsive(_postedAt.Value, now, uiBreadcrumb(), others?.Invoke());
                dump = true;
            }

            if (_lastHeartbeatLog is null) _lastHeartbeatLog = now; // first line after one full period
            else if (now - _lastHeartbeatLog.Value >= HeartbeatEvery)
            {
                _lastHeartbeatLog = now;
                var hb = HangReport.Heartbeat(_incidentSince is null, _sample, now);
                info = info is null ? hb : info + Environment.NewLine + hb;
            }
            return new WatchdogStep(post, warning, info, dump);
        }
    }

    /// <summary>Called on the UI thread when the heartbeat runs there.</summary>
    public void Acknowledge(DateTimeOffset now, UiSample sample)
    {
        lock (_lock)
        {
            _sample = sample;
            _postedAt = null;
            if (_incidentSince is { } since)
            {
                _recoveredAfter = now - since;
                _incidentSince = null;
            }
        }
    }

    /// <summary>The dispatcher refused the post (shutting down): try again on the next step.</summary>
    public void PostFailed()
    {
        lock (_lock) _postedAt = null;
    }
}
