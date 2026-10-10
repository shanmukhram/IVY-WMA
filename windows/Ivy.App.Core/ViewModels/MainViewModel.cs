using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.Diagnostics;
using Ivy.App.Core.Diagnostics;
using Ivy.App.Core.Hosting;
using Ivy.Core.Storage;
using Ivy.Core.Upload;
using Microsoft.Extensions.Logging;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// Root view model for the status window and the tray. The WinUI shell calls <see cref="StartAsync"/> once,
/// then <see cref="RefreshAsync"/> once a second; agent events are marshalled through <see cref="IUiDispatcher"/>.
/// Side effects that write (uploader pause, collector host start/pause/toggle) run on the thread pool through
/// <see cref="BackgroundWork"/>; only their resulting state is set on the UI thread.
/// </summary>
public sealed class MainViewModel : ObservableObject
{
    public const int FeedSeedCount = ActivityFeed.DefaultCapacity;
    /// <summary>UI-thread work longer than this is logged (Apply, FlushFeed).</summary>
    public static readonly TimeSpan SlowUi = TimeSpan.FromMilliseconds(50);
    /// <summary>Each part of the worker-side refresh longer than this is logged.</summary>
    public static readonly TimeSpan SlowGather = TimeSpan.FromMilliseconds(250);
    private readonly IAgentView _agent;
    private readonly ICollectorHostView _host;
    private readonly IUiDispatcher _ui;
    private readonly TimeProvider _time;
    private readonly ILogger? _log;
    private readonly BackgroundWork _work = new();
    private readonly ConcurrentQueue<FeedEntry> _incoming = new();
    private int _flushScheduled;
    private UploadProgress? _latestProgress;
    private bool _started;
    private bool _refreshing;
    private bool _showMain;
    private bool _isRunning = true;
    private string _runStateText = "Running";
    private string _pendingObjects = "0";
    private string _pendingBytes = "0 B";
    private string _retrying = "0";
    private string _currentUpload = "idle";
    private double _currentUploadPercent;
    private bool _hasCurrentUpload;
    private string _syncStatus = "";
    private string _importText = "";
    private double _importPercent;
    private string _importBytes = "";
    private string _upBucket = "";
    private string _cmdBucket = "";
    private string _fingerprints = "";
    private string _hostError = "";

    public MainViewModel(IAgentView agent, ICollectorHostView host, IUiDispatcher ui, IStartupRegistration startup,
        Func<Task<string?>> pickFolder, string exePath, string appVersion, TimeProvider? time = null, Action<string>? openFile = null,
        ILogger? log = null)
    {
        _agent = agent;
        _log = log;
        _host = host;
        _ui = ui;
        _time = time ?? TimeProvider.System;
        AppVersion = appVersion;
        VersionText = "IVY for Windows " + appVersion;
        Pairing = new PairingViewModel(agent, ui);
        Settings = new SettingsViewModel(host, agent, startup, exePath, pickFolder);
        Conversation = new ConversationViewModel(host, openFile);
        foreach (var n in CollectorNames.All) Collectors.Add(new CollectorRowViewModel(n, SetCollectorEnabled));
        SyncNowCommand = new AsyncRelayCommand(SyncNowAsync, () => _agent.IsPaired);
        Pairing.Paired += (_, _) => OnPaired();
        Pairing.Continued += (_, _) => ShowMain = true;
    }

    public string AppVersion { get; }
    public string VersionText { get; }
    public PairingViewModel Pairing { get; }
    public SettingsViewModel Settings { get; }
    public ConversationViewModel Conversation { get; }
    public ActivityFeed Feed { get; } = new();
    public ObservableCollection<CollectorRowViewModel> Collectors { get; } = new();
    public AsyncRelayCommand SyncNowCommand { get; }

    /// <summary>Paired and past the fingerprint confirmation: show the status panel instead of the pairing panel.</summary>
    public bool ShowMain
    {
        get => _showMain;
        private set
        {
            if (Set(ref _showMain, value)) Raise(nameof(ShowPairing));
        }
    }
    public bool ShowPairing => !_showMain;

    /// <summary>Global Paused/Running toggle: pauses both capture (collector host) and uploads (uploader).</summary>
    public bool IsRunning
    {
        get => _isRunning;
        set
        {
            if (_isRunning == value) return;
            ApplyRunning(value);
        }
    }
    public string RunStateText { get => _runStateText; private set => Set(ref _runStateText, value); }

