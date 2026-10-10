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
    private bool _hasTelegramProgress;
    private string _telegramChats = "";
    private string _telegramMessages = "";
    private double _telegramPercent;
    private string _phoneOnly = PhoneOnlyNote;
    private string _probeSummary = NoProbeYet;
    private bool _telegramOtherError;

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

    // ---- Telegram page (fourth run): per-chat progress parsed from the collector's detail line -------------

    public const string PhoneOnlyNote = "Secret chats live only on the phone. Telegram never syncs them to Telegram Desktop, so they are not captured from Windows.";
    public const string LineCoverageNote = "Always partial from Windows: LINE for Windows holds only what this PC has synced. The phone has the full history.";
    /// <summary><see cref="LineCoverageNote"/> as an instance property (x:Bind on the LINE page).</summary>
    public string LineCoverageText => LineCoverageNote;
    public const string NoProbeYet = "No probe has run on this PC yet.";

    /// <summary>An error other than "needs passcode" (that one has its own InfoBar with the passcode box).</summary>
    public bool TelegramHasOtherError { get => _telegramOtherError; private set => Set(ref _telegramOtherError, value); }

    public bool HasTelegramProgress { get => _hasTelegramProgress; private set => Set(ref _hasTelegramProgress, value); }
    /// <summary>"12 of 40 chats complete".</summary>
    public string TelegramChatsText { get => _telegramChats; private set => Set(ref _telegramChats, value); }
    /// <summary>"18,240 messages so far".</summary>
    public string TelegramMessagesText { get => _telegramMessages; private set => Set(ref _telegramMessages, value); }
    /// <summary>Chats with complete history, 0 to 100 (the ProgressBar).</summary>
    public double TelegramPercent { get => _telegramPercent; private set => Set(ref _telegramPercent, value); }
    /// <summary>The secret-chat note, with the count when the collector knows it.</summary>
    public string PhoneOnlyText { get => _phoneOnly; private set => Set(ref _phoneOnly, value); }

    /// <summary>The last probe's one-line summary ("Probe complete: 412 files, 6 databases, 0 readable").</summary>
    public string LineProbeSummary { get => _probeSummary; private set => Set(ref _probeSummary, value); }

    public string LineStatusText { get => _lineStatus; private set => Set(ref _lineStatus, value); }
    public string ReportPathText { get => _reportPath; private set => Set(ref _reportPath, value); }
    public bool HasReport => !string.IsNullOrEmpty(_host.LineReportPath);

    /// <summary>Refresh from the latest collector snapshots (UI thread, once a second).</summary>
    public void Update(CollectorInfo? telegram, CollectorInfo? line)
    {
        TelegramStatusText = StatusLine(telegram);
        TelegramNeedsPasscode = telegram?.LastError?.Contains("passcode", StringComparison.OrdinalIgnoreCase) ?? false;
        TelegramHasOtherError = !string.IsNullOrEmpty(telegram?.LastError) && !TelegramNeedsPasscode;
        _updating = true;
        try { IncludeChannels = _host.TelegramIncludeChannels; }
        finally { _updating = false; }

        LineStatusText = StatusLine(line);
        var path = _host.LineReportPath;
        ReportPathText = path is null ? "no probe report yet" : "report: " + path;
        OpenReportCommand.RaiseCanExecuteChanged();

        var progress = string.IsNullOrEmpty(telegram?.LastError) ? TelegramProgress.TryParse(telegram?.Detail) : null;
        if (progress is not null)
        {
            HasTelegramProgress = true;
            TelegramChatsText = Fmt.Count(progress.ChatsDone) + " of " + Fmt.Count(progress.ChatsTotal) + " chats complete";
            TelegramMessagesText = Fmt.Count(progress.Messages) + " messages so far";
            TelegramPercent = progress.ChatsTotal == 0 ? 100 : Fmt.Percent(progress.ChatsDone, progress.ChatsTotal);
            PhoneOnlyText = progress.PhoneOnly > 0
                ? Fmt.Count(progress.PhoneOnly) + (progress.PhoneOnly == 1 ? " secret chat is" : " secret chats are") + " on the phone only. " + PhoneOnlyNote
                : PhoneOnlyNote;
        }
        else if (telegram is null || !string.IsNullOrEmpty(telegram.LastError))
        {
            // No live progress (not available, or an error): keep the last numbers but stop claiming they are current.
            HasTelegramProgress = false;
        }

        var summary = LineProbe.Summary(line?.Detail);
        if (summary is not null) LineProbeSummary = summary;
        else if (path is not null && LineProbeSummary == NoProbeYet) LineProbeSummary = "Probe report saved.";
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
            await _host.ApplyTelegramPasscodeAsync(pass);
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
        try { await _host.SetTelegramIncludeChannelsAsync(include); }
        catch (Exception e) { PasscodeStatusText = "include channels failed: " + e.Message; }
    }

    private async Task RunProbeAsync()
    {
        LineStatusText = "running probe...";
        try { await _host.RunLineProbeAsync(); }
        catch (Exception e) { LineStatusText = "probe failed: " + e.Message; }
        OpenReportCommand.RaiseCanExecuteChanged();
    }

    private void OpenReport()
    {
        var path = _host.LineReportPath;
        if (path is not null) _openFile?.Invoke(path);
    }
}
