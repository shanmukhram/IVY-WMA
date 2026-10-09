namespace Ivy.Collectors.Common;

/// <summary>Lifecycle state shown in the UI. <c>Error</c> means the collector cannot capture (never silently).</summary>
public enum CollectorState
{
    Stopped,
    Disabled,
    Running,
    Paused,
    WaitingForPairing,
    Unsupported,
    Error,
}

/// <summary>
/// Per-collector status for the UI and the device report: name, enabled, running, lastRunAt, lastCaptureAt,
/// cursor, queueDepth, lastError, plus a free-form detail line (e.g. scan progress).
/// </summary>
public sealed record CollectorStatus(
    string Name,
    bool Enabled,
    bool Running,
    bool Paused,
    CollectorState State,
    DateTimeOffset? LastRunAt,
    DateTimeOffset? LastCaptureAt,
    string? Cursor,
    int QueueDepth,
    string? LastError,
    string? Detail,
    long CapturesThisSession);
