using Ivy.App.Core.WindowLock;
using Ivy.App.Platform;
using Microsoft.Extensions.Logging;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.Web.WebView2.Core;

namespace Ivy.App.Pages;

/// <summary>
/// The page shown while the window privacy lock is closed (PLAN decision 17). It hosts a WebView2 that fills the
/// page and loads <see cref="CoverSurfaceSettings.DashboardUrl"/>, so the locked window shows a live web dashboard.
/// A neutral placeholder (an empty Grid, no background, so Mica shows through) covers the WebView2 until the first
/// successful load, and whenever the web content is not available; only one is ever visible. It does not use the
/// view model, and nothing about how or when the page is used changes. The WebView2 keeps its own sign-in session
/// in a user-data folder under the app's data directory, separate from everything else.
/// </summary>
public sealed partial class CoverPage : Page, ICoverSurface
{
    /// <summary>Optional logger; warnings are logged with the exception type only. Null is fine — nothing is threaded through MainWindow.</summary>
    public static ILogger? Log { get; set; }

    private WebView2? _web;
    private DispatcherQueueTimer? _retryTimer;
    private bool _running;
    private bool _starting;
    private bool _coreReady;
    private int _retryStep;

    public CoverPage() => InitializeComponent();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        _running = true;
        // A closed WebView2 cannot be reused, so OnNavigatedFrom dropped the old one; build a fresh control here.
        if (_web is null)
        {
            _web = new WebView2 { Visibility = Visibility.Collapsed };
            RootGrid.Children.Insert(0, _web); // under the placeholder
        }
        Start();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        _running = false;
        if (_retryTimer is not null)
        {
            _retryTimer.Stop();
            _retryTimer.Tick -= OnRetryTick;
            _retryTimer = null;
        }
        if (_web is not null)
        {
            _web.NavigationCompleted -= OnNavigationCompleted;
            if (_web.CoreWebView2 is not null) _web.CoreWebView2.ProcessFailed -= OnProcessFailed;
            try { _web.Close(); }
            catch (Exception ex) { Log?.LogWarning("cover surface: WebView2 close failed: {Type}", ex.GetType().Name); }
            RootGrid.Children.Remove(_web);
            _web = null;
        }
        _coreReady = false;
        _starting = false;
        _retryStep = 0;
        ShowPlaceholder();
        base.OnNavigatedFrom(e);
    }

    /// <summary>Create the WebView2 environment, initialise the control and navigate. Any failure just shows the placeholder.</summary>
    private async void Start()
    {
        if (_starting || _web is null) return;
        if (_coreReady) { Navigate(); return; } // already live; re-navigate
        _starting = true;
        try
        {
            var userData = Path.Combine(AppPaths.DataDirectory, "webview");
            Directory.CreateDirectory(userData);
            var env = await CoreWebView2Environment.CreateWithOptionsAsync(string.Empty, userData, new CoreWebView2EnvironmentOptions());
            if (!_running || _web is null) return; // navigated away during the await
            await _web.EnsureCoreWebView2Async(env);
            if (!_running || _web?.CoreWebView2 is null) return;

            var settings = _web.CoreWebView2.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.IsStatusBarEnabled = false;

            _web.CoreWebView2.ProcessFailed += OnProcessFailed;
            _web.NavigationCompleted += OnNavigationCompleted;
            _coreReady = true;

            _web.CoreWebView2.Navigate(CoverSurfaceSettings.DashboardUrl);
        }
        catch (Exception ex)
        {
            // Runtime missing, environment failure or any other error: stay on the placeholder and keep retrying.
            Log?.LogWarning("cover surface: WebView2 init failed: {Type}", ex.GetType().Name);
            ShowPlaceholder();
            ScheduleRetry();
        }
        finally
        {
            _starting = false;
        }
    }

    private void Navigate()
    {
        try
        {
            if (_web?.CoreWebView2 is { } core) core.Navigate(CoverSurfaceSettings.DashboardUrl);
            else Start();
        }
        catch (Exception ex)
        {
            Log?.LogWarning("cover surface: WebView2 navigate failed: {Type}", ex.GetType().Name);
            ShowPlaceholder();
            ScheduleRetry();
        }
    }

    private void OnNavigationCompleted(WebView2 sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        if (!_running) return;
        if (args.IsSuccess)
        {
            _retryStep = 0;
            ShowWeb();
        }
        else
        {
            // Any WebView2 error status, including offline: hide the WebView2 so no raw error page shows, and retry.
            ShowPlaceholder();
            ScheduleRetry();
        }
    }

    private void OnProcessFailed(CoreWebView2 sender, CoreWebView2ProcessFailedEventArgs args)
    {
        if (!_running) return;
        ShowPlaceholder();
        ScheduleRetry();
    }

    /// <summary>Retry navigation on a modest backoff (30 s, then 60 s, then every 120 s) so the dashboard appears on its own when the network returns.</summary>
    private void ScheduleRetry()
    {
        if (!_running) return;
        var seconds = _retryStep switch { 0 => 30, 1 => 60, _ => 120 };
        if (_retryStep < 2) _retryStep++;
        _retryTimer ??= CreateRetryTimer();
        _retryTimer.Stop();
        _retryTimer.Interval = TimeSpan.FromSeconds(seconds);
        _retryTimer.Start();
    }

    private DispatcherQueueTimer CreateRetryTimer()
    {
        var timer = DispatcherQueue.CreateTimer();
        timer.IsRepeating = false;
        timer.Tick += OnRetryTick;
        return timer;
    }

    private void OnRetryTick(DispatcherQueueTimer sender, object args)
    {
        sender.Stop();
        if (!_running) return;
        Navigate();
    }

    private void ShowWeb()
    {
        if (_web is not null) _web.Visibility = Visibility.Visible;
        Placeholder.Visibility = Visibility.Collapsed;
    }

    private void ShowPlaceholder()
    {
        if (_web is not null) _web.Visibility = Visibility.Collapsed;
        Placeholder.Visibility = Visibility.Visible;
    }
}
