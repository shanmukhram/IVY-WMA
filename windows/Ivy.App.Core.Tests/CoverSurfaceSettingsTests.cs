using Ivy.App.Core.WindowLock;

namespace Ivy.App.Core.Tests;

public class CoverSurfaceSettingsTests
{
    [Fact]
    public void DashboardUrl_is_an_absolute_https_uri()
    {
        Assert.True(Uri.TryCreate(CoverSurfaceSettings.DashboardUrl, UriKind.Absolute, out var uri));
        Assert.Equal(Uri.UriSchemeHttps, uri!.Scheme);
    }
}
