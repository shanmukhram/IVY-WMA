using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Core.Agent;

public sealed class DeviceReporterOptions
{
    public TimeSpan Interval { get; init; } = TimeSpan.FromMinutes(5);
    public string? AppVersion { get; init; }
    public string Role { get; init; } = "windows";
}

/// <summary>
/// Builds <c>device_report</c> (per-collector enabled / lastRunAt / cursor / queueDepth / import progress, PRD principle 4)
/// from <c>collector_state</c> and the queue, and enqueues it for upload on a timer and on demand.
/// </summary>
public sealed class DeviceReporter
{
    public const string Collector = "status";
    private readonly RecordSink _sink;
    private readonly CollectorStateStore _collectors;
    private readonly UploadQueue _queue;
    private readonly DeviceReporterOptions _options;
    private readonly ActivityLog? _activity;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;

    public DeviceReporter(RecordSink sink, CollectorStateStore collectors, UploadQueue queue, DeviceReporterOptions? options = null,
        ActivityLog? activity = null, TimeProvider? time = null, ILogger<DeviceReporter>? logger = null)
    {
        _sink = sink;
        _collectors = collectors;
        _queue = queue;
        _options = options ?? new DeviceReporterOptions();
        _activity = activity;
        _time = time ?? TimeProvider.System;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    public DeviceReportRecord Build()
    {
        var depth = _queue.DepthByCollector();
        var now = IvyTime.Now(_time);
        var collectors = _collectors.All()
            .Select(c => new CollectorStateRecord
            {
                Name = c.Name,
                Enabled = c.Enabled,
                LastRunAt = c.LastRunAt,
                Cursor = c.Cursor,
                QueueDepth = depth.TryGetValue(c.Name, out var d) ? d : 0,
                ImportTotal = c.Import?.Total,
                ImportDone = c.Import?.Done,
                Phase = c.Import?.Phase,
            })
            .ToList();
        return new DeviceReportRecord
        {
            DeviceId = _sink.DeviceId,
            EventTime = now,
            CaptureTime = now,
            Role = _options.Role,
            AppVersion = _options.AppVersion,
            QueueDepthTotal = _queue.Depth(),
            Collectors = collectors,
            ReportedAt = now,
        };
    }

    public EnqueuedRecord ReportNow()
    {
        var report = Build();
        var r = _sink.Enqueue(report, Collector);
        _activity?.Append(Collector, ActivityEvents.DeviceReport, $"{r.ObjectKey} queueDepth={report.QueueDepthTotal}");
        return r;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(_options.Interval, _time);
        do
        {
            try { ReportNow(); }
            catch (Exception e) { _logger.LogWarning(e, "device report failed"); }
        } while (await WaitTick(timer, ct).ConfigureAwait(false));
    }

    private static async Task<bool> WaitTick(PeriodicTimer t, CancellationToken ct)
    {
        try { return await t.WaitForNextTickAsync(ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { return false; }
    }
}
