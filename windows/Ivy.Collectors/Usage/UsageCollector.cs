using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;

namespace Ivy.Collectors.Usage;

/// <summary>
/// WC4: samples the foreground window every <see cref="UsageSettings.SampleSeconds"/> and emits
/// coalesced <c>usage_event</c> records (<c>app</c> = friendly name, <c>exe</c> = executable file name,
/// <c>title</c> = window title unless capture is off or excluded, <c>startedAt</c>/<c>endedAt</c>).
/// Sessions are grouped on the Mac. The open interval is persisted every sample, so after a crash it is
/// emitted ending at its last sample.
/// </summary>
public sealed class UsageCollector : Collector<UsageSettings>
{
    private const string OpenKey = "open";
    private readonly IForegroundWindowProbe? _probe;
    private UsageCoalescer _coalescer;
    private TitleFilter _filter;

    public UsageCollector(CollectorContext context, IForegroundWindowProbe? probe, UsageSettings? settings = null)
        : base(CollectorNames.Usage, context, settings)
    {
        _probe = probe;
        _coalescer = NewCoalescer(null);
        _filter = new TitleFilter(Settings.CaptureTitles, Settings.TitleExclusions);
    }

    public override TimeSpan Interval => TimeSpan.FromSeconds(Settings.SampleSeconds);

    public override string? UnsupportedReason => _probe is null ? "foreground-window sampling needs Windows" : null;

    public OpenUsage? Current => _coalescer.Current;

    protected override void Validate(UsageSettings s)
    {
        if (s.SampleSeconds is < 1 or > 3600) throw new ArgumentException("sampleSeconds must be 1..3600");
        if (s.IdleMinutes <= 0) throw new ArgumentException("idleMinutes must be positive");
        if (s.MaxEventMinutes <= 0) throw new ArgumentException("maxEventMinutes must be positive");
        _ = new TitleFilter(s.CaptureTitles, s.TitleExclusions);
    }

    protected override void OnSettingsChanged(UsageSettings previous, UsageSettings current)
    {
        _filter = new TitleFilter(current.CaptureTitles, current.TitleExclusions);
        _coalescer = NewCoalescer(_coalescer.Current);
    }

    private UsageCoalescer NewCoalescer(OpenUsage? open) =>
        new(TimeSpan.FromMinutes(Settings.IdleMinutes), TimeSpan.FromMinutes(Settings.MaxEventMinutes), open);

    public override Task StartAsync(CancellationToken ct)
    {
        // Recover an interval left open by a crash or power loss.
        var saved = Context.Settings.Load<OpenUsage>(Name, OpenKey);
        if (saved is not null && Sink is { } sink)
        {
            var c = NewCoalescer(saved);
            if (c.FlushAtLastSeen() is { } interval && interval.EndedAt > interval.StartedAt) Write(sink, interval);
            Context.Settings.Save<OpenUsage>(Name, OpenKey, null);
        }
        return Task.CompletedTask;
    }

    /// <summary>Deletes agent_settings <c>open</c> (the interval being tracked). Keeps sampling, idle and title settings.</summary>
    public override Task ClearProgressAsync()
    {
        Context.Settings.Delete(Name, OpenKey);
        _coalescer = NewCoalescer(null);
        Cursor = null;
        Detail = null;
        return Task.CompletedTask;
    }

    public override Task StopAsync()
    {
        if (_coalescer.Flush(Now) is { } interval && Sink is { } sink) Write(sink, interval);
        Context.Settings.Save<OpenUsage>(Name, OpenKey, null);
        return Task.CompletedTask;
    }

    public override Task TickAsync(CancellationToken ct)
    {
        if (_probe is null) return Task.CompletedTask;
        var sink = Sink;
        if (sink is null) return Task.CompletedTask;
        var now = Now;
        ForegroundSample? sample;
        TimeSpan idle;
        try
        {
            sample = _probe.Sample();
            idle = _probe.IdleTime();
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            SetError($"foreground probe failed: {e.Message}");
            return Task.CompletedTask;
        }
        var title = sample is null ? default : _filter.Classify(sample.Title, sample.Exe);
        foreach (var interval in _coalescer.Observe(now, sample?.App, sample?.Exe, title.Value, title.Captured, idle)) Write(sink, interval);
        Context.Settings.Save(Name, OpenKey, _coalescer.Current);
        Cursor = IvyTime.Format(now);
        Detail = _coalescer.Current is { } c ? $"in {c.App} since {IvyTime.Format(c.StartedAt)}" : (idle >= TimeSpan.FromMinutes(Settings.IdleMinutes) ? "idle" : "no foreground window");
        return Task.CompletedTask;
    }

    private void Write(IRecordSink sink, UsageInterval i)
    {
        var record = new UsageEventRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = IvyTime.Format(i.StartedAt),
            CaptureTime = IvyTime.Format(Now),
            App = i.App,
            Exe = i.Exe,
            Title = i.Title,
            TitleCaptured = i.TitleCaptured,
            StartedAt = IvyTime.Format(i.StartedAt),
            EndedAt = IvyTime.Format(i.EndedAt),
        };
        Emit(sink, record);
    }
}
