using Ivy.App.Core.Hosting;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// One collector: on/off toggle, last capture, last upload, queue depth, status dot. The Fluent window (fourth run)
/// shows it as an Overview tile and as the header card of the collector's own page, so it also carries the page
/// wording: a short <see cref="StatusLabel"/>, the <see cref="StatusReason"/>, an InfoBar
/// <see cref="Severity"/>/<see cref="HasProblem"/> and the <see cref="QueueContributionText"/>.
/// </summary>
public sealed class CollectorRowViewModel : ObservableObject
{
    private readonly Action<string, bool> _setEnabled;
    private bool _enabled;
    private bool _updating;
    private string _lastCapture = "never";
    private string _lastUpload = "never";
    private string _queueDepth = "0";
    private string _statusText = "";
    private string _statusColor = StatusRules.Grey;
    private CollectorStatus _status;
    private string _statusLabel = "Off";
    private string _statusReason = "";
    private string _detail = "";
    private string _queueContribution = "Nothing waiting to upload";
    private UiSeverity _severity = UiSeverity.Informational;
    private bool _hasProblem;
    private string _problemTitle = "";

    public CollectorRowViewModel(string name, Action<string, bool> setEnabled)
    {
        Name = name;
        DisplayName = CollectorNames.Display(name);
        Description = CollectorNames.Describe(name);
        Glyph = CollectorNames.Glyph(name);
        _setEnabled = setEnabled;
    }

    public string Name { get; }
    public string DisplayName { get; }
    /// <summary>One sentence on what the collector captures (page subtitle).</summary>
    public string Description { get; }
    /// <summary>Segoe Fluent Icons glyph for the tile and page header.</summary>
    public string Glyph { get; }

    /// <summary>"Working", "Paused", "Off", "Needs attention" or "Error".</summary>
    public string StatusLabel { get => _statusLabel; private set => Set(ref _statusLabel, value); }
    /// <summary>Why the status is what it is, in a sentence (the error, the stale reason, or the collector's detail).</summary>
    public string StatusReason { get => _statusReason; private set => Set(ref _statusReason, value); }
    /// <summary>The collector's own detail line (scan progress, database state), empty when none.</summary>
    public string DetailText { get => _detail; private set => Set(ref _detail, value); }
    /// <summary>"3 objects (12.0 MB) waiting to upload" or "Nothing waiting to upload".</summary>
    public string QueueContributionText { get => _queueContribution; private set => Set(ref _queueContribution, value); }
    public UiSeverity Severity { get => _severity; private set => Set(ref _severity, value); }
    /// <summary>Error or stale while on and not paused: the page shows an InfoBar.</summary>
    public bool HasProblem { get => _hasProblem; private set => Set(ref _hasProblem, value); }
    public string ProblemTitle { get => _problemTitle; private set => Set(ref _problemTitle, value); }

    /// <summary>Two-way with the row's toggle; user changes go to the collector host.</summary>
    public bool Enabled
    {
        get => _enabled;
        set
        {
            if (!Set(ref _enabled, value) || _updating) return;
            _setEnabled(Name, value);
        }
    }

    public string LastCaptureText { get => _lastCapture; private set => Set(ref _lastCapture, value); }
    public string LastUploadText { get => _lastUpload; private set => Set(ref _lastUpload, value); }
    public string QueueDepthText { get => _queueDepth; private set => Set(ref _queueDepth, value); }
    public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }
    /// <summary>Dot colour as <c>#RRGGBB</c>.</summary>
    public string StatusColor { get => _statusColor; private set => Set(ref _statusColor, value); }
    public CollectorStatus Status { get => _status; private set => Set(ref _status, value); }

    /// <summary>Refresh from the latest host and queue snapshots (UI thread).</summary>
    public void Update(CollectorInfo? info, AgentSnapshot snap, bool globallyPaused, DateTimeOffset now)
    {
        _updating = true;
        try { Enabled = info?.Enabled ?? false; }
        finally { _updating = false; }

        DateTimeOffset? capture = info?.LastCaptureAt;
        if (snap.LastQueuedByCollector.TryGetValue(Name, out var q) && (capture is null || q > capture)) capture = q;
        LastCaptureText = Fmt.Ago(capture, now);
        LastUploadText = Fmt.Ago(snap.LastUploadByCollector.TryGetValue(Name, out var u) ? u : null, now);
        var stats = snap.For(Name);
        var depth = info?.QueueDepth ?? stats.Objects;
        QueueDepthText = Fmt.Count(depth) + (stats.Bytes > 0 ? " (" + Fmt.Bytes(stats.Bytes) + ")" : "");

        var interval = info?.ExpectedInterval ?? CollectorNames.DefaultInterval(Name);
        var (status, text) = info is null
            ? (CollectorStatus.Off, "not available")
            : StatusRules.Evaluate(Name, info.Enabled, globallyPaused, info.Running, info.LastError, info.LastRunAt, interval, now, info.Detail);
        Status = status;
        StatusText = string.IsNullOrEmpty(info?.Detail) ? text : text + " - " + info.Detail;
        StatusColor = StatusRules.Color(status);

        DetailText = info?.Detail ?? "";
        StatusLabel = StatusRules.Label(status);
        Severity = StatusRules.Severity(status);
        StatusReason = StatusRules.Reason(status, text, info?.LastError, info?.Detail, info is null);
        HasProblem = status is CollectorStatus.Error or CollectorStatus.Stale;
        ProblemTitle = status == CollectorStatus.Error ? DisplayName + " has a problem"
            : status == CollectorStatus.Stale ? DisplayName + " needs attention" : "";
        QueueContributionText = depth <= 0 ? "Nothing waiting to upload"
            : Fmt.Count(depth) + (depth == 1 ? " object" : " objects") + (stats.Bytes > 0 ? " (" + Fmt.Bytes(stats.Bytes) + ")" : "") + " waiting to upload";
    }
}
