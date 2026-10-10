using System.Text;
using System.Text.Json;
using Ivy.App.Core.Hosting;
using Ivy.Collectors.Files;
using Ivy.Collectors.Host;
using Ivy.Collectors.Line;
using Ivy.Collectors.Screenshots;
using Ivy.Collectors.Telegram;
using Ivy.Collectors.Usage;
using Ivy.Core.Agent;
using Ivy.Core.Records;
using Microsoft.Extensions.Logging;
using HostState = Ivy.Collectors.Common.CollectorState;
using HostStatus = Ivy.Collectors.Common.CollectorStatus;

namespace Ivy.App.Hosting;

/// <summary>
/// The one place that knows Ivy.Collectors' API: adapts <see cref="CollectorHost"/> to the window's
/// <see cref="ICollectorHostView"/>. Capture settings map onto the collectors' own settings objects:
/// indexed roots = <c>files.roots</c>, file exclusions = <c>files.exclusions</c>, screenshot roots = <c>screenshots.roots</c>, window titles =
/// <c>usage.captureTitles</c> and <c>usage.titleExclusions</c>, media policy (PLAN decision 8) =
/// <c>files.autoUploadImages</c>, <c>imageCapMB</c>, <c>autoUploadDocuments</c>, <c>documentCapMB</c>,
/// <c>imageExtensions</c>, <c>documentExtensions</c>. Only collectors whose values changed are updated, because the
/// host restarts a running collector on every settings change.
/// </summary>
public sealed class CollectorHostAdapter : ICollectorHostView
{
    private const string Files = "files";
    private const string Screenshots = "screenshots";
    private const string Usage = "usage";
    private readonly CollectorHost _host;

    public CollectorHostAdapter(CollectorHost host) => _host = host;

    /// <summary>Build the Windows collectors over the agent and register them as its rescan/collector_config handlers.</summary>
    public static ICollectorHostView Create(VaultAgent agent, ILoggerFactory? loggers, string? keysDirectory = null)
    {
        Ivy.Collectors.Telegram.ITelegramPasscodeStore? passcode = null;
        Ivy.Collectors.Line.ILineKeyStore? lineKey = null;
        Func<Ivy.Collectors.Telegram.Client.ITelegramSessionProtector?>? protector = null;
        // The passcode and the running Telegram session stay on the PC, DPAPI-protected (WX2).
        if (keysDirectory is not null && OperatingSystem.IsWindows())
        {
            passcode = new Ivy.Collectors.Telegram.DpapiTelegramPasscodeStore(keysDirectory);
            lineKey = new Ivy.Collectors.Line.DpapiLineKeyStore(keysDirectory);
            protector = () => OperatingSystem.IsWindows()
                ? new Ivy.Collectors.Telegram.Client.DpapiSessionProtector(keysDirectory)
                : null;
        }
        var options = new CollectorHostOptions { Loggers = loggers, TelegramPasscodeStore = passcode, LineKeyStore = lineKey, TelegramSessionProtector = protector };
        return new CollectorHostAdapter(CollectorHost.CreateFor(agent, options));
    }

    public CollectorHost Host => _host;

    public IReadOnlyList<CollectorInfo> Collectors() => _host.Statuses().Select(ToInfo).ToList();

    private CollectorInfo ToInfo(HostStatus s) => new()
    {
        Name = s.Name,
        Enabled = s.Enabled,
        // A per-collector pause (persisted by the host) without the global pause shows as "not running" (amber).
        Running = s.Running && !s.Paused,
        LastRunAt = s.LastRunAt,
        LastCaptureAt = s.LastCaptureAt,
        QueueDepth = s.QueueDepth,
        LastError = s.State is HostState.Error or HostState.Unsupported ? s.LastError ?? s.State.ToString() : null,
        ExpectedInterval = _host.Find(s.Name)?.Interval,
        Detail = s.Detail,
    };

    public Task SetEnabledAsync(string name, bool enabled) => _host.SetEnabledAsync(name, enabled);

    public bool Paused
    {
        get
        {
            var all = _host.Statuses();
            return all.Count > 0 && all.All(s => s.Paused);
        }
    }

    public Task PauseAsync() => _host.PauseAllAsync();

    public Task ResumeAsync()
    {
        _host.ResumeAll();
        return Task.CompletedTask;
    }

    /// <summary>
    /// Initial index progress from the files collector's persisted scan state. The collector does not count
    /// files ahead of the walk, so the estimate is the previous full scan's total (unknown on the first scan).
    /// </summary>
    public FileImportProgress? FileImport
    {
        get
        {
            if (_host.Find(Files) is not FileIndexCollector f) return null;
            var last = f.LastFullScan;
            if (f.CurrentScan is { } scan) return new FileImportProgress(scan.FilesSeen, scan.FilesTotal is { } t ? Math.Max(t, scan.FilesSeen) : last?.FilesSeen ?? 0, Complete: false);
            return last is null ? null : new FileImportProgress(last.FilesSeen, last.FilesSeen, Complete: true);
        }
    }

    public CollectorSettings GetSettings()
    {
        var files = _host.Get<FileIndexCollector>().Settings;
        var shots = _host.Get<ScreenshotCollector>().Settings;
        var usage = _host.Get<UsageCollector>().Settings;
        return new CollectorSettings
        {
            IndexedRoots = files.Roots.ToList(),
            ScreenshotRoots = shots.Roots.ToList(),
            FileExclusions = files.Exclusions.ToList(),
            WindowTitleCapture = usage.CaptureTitles,
            TitleExclusions = usage.TitleExclusions.ToList(),
            AutoUploadImages = files.AutoUploadImages,
            ImageCapMB = files.ImageCapMB,
            AutoUploadDocuments = files.AutoUploadDocuments,
            DocumentCapMB = files.DocumentCapMB,
            ImageExtensions = files.ImageExtensions.ToList(),
            DocumentExtensions = files.DocumentExtensions.ToList(),
        };
    }

