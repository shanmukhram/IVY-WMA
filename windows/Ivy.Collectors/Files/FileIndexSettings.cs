using Ivy.Collectors.Common;
using Ivy.Core.Policy;

namespace Ivy.Collectors.Files;

/// <summary>Settings for the <c>files</c> collector (WC1/WC2, media policy per PLAN decision 8). Keys are camelCase in <c>collector_config.settings</c>.</summary>
public sealed class FileIndexSettings
{
    /// <summary>Folders or drives to index. Empty until Bunny picks folders (the collector then reports "no folders selected").</summary>
    public IReadOnlyList<string> Roots { get; init; } = Array.Empty<string>();

    /// <summary>Glob exclusions (see <see cref="ExclusionMatcher"/>).</summary>
    public IReadOnlyList<string> Exclusions { get; init; } = ExclusionMatcher.Defaults;

    public bool IncludeHidden { get; init; }
    public bool IncludeSystem { get; init; }

    /// <summary>Full rescan period (hours). 0 disables periodic rescans (rescan commands still work).</summary>
    public double FullRescanHours { get; init; } = 24;

    /// <summary>Files examined per tick of the initial/full scan (keeps the loop responsive and checkpoints often).</summary>
    public int ScanBatchSize { get; init; } = 500;

    /// <summary>WC2 thumbnails for images and PDF first pages.</summary>
    public bool Thumbnails { get; init; } = true;

    /// <summary>Largest source file a thumbnail is generated for.</summary>
    public long ThumbnailMaxBytes { get; init; } = 64L * 1024 * 1024;

    /// <summary>Windows only: also follow the NTFS USN journal (FileSystemWatcher always runs).</summary>
    public bool UseUsnJournal { get; init; } = true;

    public double UsnPollSeconds { get; init; } = 30;

    /// <summary>Delay before a watcher event is processed, so bursts of writes coalesce.</summary>
    public double ChangeDebounceSeconds { get; init; } = 2;

    // ---- media policy (PLAN decision 8): originals uploaded automatically, as chunked blobs in the bulk lane

    /// <summary>Upload images (payload kind <c>photo</c>) up to <see cref="ImageCapMB"/>. Images directly in a Screenshots folder are left to the screenshots collector.</summary>
    public bool AutoUploadImages { get; init; } = MediaPolicyDefaults.AutoUploadImages;

    public double ImageCapMB { get; init; } = MediaPolicyDefaults.ImageCapMB;

    /// <summary>Upload documents (payload kind <c>document</c>) up to <see cref="DocumentCapMB"/>.</summary>
    public bool AutoUploadDocuments { get; init; } = MediaPolicyDefaults.AutoUploadDocuments;

    public double DocumentCapMB { get; init; } = MediaPolicyDefaults.DocumentCapMB;

    /// <summary>Extensions treated as images (no dot, any case).</summary>
    public IReadOnlyList<string> ImageExtensions { get; init; } = MediaPolicyDefaults.ImageExtensions;

    /// <summary>Extensions treated as documents (no dot, any case).</summary>
    public IReadOnlyList<string> DocumentExtensions { get; init; } = MediaPolicyDefaults.DocumentExtensions;

    /// <summary>Plaintext bytes of originals encrypted into the queue per tick (at least one file per tick).</summary>
    public long OriginalsBytesPerTick { get; init; } = 64L * 1024 * 1024;

    /// <summary>
    /// No more originals are encrypted while this many ciphertext bytes of them still wait in the queue, so a slow
    /// or paused uploader (bandwidth cap, pause) holds the bulk back instead of filling the disk.
    /// </summary>
    public long MaxQueuedOriginalBytes { get; init; } = 1024L * 1024 * 1024;
}
