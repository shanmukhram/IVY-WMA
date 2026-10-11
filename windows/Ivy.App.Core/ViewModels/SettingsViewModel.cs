using System.Globalization;
using Ivy.App.Core.Diagnostics;
using Ivy.App.Core.Hosting;
using Ivy.Core.Policy;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// Capture and network settings (the only settings Windows has, PRD "App UI"): indexed roots, screenshot
/// roots, window-title capture and its exclusion list, the media policy (PLAN decision 8: auto-upload of images
/// and documents, their size caps and extension lists), bandwidth cap, run at login. Capture settings are
/// applied to the collector host immediately on every change (the caps when Apply is pressed). Applying
/// (collector settings, bandwidth, run at login) runs on the thread pool: each one writes SQLite or the registry.
/// </summary>
public sealed class SettingsViewModel : ObservableObject
{
    public const string RunAtLoginDecidedKey = "app.run_at_login_decided";
    private readonly ICollectorHostView _host;
    private readonly IAgentView _agent;
    private readonly IStartupRegistration _startup;
    private readonly string _exePath;
    private readonly BackgroundWork _work = new();
    private bool _windowTitleCapture = true;
    private bool _loading;
    private string _bandwidthText = "0";
    private string _bandwidthStatus = "";
    private string _settingsError = "";
    private bool _runAtLogin;
    private bool _autoUploadImages = MediaPolicyDefaults.AutoUploadImages;
    private bool _autoUploadDocuments = MediaPolicyDefaults.AutoUploadDocuments;
    private double _imageCapMB = MediaPolicyDefaults.ImageCapMB;
    private double _documentCapMB = MediaPolicyDefaults.DocumentCapMB;
    private string _imageCapText = FormatMB(MediaPolicyDefaults.ImageCapMB);
    private string _documentCapText = FormatMB(MediaPolicyDefaults.DocumentCapMB);
    private string _capsStatus = "";

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
        FileExclusions = new StringListViewModel(Apply);
        ImageExtensions = new StringListViewModel(Apply, normalize: MediaPolicyDefaults.NormalizeExtension);
        DocumentExtensions = new StringListViewModel(Apply, normalize: MediaPolicyDefaults.NormalizeExtension);
        ImageExtensions.Load(MediaPolicyDefaults.ImageExtensions);
        DocumentExtensions.Load(MediaPolicyDefaults.DocumentExtensions);
        ApplyBandwidthCommand = new RelayCommand(ApplyBandwidth);
        ApplyCapsCommand = new RelayCommand(ApplyCaps);
        ResyncConversationsCommand = new AsyncRelayCommand(ResyncConversationsAsync);
        IndexStandardFoldersCommand = new AsyncRelayCommand(IndexStandardFoldersAsync);
        CatalogMyPcCommand = new AsyncRelayCommand(CatalogMyPcAsync);
    }

    public AsyncRelayCommand ResyncConversationsCommand { get; }
    public AsyncRelayCommand IndexStandardFoldersCommand { get; }
    public AsyncRelayCommand CatalogMyPcCommand { get; }
    private string _maintenanceStatus = "";
    public string MaintenanceStatus { get => _maintenanceStatus; private set => Set(ref _maintenanceStatus, value); }

    private async Task ResyncConversationsAsync()
    {
        MaintenanceStatus = "Re-syncing conversations...";
        try { await (LastWork = _work.Run(() => _host.ResyncConversationsAsync())); MaintenanceStatus = "Re-sync started; Telegram and LINE re-walk their history."; }
        catch (Exception e) { MaintenanceStatus = "Re-sync failed: " + e.Message; }
    }

    private async Task IndexStandardFoldersAsync()
    {
        MaintenanceStatus = "Adding standard folders...";
        try
        {
            var task = _work.Run(() => _host.IndexStandardFoldersAsync());
            LastWork = task;
            var roots = await task;
            IndexedRoots.Load(roots);
            MaintenanceStatus = "Indexed roots: " + string.Join(", ", roots);
        }
        catch (Exception e) { MaintenanceStatus = "Add folders failed: " + e.Message; }
    }

    private async Task CatalogMyPcAsync()
    {
        MaintenanceStatus = "Starting catalogue...";
        try
        {
            var task = _work.Run(() => _host.CatalogMyPcAsync());
            LastWork = task;
            var roots = await task;
            MaintenanceStatus = "Cataloguing (names, sizes, dates only): " + string.Join(", ", roots);
        }
        catch (Exception e) { MaintenanceStatus = "Catalogue failed: " + e.Message; }
    }

    public StringListViewModel IndexedRoots { get; }
    public StringListViewModel ScreenshotRoots { get; }
    public StringListViewModel TitleExclusions { get; }
    /// <summary>Files collector exclusions (globs such as <c>node_modules</c> or <c>?:/Windows</c>).</summary>
    public StringListViewModel FileExclusions { get; }
    public RelayCommand ApplyBandwidthCommand { get; }

    /// <summary>Extensions whose originals upload automatically as images (no dot).</summary>
    public StringListViewModel ImageExtensions { get; }
    /// <summary>Extensions whose originals upload automatically as documents (no dot).</summary>
    public StringListViewModel DocumentExtensions { get; }
    public RelayCommand ApplyCapsCommand { get; }

    public bool AutoUploadImages
    {
        get => _autoUploadImages;
        set
        {
            if (Set(ref _autoUploadImages, value)) Apply();
        }
    }

    public bool AutoUploadDocuments
    {
        get => _autoUploadDocuments;
        set
        {
            if (Set(ref _autoUploadDocuments, value)) Apply();
        }
    }

    /// <summary>Image size cap in MB as typed; applied by <see cref="ApplyCapsCommand"/>.</summary>
    public string ImageCapText { get => _imageCapText; set => Set(ref _imageCapText, value ?? ""); }
    /// <summary>Document size cap in MB as typed; applied by <see cref="ApplyCapsCommand"/>.</summary>
    public string DocumentCapText { get => _documentCapText; set => Set(ref _documentCapText, value ?? ""); }
    public string CapsStatus { get => _capsStatus; private set => Set(ref _capsStatus, value); }
    public double ImageCapMB => _imageCapMB;
    public double DocumentCapMB => _documentCapMB;

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
            using var crumb = UiBreadcrumb.Enter("RunAtLogin");
            _runAtLogin = value;
            Raise();
            LastWork = SetRunAtLoginAsync(value);
        }
    }

    /// <summary>Completes when the most recent run-at-login or bandwidth change has been applied (tests, shell).</summary>
    public Task LastWork { get; private set; } = Task.CompletedTask;

    private async Task SetRunAtLoginAsync(bool value)
    {
        try
        {
            await _work.Run(() =>
            {
                if (value) _startup.Register(StartupCommand.Build(_exePath));
                else _startup.Unregister();
                _agent.SetSetting(RunAtLoginDecidedKey, "1");
            });
            SettingsError = "";
        }
        catch (Exception e)
        {
            SettingsError = "Run at login: " + e.Message;
            if (_runAtLogin == value)
            {
                _runAtLogin = !value; // the registry did not change: show what is really there
                Raise(nameof(RunAtLogin));
            }
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
            FileExclusions.Load(s.FileExclusions);
            _windowTitleCapture = s.WindowTitleCapture;
            Raise(nameof(WindowTitleCapture));
            _autoUploadImages = s.AutoUploadImages;
            _autoUploadDocuments = s.AutoUploadDocuments;
            _imageCapMB = s.ImageCapMB;
            _documentCapMB = s.DocumentCapMB;
            ImageCapText = FormatMB(s.ImageCapMB);
            DocumentCapText = FormatMB(s.DocumentCapMB);
            ImageExtensions.Load(s.ImageExtensions);
            DocumentExtensions.Load(s.DocumentExtensions);
            CapsStatus = CapsSummary();
            Raise(nameof(AutoUploadImages));
            Raise(nameof(AutoUploadDocuments));
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
        LastWork = ApplyBandwidthAsync(v.Value);
    }

    private async Task ApplyBandwidthAsync(long bytesPerSecond)
    {
        try
        {
            await _work.Run(() => { _agent.BandwidthBytesPerSecond = bytesPerSecond; }); // persisted by the uploader
            LoadBandwidth();
        }
        catch (Exception e)
        {
            BandwidthStatus = "could not set: " + e.Message;
        }
    }

    private void ApplyCaps()
    {
        var img = ParseMB(_imageCapText);
        var doc = ParseMB(_documentCapText);
        if (img is null || doc is null)
        {
            CapsStatus = $"enter sizes in MB, more than 0 and at most {FormatMB(MediaPolicyDefaults.MaxCapMB)}";
            return;
        }
        _imageCapMB = img.Value;
        _documentCapMB = doc.Value;
        ImageCapText = FormatMB(img.Value);
        DocumentCapText = FormatMB(doc.Value);
        CapsStatus = CapsSummary();
        Apply();
    }

    private string CapsSummary() => $"current: images up to {FormatMB(_imageCapMB)} MB, documents up to {FormatMB(_documentCapMB)} MB";

    internal static string FormatMB(double mb) => mb.ToString("0.###", CultureInfo.InvariantCulture);

    /// <summary>A cap in MB (invariant or current-culture decimals), or null when not in (0, max].</summary>
    internal static double? ParseMB(string? text)
    {
        var t = (text ?? "").Trim();
        if (t.EndsWith("MB", StringComparison.OrdinalIgnoreCase)) t = t[..^2].Trim();
        if (!double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
            && !double.TryParse(t, NumberStyles.Float, CultureInfo.CurrentCulture, out v)) return null;
        return v > 0 && v <= MediaPolicyDefaults.MaxCapMB ? v : null;
    }

    /// <summary>Show an error from the shell (e.g. the folder dialog failed).</summary>
    public void ReportError(string message) => SettingsError = message;

    public CollectorSettings Current() => new()
    {
        IndexedRoots = IndexedRoots.Values,
        ScreenshotRoots = ScreenshotRoots.Values,
        FileExclusions = FileExclusions.Values,
        WindowTitleCapture = _windowTitleCapture,
        TitleExclusions = TitleExclusions.Values,
        AutoUploadImages = _autoUploadImages,
        ImageCapMB = _imageCapMB,
        AutoUploadDocuments = _autoUploadDocuments,
        DocumentCapMB = _documentCapMB,
        ImageExtensions = ImageExtensions.Values,
        DocumentExtensions = DocumentExtensions.Values,
    };

    /// <summary>Completes when the most recent change has been applied (tests and the shell can await it).</summary>
    public Task LastApply { get; private set; } = Task.CompletedTask;

    private void Apply()
    {
        if (_loading) return;
        using var crumb = UiBreadcrumb.Enter("Settings.Apply");
        LastApply = ApplyAsync(Current());
    }

    /// <summary>The snapshot is taken on the UI thread; the host diff, SQLite writes and collector restarts run on the pool.</summary>
    private async Task ApplyAsync(CollectorSettings settings)
    {
        try
        {
            await _work.Run(() => _host.ApplySettingsAsync(settings));
            SettingsError = "";
        }
        catch (Exception e)
        {
            SettingsError = "Could not apply capture settings: " + e.Message;
        }
    }
}