    public async Task ApplySettingsAsync(CollectorSettings settings)
    {
        var current = GetSettings();
        var files = new Dictionary<string, JsonElement>();
        if (!Same(current.IndexedRoots, settings.IndexedRoots)) files["roots"] = JsonSerializer.SerializeToElement(settings.IndexedRoots);
        if (!Same(current.FileExclusions, settings.FileExclusions)) files["exclusions"] = JsonSerializer.SerializeToElement(settings.FileExclusions);
        if (current.AutoUploadImages != settings.AutoUploadImages) files["autoUploadImages"] = JsonSerializer.SerializeToElement(settings.AutoUploadImages);
        if (current.ImageCapMB != settings.ImageCapMB) files["imageCapMB"] = JsonSerializer.SerializeToElement(settings.ImageCapMB);
        if (current.AutoUploadDocuments != settings.AutoUploadDocuments) files["autoUploadDocuments"] = JsonSerializer.SerializeToElement(settings.AutoUploadDocuments);
        if (current.DocumentCapMB != settings.DocumentCapMB) files["documentCapMB"] = JsonSerializer.SerializeToElement(settings.DocumentCapMB);
        if (!Same(current.ImageExtensions, settings.ImageExtensions)) files["imageExtensions"] = JsonSerializer.SerializeToElement(settings.ImageExtensions);
        if (!Same(current.DocumentExtensions, settings.DocumentExtensions)) files["documentExtensions"] = JsonSerializer.SerializeToElement(settings.DocumentExtensions);
        if (files.Count > 0) await UpdateAsync(Files, files);
        if (!Same(current.ScreenshotRoots, settings.ScreenshotRoots))
            await UpdateAsync(Screenshots, new() { ["roots"] = JsonSerializer.SerializeToElement(settings.ScreenshotRoots) });
        var usage = new Dictionary<string, JsonElement>();
        if (current.WindowTitleCapture != settings.WindowTitleCapture) usage["captureTitles"] = JsonSerializer.SerializeToElement(settings.WindowTitleCapture);
        if (!Same(current.TitleExclusions, settings.TitleExclusions)) usage["titleExclusions"] = JsonSerializer.SerializeToElement(settings.TitleExclusions);
        if (usage.Count > 0) await UpdateAsync(Usage, usage);
    }

    private async Task UpdateAsync(string collector, Dictionary<string, JsonElement> patch)
    {
        var r = await _host.UpdateSettingsAsync(collector, enabled: null, patch);
        if (r.Status == CommandStatusValues.Error) throw new ArgumentException($"{collector}: {r.Detail ?? "settings rejected"}");
    }

    private static bool Same(IReadOnlyList<string> a, IReadOnlyList<string> b) => a.SequenceEqual(b, StringComparer.Ordinal);

    public Task StartAsync(CancellationToken ct = default) => _host.StartAsync(ct);

    // ---- conversation controls (task 1.13 part 2) -------------------------------------------------

    private const string Telegram = "telegram";
    private const string Line = "line";

    public async Task ApplyTelegramPasscodeAsync(string passcode)
    {
        var bytes = Encoding.UTF8.GetBytes(passcode);
        try { _host.Get<TelegramCollector>().SetPasscode(bytes); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes); }
        // Restart so the next tick re-resolves tdata with the passcode immediately.
        await _host.StopCollectorAsync(Telegram);
        await _host.StartCollectorAsync(Telegram);
    }

    public bool TelegramIncludeChannels => _host.Get<TelegramCollector>().Settings.IncludeChannels;

    public async Task SetTelegramIncludeChannelsAsync(bool include)
    {
        if (include == TelegramIncludeChannels) return;
        await UpdateAsync(Telegram, new() { ["includeChannels"] = JsonSerializer.SerializeToElement(include) });
    }

    public async Task RunLineProbeAsync()
    {
        // One-shot: the collector clears runProbe after it runs. Tick once so the report is produced now.
        await UpdateAsync(Line, new() { ["runProbe"] = JsonSerializer.SerializeToElement(true) });
        await _host.TickNowAsync(Line);
    }

    public bool LineHasKey => _host.Get<LineDesktopCollector>().HasKey;

    public async Task ApplyLineKeyAsync(string key)
    {
        var bytes = Encoding.ASCII.GetBytes((key ?? "").Trim());
        try { _host.Get<LineDesktopCollector>().SetKey(bytes); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes); }
        await _host.StopCollectorAsync(Line);
        await _host.StartCollectorAsync(Line);
    }

    public async Task<bool> DetectLineKeyAsync()
    {
        byte[]? key = OperatingSystem.IsWindows() ? Ivy.Collectors.Line.LineKeyFinder.FromRunningLine() : null;
        if (key is null) return false;
        try { _host.Get<LineDesktopCollector>().SetKey(key); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(key); }
        await _host.StopCollectorAsync(Line);
        await _host.StartCollectorAsync(Line);
        return true;
    }

    public string? LineReportPath => (_host.Find(Line) as LineDesktopCollector)?.LastReportPath;

    public ValueTask DisposeAsync() => _host.DisposeAsync();
}