    public string PendingObjectsText { get => _pendingObjects; private set => Set(ref _pendingObjects, value); }
    public string PendingBytesText { get => _pendingBytes; private set => Set(ref _pendingBytes, value); }
    public string RetryingText { get => _retrying; private set => Set(ref _retrying, value); }
    public string CurrentUploadText { get => _currentUpload; private set => Set(ref _currentUpload, value); }
    public double CurrentUploadPercent { get => _currentUploadPercent; private set => Set(ref _currentUploadPercent, value); }
    public bool HasCurrentUpload { get => _hasCurrentUpload; private set => Set(ref _hasCurrentUpload, value); }
    public string SyncStatusText { get => _syncStatus; private set => Set(ref _syncStatus, value); }

    public string ImportText { get => _importText; private set => Set(ref _importText, value); }
    public double ImportPercent { get => _importPercent; private set => Set(ref _importPercent, value); }
    public string ImportBytesText { get => _importBytes; private set => Set(ref _importBytes, value); }

    public string UpBucketText { get => _upBucket; private set => Set(ref _upBucket, value); }
    public string CmdBucketText { get => _cmdBucket; private set => Set(ref _cmdBucket, value); }
    public string FingerprintText { get => _fingerprints; private set => Set(ref _fingerprints, value); }
    /// <summary>Errors from the collector host or the snapshot query; empty when fine.</summary>
    public string HostErrorText { get => _hostError; private set => Set(ref _hostError, value); }

    /// <summary>
    /// Completes when the most recent pause/resume or collector toggle has been applied off the UI thread and its
    /// result shown (tests and the shell can await it).
    /// </summary>
    public Task LastHostWork { get; private set; } = Task.CompletedTask;

    /// <summary>Tray label for the pause item.</summary>
    public string PauseMenuText => _isRunning ? "Pause" : "Resume";

    /// <summary>Subscribe to agent events, seed the feed from activity_log, and start collectors if paired.</summary>
    public async Task StartAsync()
    {
        if (_started) return;
        _started = true;
        _agent.ActivityAppended += (_, e) => EnqueueFeed(FeedEntry.FromActivity(e));
        _agent.UploadProgress += (_, p) => OnProgress(p);
        try { Feed.Seed(_agent.RecentActivity(FeedSeedCount)); }
        catch (Exception e) { HostErrorText = "Could not read activity_log: " + e.Message; }

        if (_agent.IsPaired)
        {
            ShowMain = true;
            await StartHostAsync();
            Settings.Load();
            // Uploader pause is persisted; carry it over to capture so both halves agree after a restart.
            var paused = _agent.UploadsPaused;
            _isRunning = !paused;
            await RunHostAsync(paused ? _host.PauseAsync : _host.ResumeAsync);
            UpdateRunState();
        }
        UpdateFingerprints();
        await RefreshAsync();
    }

    /// <summary>Re-read queue, collector and bucket state. Safe to call on a timer; overlapping calls are skipped.</summary>
    public async Task RefreshAsync()
    {
        if (_refreshing) return;
        _refreshing = true;
        try
        {
            AgentSnapshot snap;
            IReadOnlyList<CollectorInfo> infos;
            FileImportProgress? import;
            string error = "";
            try
            {
                (snap, infos, import, error) = await Task.Run(Gather);
            }
            catch (Exception e)
            {
                HostErrorText = "Status refresh failed: " + e.Message;
                return;
            }
            using (UiBreadcrumb.Enter("Apply rows=" + infos.Count))
            {
                var t0 = Stopwatch.GetTimestamp();
                Apply(snap, infos, import);
                HostErrorText = error;
                LogIfSlow("Apply rows=" + infos.Count, t0, SlowUi);
            }
        }
        finally
        {
            _refreshing = false;
        }
    }

    /// <summary>Thread pool. Each part is timed separately so a slow refresh says which source was slow.</summary>
    private (AgentSnapshot, IReadOnlyList<CollectorInfo>, FileImportProgress?, string) Gather()
    {
        var t0 = Stopwatch.GetTimestamp();
        var snap = _agent.Snapshot();
        LogIfSlow("refresh Snapshot", t0, SlowGather);
        IReadOnlyList<CollectorInfo> infos = Array.Empty<CollectorInfo>();
        FileImportProgress? import = null;
        var error = "";
        try
        {
            t0 = Stopwatch.GetTimestamp();
            infos = _host.Collectors();
            LogIfSlow("refresh Statuses", t0, SlowGather);
            t0 = Stopwatch.GetTimestamp();
            import = _host.FileImport;
            LogIfSlow("refresh FileImport", t0, SlowGather);
        }
        catch (Exception e)
        {
            error = "Collector host: " + e.Message;
        }
        return (snap, infos, import, error);
    }

