namespace Ivy.Collectors.Common;

/// <summary>Collector names: used for <c>collector_state.name</c>, queue/activity attribution and command routing.</summary>
public static class CollectorNames
{
    public const string Files = "files";
    public const string Catalog = "catalog";
    public const string Screenshots = "screenshots";
    public const string Usage = "usage";
    public const string Notifications = "notifications";
    public const string Line = "line";
    public const string Telegram = "telegram";

    public static readonly IReadOnlyList<string> All = new[] { Files, Catalog, Screenshots, Usage, Notifications, Line, Telegram };
}

/// <summary>Activity-log event names the collectors add (the sink adds <c>encrypted</c>/<c>queued</c>).</summary>
public static class CollectorActivity
{
    public const string Captured = "captured";
    public const string Deleted = "deleted";
    public const string ScanStarted = "scan_started";
    public const string ScanProgress = "scan_progress";
    public const string ScanCompleted = "scan_completed";
    public const string Error = "collector_error";
    /// <summary>A media-policy original could not be read (locked, access denied); its metadata stays, the upload is retried on the next rescan.</summary>
    public const string OriginalFailed = "original_failed";
    public const string Started = "collector_started";
    public const string Stopped = "collector_stopped";
    public const string Config = "collector_config";
}
