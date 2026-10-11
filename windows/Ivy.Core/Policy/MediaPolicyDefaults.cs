namespace Ivy.Core.Policy;

/// <summary>
/// PLAN decision 8 (Windows media policy, supersedes PRD WC6): in every indexed root, images and documents
/// under a size cap upload automatically as originals; everything else is metadata + thumbnail, original on
/// request. The defaults live here so the files collector and the app's settings screen agree.
/// </summary>
public static class MediaPolicyDefaults
{
    public const bool AutoUploadImages = true;
    public const double ImageCapMB = 25;
    public const bool AutoUploadDocuments = true;
    public const double DocumentCapMB = 10;

    /// <summary>Largest cap the settings accept (MB). The upload path streams, so this only bounds mistakes.</summary>
    public const double MaxCapMB = 4096;

    public static IReadOnlyList<string> ImageExtensions { get; } = new[] { "png", "jpg", "jpeg", "heic", "heif", "webp", "gif", "bmp", "tiff" };

    public static IReadOnlyList<string> DocumentExtensions { get; } = new[] { "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "txt", "md", "rtf", "csv" };

    /// <summary>Extension as the policy compares it: trimmed, no leading dot, lower case. Empty when blank.</summary>
    public static string NormalizeExtension(string? ext) => (ext ?? "").Trim().TrimStart('.').ToLowerInvariant();

    /// <summary>MB to bytes (1 MB = 1,048,576 bytes, as Windows Explorer counts).</summary>
    public static long CapBytes(double mb) => (long)Math.Floor(mb * 1024 * 1024);

    /// <summary>
    /// What the file catalog covers by default (Bunny, Oct 11 2026): the whole user profile, plus any other
    /// fixed, ready local drive that is not the system drive. The catalog records names, sizes and dates only
    /// (no content) so the Mac can browse everything and fetch a file on demand. The OS and program areas are
    /// left out by <see cref="ExclusionMatcher.Defaults"/> (Windows, Program Files, ProgramData, AppData, temp,
    /// $Recycle.Bin, build/VCS). Only existing paths are returned, de-duplicated. On non-Windows (tests) this
    /// falls back to the user profile alone.
    /// </summary>
    public static IReadOnlyList<string> CatalogScope()
    {
        var roots = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrWhiteSpace(profile) && System.IO.Directory.Exists(profile) && seen.Add(profile)) roots.Add(profile);

        if (OperatingSystem.IsWindows())
        {
            var systemDrive = System.IO.Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
            try
            {
                foreach (var d in System.IO.DriveInfo.GetDrives())
                {
                    if (d.DriveType != System.IO.DriveType.Fixed || !d.IsReady) continue;
                    var name = d.RootDirectory.FullName;
                    if (systemDrive is not null && string.Equals(name, systemDrive, StringComparison.OrdinalIgnoreCase)) continue; // system drive covered by the profile
                    if (seen.Add(name)) roots.Add(name);
                }
            }
            catch (IOException) { /* a drive went away mid-enumeration; the roots we have are fine */ }
        }
        return roots;
    }

    /// <summary>
    /// The user's standard folders to offer as indexed roots: Downloads (where chat apps save files),
    /// Documents and Pictures. Only the ones that exist on this machine are returned, de-duplicated. Desktop
    /// is deliberately NOT included: on this machine it holds the IVY project checkout (source and build
    /// output), and indexing it swept in thousands of code files (Bunny, Oct 11 2026 — index Downloads and the
    /// media/document folders, not Desktop). Originals persist in R2, so these stay a durable backup.
    /// </summary>
    public static IReadOnlyList<string> StandardUserFolders()
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var candidates = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
            // Downloads has no SpecialFolder enum; it is a known folder under the profile on Windows.
            string.IsNullOrEmpty(profile) ? "" : System.IO.Path.Combine(profile, "Downloads"),
        };
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var roots = new List<string>();
        foreach (var c in candidates)
            if (!string.IsNullOrWhiteSpace(c) && System.IO.Directory.Exists(c) && seen.Add(c))
                roots.Add(c);
        return roots;
    }

    /// <summary>
    /// The indexed roots after adding the standard folders: <paramref name="existing"/> kept in order, then each of
    /// <paramref name="standard"/> (default <see cref="StandardUserFolders"/>) not already present, compared
    /// case-insensitively. Both the Settings "Index my standard folders" button and the files collector's one-time
    /// self-scope on first start use this, so the two always produce the same list.
    /// </summary>
    public static IReadOnlyList<string> WithStandardFolders(IEnumerable<string> existing, IReadOnlyList<string>? standard = null)
    {
        var merged = new List<string>(existing);
        var seen = new HashSet<string>(merged, StringComparer.OrdinalIgnoreCase);
        foreach (var folder in standard ?? StandardUserFolders())
            if (!string.IsNullOrWhiteSpace(folder) && seen.Add(folder)) merged.Add(folder);
        return merged;
    }
}
