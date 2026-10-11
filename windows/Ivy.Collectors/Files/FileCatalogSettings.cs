using Ivy.Collectors.Common;
using Ivy.Core.Policy;

namespace Ivy.Collectors.Files;

/// <summary>
/// Settings for the <c>catalog</c> collector: a metadata-only listing of the user's files so the Mac can
/// browse everything on this PC and fetch a file's bytes on demand. No file content is read. Keys are
/// camelCase in <c>collector_config.settings</c>.
/// </summary>
public sealed class FileCatalogSettings
{
    /// <summary>
    /// Folders or drives to catalogue. Empty until the user turns cataloguing on (the app then sets it to
    /// <see cref="MediaPolicyDefaults.CatalogScope"/> — the whole profile and data drives), so the collector
    /// never walks the machine unprompted. Empty reports "no folders to catalogue".
    /// </summary>
    public IReadOnlyList<string> Roots { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Glob exclusions. Beyond the shared defaults (OS and program areas, temp, recycle bin, build/VCS), the
    /// catalog also skips the whole <c>AppData</c> tree: it is application caches and config, not files the
    /// user browses, and it holds most of the profile's file count. IVY's own collectors still read AppData
    /// directly (Telegram tdata, the LINE store/keys) — leaving it out of the catalog does not affect capture.
    /// </summary>
    public IReadOnlyList<string> Exclusions { get; init; } = CatalogExclusions;

    /// <summary>The catalog's default exclusions: the shared defaults plus the AppData tree.</summary>
    public static IReadOnlyList<string> CatalogExclusions { get; } =
        ExclusionMatcher.Defaults.Append("**/AppData").ToArray();

    public bool IncludeHidden { get; init; }
    public bool IncludeSystem { get; init; }

    /// <summary>Files listed per tick, so a huge tree never blocks one tick and the scan checkpoints often.</summary>
    public int ScanBatchSize { get; init; } = 1000;

    /// <summary>Full re-catalogue period (hours). 0 disables periodic rescans (a rescan command still works).</summary>
    public double FullRescanHours { get; init; } = 24;
}
