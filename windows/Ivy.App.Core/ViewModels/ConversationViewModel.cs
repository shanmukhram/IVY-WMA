using Ivy.App.Core.Diagnostics;
using Ivy.App.Core.Hosting;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// The conversation-capture controls (PRD WT/WL, PLAN task 1.13 part 2): the Telegram row's passcode entry and
/// "include channels" toggle, and the LINE row's "Run probe" / "Open report" actions, with the per-chat
/// progress line each collector reports. Deliberately minimal (PLAN decision 5): the status text comes straight
/// from the collector's own detail/error, so there is one source of truth.
/// </summary>
public sealed class ConversationViewModel : ObservableObject
{
    private readonly ICollectorHostView _host;
    private readonly Action<string>? _openFile;

    private bool _updating;
    private bool _includeChannels = true;
    private bool _telegramNeedsPasscode;
    private string _telegramStatus = "";
    private string _passcodeText = "";
    private string _passcodeStatus = "";
    private string _lineStatus = "";
    private string _reportPath = "";

    private readonly BackgroundWork _work = new();

    /// <summary>The last host operation queued by this panel (passcode, include channels, probe); tests await it.</summary>
    public Task LastWork { get; private set; } = Task.CompletedTask;

    public ConversationViewModel(ICollectorHostView host, Action<string>? openFile = null)
    {
        _host = host;
        _openFile = openFile;
        _includeChannels = host.TelegramIncludeChannels;
        ApplyPasscodeCommand = new AsyncRelayCommand(ApplyPasscodeAsync, () => _passcodeText.Length > 0);
        RunProbeCommand = new AsyncRelayCommand(RunProbeAsync);
        OpenReportCommand = new RelayCommand(OpenReport, () => HasReport);
    }

    public AsyncRelayCommand ApplyPasscodeCommand { get; }
    public AsyncRelayCommand RunProbeCommand { get; }
    public RelayCommand OpenReportCommand { get; }

    public string TelegramStatusText { get => _telegramStatus; private set => Set(ref _telegramStatus, value); }
    public bool TelegramNeedsPasscode { get => _telegramNeedsPasscode; private set => Set(ref _telegramNeedsPasscode, value); }
    public string PasscodeStatusText { get => _passcodeStatus; private set => Set(ref _passcodeStatus, value); }

    public string PasscodeText
    {
        get => _passcodeText;
        set { if (Set(ref _passcodeText, value ?? "")) ApplyPasscodeCommand.RaiseCanExecuteChanged(); }
    }

    /// <summary>Two-way with the row's toggle; a user change is pushed to the collector and persisted.</summary>
    public bool IncludeChannels
    {
        get => _includeChannels;
        set
        {
            if (!Set(ref _includeChannels, value) || _updating) return;
            _ = SetIncludeChannelsAsync(value);
        }
    }

    public string LineStatusText { get => _lineStatus; private set => Set(ref _lineStatus, value); }
    public string ReportPathText { get => _reportPath; private set => Set(ref _reportPath, value); }
    public bool HasReport => !string.IsNullOrEmpty(_host.LineReportPath);

    /// <summary>Refresh from the latest collector snapshots (UI thread, once a second).</summary>
    public void Update(CollectorInfo? telegram, CollectorInfo? line)
    {
        TelegramStatusText = StatusLine(telegram);
        TelegramNeedsPasscode = telegram?.LastError?.Contains("passcode", StringComparison.OrdinalIgnoreCase) ?? false;
        _updating = true;
        try { IncludeChannels = _host.TelegramIncludeChannels; }
        finally { _updating = false; }

        LineStatusText = StatusLine(line);
        var path = _host.LineReportPath;
        ReportPathText = path is null ? "no probe report yet" : "report: " + path;
        OpenReportCommand.RaiseCanExecuteChanged();
    }

    private static string StatusLine(CollectorInfo? info)
    {
        if (info is null) return "not available";
        if (!string.IsNullOrEmpty(info.LastError)) return info.LastError!;
        return string.IsNullOrEmpty(info.Detail) ? (info.Running ? "running" : "stopped") : info.Detail!;
    }

    private async Task ApplyPasscodeAsync()
    {
        var pass = _passcodeText;
        if (pass.Length == 0) return;
        PasscodeStatusText = "applying...";
        try
        {
            await (LastWork = _work.Run(() => _host.ApplyTelegramPasscodeAsync(pass)));
            PasscodeText = "";
            PasscodeStatusText = "passcode stored; reconnecting";
        }
        catch (Exception e)
        {
            PasscodeStatusText = "failed: " + e.Message;
        }
    }

    private async Task SetIncludeChannelsAsync(bool include)
    {
        // Host settings writes hit SQLite; keep them off the UI thread (the third run logged a UiThreadGuard warning here).
        try { await (LastWork = _work.Run(() => _host.SetTelegramIncludeChannelsAsync(include))); }
        catch (Exception e) { PasscodeStatusText = "include channels failed: " + e.Message; }
    }

    private async Task RunProbeAsync()
    {
        LineStatusText = "running probe...";
        try { await (LastWork = _work.Run(() => _host.RunLineProbeAsync())); }
        catch (Exception e) { LineStatusText = "probe failed: " + e.Message; }
        OpenReportCommand.RaiseCanExecuteChanged();
    }

    private void OpenReport()
    {
        var path = _host.LineReportPath;
        if (path is not null) _openFile?.Invoke(path);
    }
}
