using System.Text.Json;
using System.Text.Json.Serialization;
using Ivy.Core.Policy;
using Ivy.Core.Storage;

namespace Ivy.App.Core.Hosting;

/// <summary>
/// Fallback <see cref="ICollectorHostView"/> with no live collectors: rows come from <c>collector_state</c>,
/// last capture from the queue's activity, and settings persist in <c>agent_settings</c>. It reports every
/// collector as not running, so the window shows amber rather than pretending capture works. Used when the
/// real collector host is unavailable, and as the persistence the adapter can delegate settings to.
/// </summary>
public sealed class StoredCollectorHostView : ICollectorHostView
{
    public const string SettingsKey = "app.collector_settings";
    private readonly CollectorStateStore _state;
    private readonly Func<string, string?> _get;
    private readonly Action<string, string> _set;
    private readonly CollectorSettings _defaults;

    public StoredCollectorHostView(CollectorStateStore state, Func<string, string?> getSetting, Action<string, string> setSetting,
        CollectorSettings? defaults = null)
    {
        _state = state;
        _get = getSetting;
        _set = setSetting;
        _defaults = defaults ?? new CollectorSettings();
    }

    public bool Paused { get; private set; }
    public FileImportProgress? FileImport => null;

    public IReadOnlyList<CollectorInfo> Collectors() => _state.All()
        .Select(r => new CollectorInfo
        {
            Name = r.Name,
            Enabled = r.Enabled,
            Running = false,
            LastRunAt = ParseOrNull(r.LastRunAt),
        })
        .ToList();

    public Task SetEnabledAsync(string name, bool enabled)
    {
        _state.SetEnabled(name, enabled);
        return Task.CompletedTask;
    }

    public Task PauseAsync()
    {
        Paused = true;
        return Task.CompletedTask;
    }

    public Task ResumeAsync()
    {
        Paused = false;
        return Task.CompletedTask;
    }

    public CollectorSettings GetSettings() => CollectorSettingsCodec.Decode(_get(SettingsKey)) ?? _defaults;

    public Task ApplySettingsAsync(CollectorSettings settings)
    {
        _set(SettingsKey, CollectorSettingsCodec.Encode(settings));
        return Task.CompletedTask;
    }

    public Task StartAsync(CancellationToken ct = default) => Task.CompletedTask;

    // No live collectors here, so the conversation controls are inert (the window hides them when not paired).
    public Task ApplyTelegramPasscodeAsync(string passcode) => Task.CompletedTask;
    public bool TelegramIncludeChannels => true;
    public Task SetTelegramIncludeChannelsAsync(bool include) => Task.CompletedTask;
    public Task RunLineProbeAsync() => Task.CompletedTask;
    public string? LineReportPath => null;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    internal static DateTimeOffset? ParseOrNull(string? s)
    {
        if (string.IsNullOrEmpty(s)) return null;
        try { return Ivy.Core.Protocol.IvyTime.Parse(s); }
        catch (FormatException) { return null; }
    }
}

/// <summary>JSON form of <see cref="CollectorSettings"/> for agent_settings.</summary>
public static class CollectorSettingsCodec
{
    private sealed class Dto
    {
        [JsonPropertyName("v")] public int V { get; set; } = 1;
        [JsonPropertyName("indexedRoots")] public List<string>? IndexedRoots { get; set; }
        [JsonPropertyName("screenshotRoots")] public List<string>? ScreenshotRoots { get; set; }
        [JsonPropertyName("fileExclusions")] public List<string>? FileExclusions { get; set; }
        [JsonPropertyName("windowTitleCapture")] public bool WindowTitleCapture { get; set; } = true;
        [JsonPropertyName("titleExclusions")] public List<string>? TitleExclusions { get; set; }
        [JsonPropertyName("autoUploadImages")] public bool? AutoUploadImages { get; set; }
        [JsonPropertyName("imageCapMB")] public double? ImageCapMB { get; set; }
        [JsonPropertyName("autoUploadDocuments")] public bool? AutoUploadDocuments { get; set; }
        [JsonPropertyName("documentCapMB")] public double? DocumentCapMB { get; set; }
        [JsonPropertyName("imageExtensions")] public List<string>? ImageExtensions { get; set; }
        [JsonPropertyName("documentExtensions")] public List<string>? DocumentExtensions { get; set; }
    }

    public static string Encode(CollectorSettings s) => JsonSerializer.Serialize(new Dto
    {
        IndexedRoots = s.IndexedRoots.ToList(),
        ScreenshotRoots = s.ScreenshotRoots.ToList(),
        FileExclusions = s.FileExclusions.ToList(),
        WindowTitleCapture = s.WindowTitleCapture,
        TitleExclusions = s.TitleExclusions.ToList(),
        AutoUploadImages = s.AutoUploadImages,
        ImageCapMB = s.ImageCapMB,
        AutoUploadDocuments = s.AutoUploadDocuments,
        DocumentCapMB = s.DocumentCapMB,
        ImageExtensions = s.ImageExtensions.ToList(),
        DocumentExtensions = s.DocumentExtensions.ToList(),
    });

    /// <summary>Null when absent or unreadable (the caller falls back to defaults).</summary>
    public static CollectorSettings? Decode(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        Dto? d;
        try { d = JsonSerializer.Deserialize<Dto>(json); }
        catch (JsonException) { return null; }
        if (d is null) return null;
        return new CollectorSettings
        {
            IndexedRoots = d.IndexedRoots ?? new List<string>(),
            ScreenshotRoots = d.ScreenshotRoots ?? new List<string>(),
            FileExclusions = d.FileExclusions ?? new List<string>(),
            WindowTitleCapture = d.WindowTitleCapture,
            TitleExclusions = d.TitleExclusions ?? new List<string>(),
            // absent (settings saved before the media policy): the defaults
            AutoUploadImages = d.AutoUploadImages ?? MediaPolicyDefaults.AutoUploadImages,
            ImageCapMB = d.ImageCapMB ?? MediaPolicyDefaults.ImageCapMB,
            AutoUploadDocuments = d.AutoUploadDocuments ?? MediaPolicyDefaults.AutoUploadDocuments,
            DocumentCapMB = d.DocumentCapMB ?? MediaPolicyDefaults.DocumentCapMB,
            ImageExtensions = d.ImageExtensions ?? MediaPolicyDefaults.ImageExtensions.ToList(),
            DocumentExtensions = d.DocumentExtensions ?? MediaPolicyDefaults.DocumentExtensions.ToList(),
        };
    }
}
