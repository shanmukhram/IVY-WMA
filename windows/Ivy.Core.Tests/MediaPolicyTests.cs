using Ivy.Core.Policy;

namespace Ivy.Core.Tests;

public class MediaPolicyTests
{
    [Fact]
    public void StandardUserFolders_returns_existing_distinct_absolute_paths()
    {
        var roots = MediaPolicyDefaults.StandardUserFolders();

        // Only folders that actually exist on this machine are offered, so the app never seeds a dead root.
        Assert.All(roots, r => Assert.True(Directory.Exists(r), $"{r} should exist"));
        Assert.All(roots, r => Assert.True(Path.IsPathRooted(r), $"{r} should be absolute"));
        Assert.Equal(roots.Count, roots.Distinct(StringComparer.OrdinalIgnoreCase).Count()); // no duplicates
    }

    [Fact]
    public void CapBytes_counts_mebibytes()
    {
        Assert.Equal(25L * 1024 * 1024, MediaPolicyDefaults.CapBytes(MediaPolicyDefaults.ImageCapMB));
        Assert.Equal(10L * 1024 * 1024, MediaPolicyDefaults.CapBytes(MediaPolicyDefaults.DocumentCapMB));
    }
}
