using Ivy.App.Core;
using Ivy.App.Core.Diagnostics;
using Ivy.App.Core.Hosting;
using Ivy.App.Core.ViewModels;
using Ivy.App.Hosting;
using Ivy.App.Platform;
using Ivy.Core.Agent;
using Ivy.Core.KeyStore;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Ivy.App;

/// <summary>
/// One visible process hosts everything (no Windows service): the VaultAgent (queue, uploader, command
/// poller, device reporter), the collector host, the status window and the tray icon. Closing the window
/// hides it; the workers keep running until Quit from the tray.
/// </summary>
public partial class App : Application
{
    private static readonly TimeSpan ShutdownTimeout = TimeSpan.FromSeconds(15);
    private FileLoggerFactory? _loggers;
    private ILogger? _log;
    private VaultAgent? _agent;
    private VaultAgentView? _view;
    private ICollectorHostView? _host;
    private MainViewModel? _vm;
    private MainWindow? _window;
    private TrayIcon? _tray;
    private DispatcherQueueTimer? _timer;
    private DispatcherQueue? _dispatcher;
    private UiWatchdog? _watchdog;
    private WindowEventLog? _windowEvents;
    private DateTimeOffset? _lastTickAt;
    private bool _quitting;
    private int _hiddenTicks;

    public App()
    {
        InitializeComponent();
        UnhandledException += OnUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, e) => AppPaths.AppendCrash("unhandled (AppDomain)", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            AppPaths.AppendCrash("unobserved task exception", e.Exception);
            e.SetObserved();
        };
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        _dispatcher = DispatcherQueue.GetForCurrentThread();
        var minimized = StartupCommand.IsMinimizedLaunch(Environment.GetCommandLineArgs().Skip(1));
        try
        {
            Directory.CreateDirectory(AppPaths.DataDirectory);
            _loggers = new FileLoggerFactory(AppPaths.LogFile);
            _log = _loggers.CreateLogger("Ivy.App");
            _log.LogInformation("IVY {Version} starting (minimized={Minimized}) data={Dir}", AppPaths.Version, minimized, AppPaths.DataDirectory);

            // Hang diagnostics (second Windows run, AppHangB1): VaultDb writes on this thread are logged, the
            // usage probe never sends WM_GETTEXT to our own window, and a watchdog reports and dumps a stuck UI.
            IvyUiThread.SetCurrent();
            IvyUiThread.Logger = _loggers.CreateLogger("Ivy.UiThreadGuard");
            Ivy.Collectors.Usage.ForegroundTitleReader.OwnProcessTitle = "IVY";
            _watchdog = new UiWatchdog(_dispatcher, SampleUi, _loggers.CreateLogger("Ivy.Watchdog"), AppPaths.LogDirectory);
            _watchdog.Start();

            var keys = DeviceKeyStores.CreateDefault(AppPaths.KeysDirectory); // DPAPI, CurrentUser (WP3)
            _agent = new VaultAgent(new VaultAgentOptions
            {
                DataDirectory = AppPaths.DataDirectory,
                Reporter = new DeviceReporterOptions { AppVersion = AppPaths.Version },
            }, keys, loggers: _loggers);
            await _agent.StartAsync();
            _view = new VaultAgentView(_agent); // reads the paired state once; the UI uses the cached value
            _host = CollectorHostAdapter.Create(_agent, _loggers, AppPaths.KeysDirectory);

            var picker = new FolderPickerService(() => _window?.Hwnd ?? IntPtr.Zero);
            _vm = new MainViewModel(_view, _host, new DispatcherQueueUiDispatcher(_dispatcher), new RegistryStartupRegistration(),
                picker.PickAsync, AppPaths.ExePath, AppPaths.Version, openFile: OpenInShell, log: _loggers.CreateLogger("Ivy.App.Ui"),
                folders: new AppFolders(AppPaths.DataDirectory, AppPaths.LogDirectory), // Settings > Advanced (Open uses ShellExecute)
                lockStore: new DpapiWindowLockStore(AppPaths.KeysDirectory)); // window privacy lock; capture never reads it
            _window = new MainWindow(_vm);
            _window.AppWindow.Closing += OnWindowClosing;
            _windowEvents = new WindowEventLog(_window, _window.Hwnd, _log);

            _tray = new TrayIcon(AppPaths.IconPath, "IVY", ShowWindow, TrayMenu, e => _log?.LogError(e, "tray handler failed"), _log);
            // A redirected Run-key launch (--minimized, e.g. after fast startup) leaves the tray instance hidden.
            Program.RedirectedActivation += (_, commandLine) =>
            {
                if (StartupCommand.ShouldShowWindowOnRedirect(commandLine)) _dispatcher.TryEnqueue(ShowWindow);
            };

            await _vm.StartAsync();
            _timer = _dispatcher.CreateTimer();
            _timer.Interval = TimeSpan.FromSeconds(1);
            _timer.Tick += OnTick;
            _timer.Start();

            // From the Run key the app starts in the tray, unless it still needs pairing.
            if (!minimized || !_view.IsPaired) ShowWindow();
        }
        catch (Exception e)
        {
            _log?.LogCritical(e, "startup failed");
            AppPaths.AppendCrash("startup failed", e);
            ShowFatal(e);
        }
    }

    private async void OnTick(DispatcherQueueTimer sender, object args)
    {
        if (_vm is null || _window is null) return;
        using (UiBreadcrumb.Enter("OnTick"))
        {
            _lastTickAt = DateTimeOffset.UtcNow;
            // The tooltip is kept bare on purpose: just "IVY", no run state or queue count. The tray applies it
            // (on its own thread) only when the text changed, so this assignment stays cheap.
            if (_tray is not null) _tray.Tooltip = "IVY";
            // Hidden: refresh every 10 s only, to keep the tray tooltip roughly current. The workers do not depend on this timer.
            if (!_window.AppWindow.IsVisible && ++_hiddenTicks % 10 != 0) return;
        }
        // Not inside the breadcrumb: the UI thread is free while the refresh gathers on the pool (Apply has its own).
        try { await _vm.RefreshAsync(); }
        catch (Exception e) { _log?.LogWarning(e, "refresh failed"); }
    }

    /// <summary>UI thread, with each watchdog heartbeat.</summary>
    private UiSample SampleUi() => new(_vm?.Feed.Items.Count ?? 0, _window?.AppWindow.IsVisible == true, _lastTickAt);

    /// <summary>
    /// Runs on the tray thread. The menu is deliberately bare (Open and Quit) so the tray reveals nothing about
    /// the backup; pause and sync live in the window. The actions run on the UI thread (the tray marshals them
    /// through the DispatcherQueue).
    /// </summary>
    private IReadOnlyList<TrayMenuItem> TrayMenu()
    {
        return new[]
        {
            new TrayMenuItem("Open", ShowWindow),
            new TrayMenuItem("Quit", () => _ = QuitAsync()),
        };
    }

    /// <summary>Open a file (the LINE probe report) in its default app, or a folder (Settings > Advanced) in Explorer, via ShellExecute.</summary>
    private void OpenInShell(string path)
    {
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true }); }
        catch (Exception e) { _log?.LogWarning(e, "opening {Path} failed", path); }
    }

    private void ShowWindow()
    {
        if (_window is null) return;
        using var crumb = UiBreadcrumb.Enter("ShowWindow");
        if (_window.AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } p) p.Restore();
        _window.AppWindow.Show();
        _window.Activate();
        Win32.SetForegroundWindow(_window.Hwnd);
        _ = _vm?.RefreshAsync();
    }

    /// <summary>Close hides to the tray; only Quit ends the process.</summary>
    private void OnWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_quitting) return;
        _log?.LogInformation("window: close requested; hiding to the tray");
        args.Cancel = true;
        _vm?.Lock.Lock(); // closing to the tray locks the window again; workers and capture are untouched
        sender.Hide();
    }

    private async Task QuitAsync()
    {
        if (_quitting) return;
        _quitting = true;
        _log?.LogInformation("quit requested");
        _timer?.Stop();
        _watchdog?.Dispose();
        _windowEvents?.Dispose();
        _tray?.Dispose();
        _window?.AppWindow.Hide();
        try
        {
            var stop = Task.Run(async () =>
            {
                if (_vm is not null) await _vm.ShutdownAsync();
                if (_agent is not null) await _agent.DisposeAsync();
            });
            if (await Task.WhenAny(stop, Task.Delay(ShutdownTimeout)) != stop) _log?.LogWarning("shutdown timed out; exiting anyway (the queue is crash-safe)");
        }
        catch (Exception e)
        {
            _log?.LogError(e, "shutdown failed");
        }
        _view?.Dispose();
        Exit();
    }

    private void OnUnhandledException(object sender, Microsoft.UI.Xaml.UnhandledExceptionEventArgs e)
    {
        _log?.LogError(e.Exception, "unhandled UI exception");
        AppPaths.AppendCrash("unhandled (XAML)", e.Exception);
        // Keep the worker alive: a broken binding or handler must not stop capture and upload.
        e.Handled = true;
    }

    private void ShowFatal(Exception e)
    {
        var w = new Window { Title = "IVY: failed to start" };
        w.Content = new ScrollViewer
        {
            Content = new TextBlock
            {
                Text = "IVY could not start.\n\n" + e + "\n\nLogs: " + Path.GetDirectoryName(AppPaths.LogFile),
                TextWrapping = TextWrapping.Wrap,
                IsTextSelectionEnabled = true,
                Margin = new Thickness(16),
            },
        };
        w.Closed += (_, _) => Exit();
        w.Activate();
    }
}
