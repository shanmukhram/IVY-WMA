using Ivy.App.Core.Hosting;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// Capture and network settings (the only settings Windows has, PRD "App UI"): indexed roots, screenshot
/// roots, window-title capture and its exclusion list, bandwidth cap, run at login. Capture settings are
/// applied to the collector host immediately on every change.
/// </summary>
public sealed class SettingsViewModel : ObservableObject
{
    public const string RunAtLoginDecidedKey = "app.run_at_login_decided";
    private readonly ICollectorHostView _host;
    private readonly IAgentView _agent;
    private readonly IStartupRegistration _startup;
    private readonly string _exePath;
    private bool _windowTitleCapture = true;
    private bool _loading;
    private string _bandwidthText = "0";
    private string _bandwidthStatus = "";
    private string _settingsError = "";
    private bool _runAtLogin;

    public SettingsViewModel(ICollectorHostView host, IAgentView agent, IStartupRegistration startup, string exePath,
        Func<Task<string?>> pickFolder)
    {
        _host = host;
        _agent = agent;
        _startup = startup;
        _exePath = exePath;
        IndexedRoots = new StringListViewModel(Apply, pickFolder);
        ScreenshotRoots = new StringListViewModel(Apply, pickFolder);
        TitleExclusions = new StringListViewModel(Apply);
        ApplyBandwidthCommand = new RelayCommand(ApplyBandwidth);
    }

    public StringListViewModel IndexedRoots { get; }
    public StringListViewModel ScreenshotRoots { get; }
    public StringListViewModel TitleExclusions { get; }
    public RelayCommand ApplyBandwidthCommand { get; }

    public bool WindowTitleCapture
    {
        get => _windowTitleCapture;
        set
        {
            if (Set(ref _windowTitleCapture, value)) Apply();
        }
    }

    public string BandwidthText { get => _bandwidthText; set => Set(ref _bandwidthText, value ?? ""); }
    public string BandwidthStatus { get => _bandwidthStatus; private set => Set(ref _bandwidthStatus, value); }
    public string SettingsError { get => _settingsError; private set => Set(ref _settingsError, value); }

    public bool RunAtLogin
    {
        get => _runAtLogin;
        set
        {
            if (_runAtLogin == value) return;
            try
            {
                if (value) _startup.Register(StartupCommand.Build(_exePath));
                else _startup.Unregister();
                _agent.SetSetting(RunAtLoginDecidedKey, "1");
                _runAtLogin = value;
                SettingsError = "";
            }
            catch (Exception e)
            {
                SettingsError = "Run at login: " + e.Message;
            }
            Raise();
        }
    }

    /// <summary>Load from the host, uploader and registry. Re-points a stale Run entry at this exe.</summary>
    public void Load()
    {
        _loading = true;
        try
        {
            var s = _host.GetSettings();
            IndexedRoots.Load(s.IndexedRoots);
            ScreenshotRoots.Load(s.ScreenshotRoots);
            TitleExclusions.Load(s.TitleExclusions);
            _windowTitleCapture = s.WindowTitleCapture;
            Raise(nameof(WindowTitleCapture));
        }
        catch (Exception e)
        {
            SettingsError = "Could not load capture settings: " + e.Message;
        }
        finally
        {
            _loading = false;
        }
        LoadBandwidth();
        LoadStartup();
    }

    public void LoadBandwidth()
    {
        var bw = _agent.BandwidthBytesPerSecond;
        BandwidthText = Fmt.BandwidthKBps(bw);
        BandwidthStatus = "current: " + Fmt.Bandwidth(bw);
    }

    /// <summary>
    /// PRD WP2: run at login. On first pairing (no decision recorded yet) the entry is registered;
    /// after that the toggle is the user's choice.
    /// </summary>
    public void EnableRunAtLoginByDefault()
    {
        if (_agent.GetSetting(RunAtLoginDecidedKey) is not null) return;
        RunAtLogin = true;
    }

    private void LoadStartup()
    {
        try
        {
            var cmd = _startup.RegisteredCommand();
            _runAtLogin = cmd is not null;
            if (cmd is not null && !StartupCommand.PointsAt(cmd, _exePath)) _startup.Register(StartupCommand.Build(_exePath));
        }
        catch (Exception e)
        {
            SettingsError = "Run at login: " + e.Message;
        }
        Raise(nameof(RunAtLogin));
    }

    private void ApplyBandwidth()
    {
        var v = Fmt.ParseBandwidthKBps(_bandwidthText);
        if (v is null)
        {
            BandwidthStatus = "enter whole KB/s (0 = unlimited)";
            return;
        }
        try
        {
            _agent.BandwidthBytesPerSecond = v.Value;
            LoadBandwidth();
        }
        catch (Exception e)
        {
            BandwidthStatus = "could not set: " + e.Message;
        }
    }

    /// <summary>Show an error from the shell (e.g. the folder dialog failed).</summary>
    public void ReportError(string message) => SettingsError = message;

    public CollectorSettings Current() => new()
    {
        IndexedRoots = IndexedRoots.Values,
        ScreenshotRoots = ScreenshotRoots.Values,
        WindowTitleCapture = _windowTitleCapture,
        TitleExclusions = TitleExclusions.Values,
    };

    /// <summary>Completes when the most recent change has been applied (tests and the shell can await it).</summary>
    public Task LastApply { get; private set; } = Task.CompletedTask;

    private void Apply()
    {
        if (_loading) return;
        LastApply = ApplyAsync(Current());
    }

    private async Task ApplyAsync(CollectorSettings settings)
    {
        try
        {
            await _host.ApplySettingsAsync(settings);
            SettingsError = "";
        }
        catch (Exception e)
        {
            SettingsError = "Could not apply capture settings: " + e.Message;
        }
    }
}
