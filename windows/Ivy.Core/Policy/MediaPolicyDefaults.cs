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
    /// The user's standard folders to offer as indexed roots: Downloads (where chat apps save files),
    /// Desktop, Documents and Pictures. Only the ones that exist on this machine are returned, de-duplicated.
    /// The app seeds its indexed roots from these so the common case needs no manual folder picking (Bunny,
    /// Oct 11 2026: index Downloads and the media/document folders, since originals now persist in R2).
    /// </summary>
    public static IReadOnlyList<string> StandardUserFolders()
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var candidates = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.Desktop),
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
}
