namespace Ivy.App.Core.WindowLock;

/// <summary>
/// The web page the cover surface shows while the window privacy lock is closed (PLAN decision 17).
/// The app's CoverPage loads <see cref="DashboardUrl"/> in a WebView2 that fills the locked window.
/// This is the one place the URL lives; change it here to point the cover surface somewhere else.
/// </summary>
public static class CoverSurfaceSettings
{
    public const string DashboardUrl = "https://elovia-speak.vercel.app/";
}
