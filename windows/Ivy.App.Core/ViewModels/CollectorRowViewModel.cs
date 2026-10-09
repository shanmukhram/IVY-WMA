using Ivy.App.Core.Hosting;

namespace Ivy.App.Core.ViewModels;

/// <summary>One collector row: on/off toggle, last capture, last upload, queue depth, status dot.</summary>
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

    public CollectorRowViewModel(string name, Action<string, bool> setEnabled)
    {
        Name = name;
        DisplayName = CollectorNames.Display(name);
        _setEnabled = setEnabled;
    }

    public string Name { get; }
    public string DisplayName { get; }

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
            : StatusRules.Evaluate(info.Enabled, globallyPaused, info.Running, info.LastError, info.LastRunAt, interval, now);
        Status = status;
        StatusText = string.IsNullOrEmpty(info?.Detail) ? text : text + " - " + info.Detail;
        StatusColor = StatusRules.Color(status);
    }
}