    private void LogIfSlow(string what, long startTimestamp, TimeSpan limit)
    {
        var took = Stopwatch.GetElapsedTime(startTimestamp);
        if (took > limit) _log?.LogWarning("{Line}", HangReport.Slow(what, took));
    }

    private void Apply(AgentSnapshot snap, IReadOnlyList<CollectorInfo> infos, FileImportProgress? import)
    {
        var now = _time.GetUtcNow();
        var paused = !_isRunning;
        var byName = infos.ToDictionary(i => i.Name, StringComparer.Ordinal);
        foreach (var info in infos)
            if (!Collectors.Any(r => r.Name == info.Name)) Collectors.Add(new CollectorRowViewModel(info.Name, SetCollectorEnabled));
        foreach (var row in Collectors) row.Update(byName.GetValueOrDefault(row.Name), snap, paused, now);
        Conversation.Update(byName.GetValueOrDefault(CollectorNames.Telegram), byName.GetValueOrDefault(CollectorNames.Line));

        PendingObjectsText = Fmt.Count(snap.PendingObjects);
        PendingBytesText = Fmt.Bytes(snap.PendingBytes);
        RetryingText = Fmt.Count(snap.RetryingObjects);
        ApplyProgress();

        var filesQueued = snap.For(CollectorNames.Files);
        ImportBytesText = "bytes queued: " + Fmt.Bytes(filesQueued.Bytes) + " in " + Fmt.Count(filesQueued.Objects) + " objects";
        if (import is null)
        {
            ImportText = "no initial index reported by the files collector";
            ImportPercent = 0;
        }
        else
        {
            var est = import.FilesEstimated > 0 ? Fmt.Count(import.FilesEstimated) : "?";
            ImportPercent = import.Complete ? 100 : Fmt.Percent(import.FilesScanned, import.FilesEstimated);
            ImportText = (import.Complete ? "complete: " : "scanning: ") + Fmt.Count(import.FilesScanned) + " / " + est + " files"
                         + (import.FilesEstimated > 0 ? " (" + ImportPercent.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + "%)" : "");
        }

        UpBucketText = "up bucket: last put " + Fmt.StampAgo(snap.LastUpPutAt, now)
                       + (snap.UpError is null ? "" : "; last attempt failed " + Fmt.Ago(snap.UpErrorAt, now) + ": " + snap.UpError);
        CmdBucketText = "cmd bucket: last list " + Fmt.StampAgo(snap.LastCmdListAt, now)
                        + (snap.CmdError is null ? "" : "; error: " + snap.CmdError);
        UpdateFingerprints();
    }

    private void ApplyProgress()
    {
        var p = Volatile.Read(ref _latestProgress);
        if (p is null || p.Phase is UploadPhase.Completed or UploadPhase.Failed)
        {
            HasCurrentUpload = false;
            CurrentUploadPercent = 0;
            CurrentUploadText = p is null ? "idle"
                : p.Phase == UploadPhase.Failed ? "idle (last failed: " + p.ObjectKey + ")"
                : "idle (last: " + p.ObjectKey + ")";
            return;
        }
        HasCurrentUpload = true;
        CurrentUploadPercent = Fmt.Percent(p.BytesSent, p.TotalBytes);
        CurrentUploadText = p.ObjectKey + "  " + Fmt.Bytes(p.BytesSent) + " of " + Fmt.Bytes(p.TotalBytes)
                            + " (" + CurrentUploadPercent.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + "%)";
    }

    /// <summary>Worker thread: remember the newest progress (shown on the next refresh), feed the Started line.</summary>
    private void OnProgress(UploadProgress p)
    {
        Volatile.Write(ref _latestProgress, p);
        var entry = FeedEntry.FromProgress(p, _time.GetUtcNow());
        if (entry is not null) EnqueueFeed(entry);
    }

