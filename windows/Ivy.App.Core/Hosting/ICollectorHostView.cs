using Ivy.Core.Policy;

namespace Ivy.App.Core.Hosting;

/// <summary>One collector row as the collector host reports it.</summary>
public sealed record CollectorInfo
{
    public required string Name { get; init; }
    public bool Enabled { get; init; }
    public bool Running { get; init; }
    public DateTimeOffset? LastRunAt { get; init; }
    public DateTimeOffset? LastCaptureAt { get; init; }
    /// <summary>Null: the window uses the queue's own per-collector count.</summary>
    public int? QueueDepth { get; init; }
    public string? LastError { get; init; }
    /// <summary>Null: <see cref="CollectorNames.DefaultInterval"/>.</summary>
    public TimeSpan? ExpectedInterval { get; init; }
    /// <summary>One free-form status line from the collector (scan progress, fallback notes).</summary>
    public string? Detail { get; init; }
}

/// <summary>Initial file index progress (files scanned / estimated). Bytes queued come from the upload queue.</summary>
public sealed record FileImportProgress(long FilesScanned, long FilesEstimated, bool Complete);

/// <summary>Capture settings the window edits (PRD: folder picker, screenshot roots, window-title setting with exclusion list).</summary>
public sealed record CollectorSettings
{
    public IReadOnlyList<string> IndexedRoots { get; init; } = Array.Empty<string>();
    public IReadOnlyList<string> ScreenshotRoots { get; init; } = Array.Empty<string>();
    /// <summary>
    /// Files collector glob exclusions (<c>files.exclusions</c>, ExclusionMatcher syntax). The live host reports the
    /// collector's own defaults (node_modules, .git, Windows, Program Files, temp...); empty only in the stored fallback.
    /// </summary>
    public IReadOnlyList<string> FileExclusions { get; init; } = Array.Empty<string>();
    /// <summary>WC4: window-title capture, default on.</summary>
    public bool WindowTitleCapture { get; init; } = true;
    /// <summary>Executable names or title substrings whose window titles are never captured.</summary>
    public IReadOnlyList<string> TitleExclusions { get; init; } = Array.Empty<string>();

    // Media policy (PLAN decision 8): originals uploaded automatically from the indexed folders.
    public bool AutoUploadImages { get; init; } = MediaPolicyDefaults.AutoUploadImages;
    public double ImageCapMB { get; init; } = MediaPolicyDefaults.ImageCapMB;
    public bool AutoUploadDocuments { get; init; } = MediaPolicyDefaults.AutoUploadDocuments;
    public double DocumentCapMB { get; init; } = MediaPolicyDefaults.DocumentCapMB;
    public IReadOnlyList<string> ImageExtensions { get; init; } = MediaPolicyDefaults.ImageExtensions;
    public IReadOnlyList<string> DocumentExtensions { get; init; } = MediaPolicyDefaults.DocumentExtensions;
}

/// <summary>
/// What the window needs from the collector host (Ivy.Collectors <c>CollectorHost</c>). The WinUI shell
/// adapts the real host to this in exactly one file, <c>Ivy.App/Hosting/CollectorHostAdapter.cs</c>.
/// Synchronous members are called from a worker thread once a second (<see cref="Collectors"/>,
/// <see cref="FileImport"/>) or from the UI thread (<see cref="GetSettings"/>) and must be cheap; the
/// async members are awaited by the view models, which turn failures into a visible error line.
/// </summary>
public interface ICollectorHostView : IAsyncDisposable
{
    /// <summary>Snapshot of all known collectors.</summary>
    IReadOnlyList<CollectorInfo> Collectors();

    /// <summary>The per-collector toggle: persist the flag and start or stop the collector.</summary>
    Task SetEnabledAsync(string name, bool enabled);

    /// <summary>Global pause of capture (the uploader is paused separately through <see cref="IAgentView"/>).</summary>
    bool Paused { get; }
    Task PauseAsync();
    Task ResumeAsync();

    /// <summary>Null when no initial index is known.</summary>
    FileImportProgress? FileImport { get; }

    CollectorSettings GetSettings();
    /// <summary>Apply and persist; throws <see cref="ArgumentException"/> when the host rejects a value.</summary>
    Task ApplySettingsAsync(CollectorSettings settings);

    /// <summary>Start collectors. Called at startup when already paired, and right after pairing.</summary>
    Task StartAsync(CancellationToken ct = default);

    /// <summary>
    /// Store the Telegram Desktop local passcode (DPAPI, WX2) and reconnect, so a "needs passcode" row can be
    /// cleared from the window. The bytes are zeroed by the implementation after use.
    /// </summary>
    Task ApplyTelegramPasscodeAsync(string passcode);
    /// <summary>Store a LINE key the user entered, then restart the LINE collector.</summary>
    Task ApplyLineKeyAsync(string key);
    /// <summary>Try to read the LINE key from the running LINE process; returns true if found and stored.</summary>
    Task<bool> DetectLineKeyAsync();
    /// <summary>Whether a LINE key is currently stored.</summary>
    bool LineHasKey { get; }

    /// <summary>Telegram "include channels" toggle (WT1): groups and DMs are always captured.</summary>
    bool TelegramIncludeChannels { get; }
    Task SetTelegramIncludeChannelsAsync(bool include);

    /// <summary>Run the LINE store probe once (WL1) and refresh the row; the report path is then in <see cref="LineReportPath"/>.</summary>
    Task RunLineProbeAsync();

    /// <summary>The last LINE probe report written, or null if none has been produced on this machine.</summary>
    string? LineReportPath { get; }

    /// <summary>Re-walk all Telegram and LINE history once and re-emit it (sides, sender names, avatars, Keep,
    /// account snapshot); the Mac merges by message id, so this does not duplicate.</summary>
    Task ResyncConversationsAsync();

    /// <summary>Add the standard user folders (Downloads, Desktop, Documents, Pictures that exist) to the file
    /// index roots, de-duped against the current roots. Returns the resulting roots.</summary>
    Task<IReadOnlyList<string>> IndexStandardFoldersAsync();
}
