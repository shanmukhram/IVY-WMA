namespace Ivy.Collectors.Screenshots;

/// <summary>Settings for the <c>screenshots</c> collector (WC3).</summary>
public sealed class ScreenshotSettings
{
    /// <summary>Folders to watch. Default: <c>%USERPROFILE%\Pictures\Screenshots</c>.</summary>
    public IReadOnlyList<string> Roots { get; init; } = new[] { DefaultRoot() };

    /// <summary>Image extensions treated as screenshots.</summary>
    public IReadOnlyList<string> Extensions { get; init; } = new[] { "png", "jpg", "jpeg", "bmp", "gif", "webp", "heic" };

    /// <summary>A file must keep the same size and mtime for this long (and be readable without writers) before upload.</summary>
    public double DebounceSeconds { get; init; } = 2;

    /// <summary>Upload screenshots already in the folder on first start (not just new ones).</summary>
    public bool UploadExisting { get; init; } = true;

    /// <summary>Re-list the folders this often in case a watcher event was missed.</summary>
    public double SweepSeconds { get; init; } = 60;

    /// <summary>Originals above this size are skipped (and reported).</summary>
    public long MaxBytes { get; init; } = 256L * 1024 * 1024;

    public static string DefaultRoot()
    {
        var pictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
        if (string.IsNullOrEmpty(pictures))
            pictures = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Pictures");
        return Path.Combine(pictures, "Screenshots");
    }
}