    /// <summary>
    /// Worker thread: queue a feed line and schedule at most one UI flush at a time. During the initial index
    /// the log can grow by thousands of lines a second; batching keeps the UI thread to one post per turn.
    /// </summary>
    private void EnqueueFeed(FeedEntry entry)
    {
        _incoming.Enqueue(entry);
        if (Interlocked.Exchange(ref _flushScheduled, 1) != 0) return;
        if (_ui.Post(FlushFeed)) return;
        // The dispatcher refused the post, so FlushFeed will never run: without this the flag stays set and the
        // feed silently stops. The entries stay queued and the next event schedules a new flush.
        Volatile.Write(ref _flushScheduled, 0);
        _log?.LogWarning("feed flush was not accepted by the UI dispatcher; {Pending} entries wait for the next event", _incoming.Count);
    }

    /// <summary>True while a feed flush is posted and not yet run (tests).</summary>
    internal bool FlushScheduled => Volatile.Read(ref _flushScheduled) != 0;

    private void FlushFeed()
    {
        Volatile.Write(ref _flushScheduled, 0); // anything arriving during the drain schedules a new flush
        var batch = new List<FeedEntry>();
        while (_incoming.TryDequeue(out var e)) batch.Add(e);
        if (batch.Count == 0) return;
        var what = "FlushFeed batch=" + batch.Count;
        using var crumb = UiBreadcrumb.Enter(what);
        var t0 = Stopwatch.GetTimestamp();
        Feed.AddRange(batch);
        LogIfSlow(what, t0, SlowUi);
    }

    public void TogglePause() => IsRunning = !_isRunning;

    /// <summary>
    /// UI thread: flip the state the window shows now; the uploader flag (SQLite write + activity append) and the
    /// collector host pause/resume (per-collector settings writes) run on the thread pool, in order.
    /// </summary>
    private void ApplyRunning(bool running)
    {
        using var crumb = UiBreadcrumb.Enter(running ? "ApplyRunning resume" : "ApplyRunning pause");
        _isRunning = running;
        UpdateRunState();
        LastHostWork = ApplyRunningAsync(running);
    }

    private async Task ApplyRunningAsync(bool running)
    {
        var error = await _work.Run<string?>(async () =>
        {
            string? err = null;
            try { _agent.UploadsPaused = !running; }
            catch (Exception e) { err = "Uploader: " + e.Message; }
            try { await (running ? _host.ResumeAsync() : _host.PauseAsync()).ConfigureAwait(false); }
            catch (Exception e) { err = "Collector host: " + e.Message; }
            return err;
        });
        if (error is not null) HostErrorText = error;
    }

    private void UpdateRunState()
    {
        RunStateText = _isRunning ? "Running" : "Paused";
        Raise(nameof(IsRunning));
        Raise(nameof(PauseMenuText));
    }

    public async Task SyncNowAsync()
    {
        if (!_agent.IsPaired) return;
        SyncStatusText = "syncing...";
        try
        {
            await Task.Run(() => _agent.SyncNowAsync());
            SyncStatusText = "last sync now: " + Fmt.Clock(_time.GetUtcNow()) + " ok";
        }
        catch (Exception e)
        {
            SyncStatusText = "sync failed: " + e.Message;
        }
        await RefreshAsync();
    }

    private void SetCollectorEnabled(string name, bool enabled)
    {
        using var crumb = UiBreadcrumb.Enter("SetCollectorEnabled");
        LastHostWork = RunHostAsync(() => _host.SetEnabledAsync(name, enabled));
    }

    /// <summary>Run a host operation on the thread pool; failures become the header's error line instead of exceptions.</summary>
    private async Task RunHostAsync(Func<Task> op)
    {
        try { await _work.Run(op); }
        catch (Exception e) { HostErrorText = "Collector host: " + e.Message; }
    }

    private async Task StartHostAsync()
    {
        try { await _work.Run(() => _host.StartAsync()); }
        catch (Exception e) { HostErrorText = "Collector host failed to start: " + e.Message; }
    }

    private async void OnPaired()
    {
        UpdateFingerprints();
        SyncNowCommand.RaiseCanExecuteChanged();
        Settings.Load();
        Settings.EnableRunAtLoginByDefault();
        await StartHostAsync();
        await RefreshAsync();
    }

    private void UpdateFingerprints()
    {
        var d = _agent.DeviceFingerprint;
        var m = _agent.MacFingerprint;
        FingerprintText = d is null && m is null ? "not paired" : "device " + (d ?? "?") + "   mac " + (m ?? "?");
    }

    /// <summary>Stop the collector host (the app disposes the agent afterwards).</summary>
    public async Task ShutdownAsync()
    {
        await _work.Idle().ConfigureAwait(false);
        try { await _host.DisposeAsync(); }
        catch (Exception e) { HostErrorText = "Collector host stop: " + e.Message; }
    }
}
