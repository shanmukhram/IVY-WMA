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
}
