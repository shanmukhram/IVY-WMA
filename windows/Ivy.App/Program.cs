using Ivy.App.Platform;
using Microsoft.UI.Dispatching;
using Microsoft.Windows.AppLifecycle;

namespace Ivy.App;

/// <summary>
/// Entry point (the XAML-generated Main is disabled). Single instance: the first process registers the
/// instance key; a second launch redirects its activation to the first, which brings its window forward,
/// and then exits.
/// </summary>
public static class Program
{
    private const string InstanceKey = "IVY.Windows.Main";

    /// <summary>
    /// Raised in the main instance (on a worker thread) when another launch was redirected to it. The argument is that
    /// launch's command line, or null when it was not a plain launch (see StartupCommand.ShouldShowWindowOnRedirect).
    /// </summary>
    internal static event EventHandler<string?>? RedirectedActivation;

    [STAThread]
    private static int Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        if (RedirectToRunningInstance()) return 0;

        Microsoft.UI.Xaml.Application.Start(callbackParams =>
        {
            var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }

    /// <summary>True when another instance owns the key and this activation was handed to it.</summary>
    private static bool RedirectToRunningInstance()
    {
        AppInstance main;
        try { main = AppInstance.FindOrRegisterForKey(InstanceKey); }
        catch (Exception e)
        {
            // If AppLifecycle is unavailable, run anyway rather than not at all.
            AppPaths.AppendCrash("single-instance registration failed", e);
            return false;
        }
        if (main.IsCurrent)
        {
            main.Activated += (_, e) => RedirectedActivation?.Invoke(null, LaunchCommandLine(e));
            return false;
        }

        // This process has the foreground right (the user just launched it); hand it to the main instance.
        Win32.AllowSetForegroundWindow(main.ProcessId);
        var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
        // Redirect off the STA thread and wait (the wait pumps COM), as the AppLifecycle docs recommend.
        Task.Run(() => main.RedirectActivationToAsync(activation).AsTask()).Wait();
        return true;
    }

    /// <summary>The redirected launch's command line, or null for any other activation kind (or if it cannot be read).</summary>
    private static string? LaunchCommandLine(AppActivationArguments args)
    {
        try
        {
            return args.Kind == ExtendedActivationKind.Launch
                && args.Data is Windows.ApplicationModel.Activation.ILaunchActivatedEventArgs launch
                ? launch.Arguments ?? ""
                : null;
        }
        catch (Exception e)
        {
            AppPaths.AppendCrash("reading redirected activation arguments failed", e);
            return null;
        }
    }
}
