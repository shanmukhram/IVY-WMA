using Ivy.App.Core;
using Microsoft.UI.Dispatching;
using Windows.Storage.Pickers;

namespace Ivy.App.Platform;

/// <summary>
/// <see cref="IUiDispatcher"/> over the WinUI DispatcherQueue; runs inline when already on the UI thread.
/// Returns TryEnqueue's result: false means the action will never run (the queue is shutting down), and the
/// caller must undo whatever it set up for it (MainViewModel clears its feed-flush flag and logs a warning).
/// </summary>
internal sealed class DispatcherQueueUiDispatcher : IUiDispatcher
{
    private readonly DispatcherQueue _queue;
    public DispatcherQueueUiDispatcher(DispatcherQueue queue) => _queue = queue;

    public bool Post(Action action)
    {
        if (!_queue.HasThreadAccess) return _queue.TryEnqueue(() => action());
        action();
        return true;
    }
}

/// <summary>WinRT FolderPicker, parented to the main window (required for unpackaged desktop apps).</summary>
internal sealed class FolderPickerService
{
    private readonly Func<IntPtr> _owner;
    public FolderPickerService(Func<IntPtr> owner) => _owner = owner;

    /// <summary>The chosen folder's path, or null when cancelled.</summary>
    public async Task<string?> PickAsync()
    {
        var picker = new FolderPicker
        {
            SuggestedStartLocation = PickerLocationId.ComputerFolder,
            ViewMode = PickerViewMode.List,
        };
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, _owner());
        var folder = await picker.PickSingleFolderAsync();
        return folder?.Path;
    }
}

internal static class AppPaths
{
    /// <summary>%LOCALAPPDATA%\IVY: vault-agent.db, queue\ (ciphertext only), keys\ (DPAPI-protected), logs\.</summary>
    public static string DataDirectory { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "IVY");

    public static string KeysDirectory => Path.Combine(DataDirectory, "keys");
    public static string LogDirectory => Path.Combine(DataDirectory, "logs");
    public static string LogFile => Path.Combine(LogDirectory, "ivy-app.log");
    public static string CrashFile => Path.Combine(LogDirectory, "ivy-app-crash.log");
    public static string ExePath => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Ivy.App.exe");
    public static string IconPath => Path.Combine(AppContext.BaseDirectory, "Assets", "ivy.ico");

    public static string Version
    {
        get
        {
            var v = typeof(AppPaths).Assembly
                .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
                .OfType<System.Reflection.AssemblyInformationalVersionAttribute>()
                .FirstOrDefault()?.InformationalVersion ?? "0.0.0";
            var plus = v.IndexOf('+');
            return plus >= 0 ? v[..plus] : v;
        }
    }

    /// <summary>Last-resort error log for crashes before or outside the normal logger.</summary>
    public static void AppendCrash(string what, Exception? e)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(CrashFile)!);
            File.AppendAllText(CrashFile, DateTimeOffset.UtcNow.ToString("O") + " " + what + Environment.NewLine + e + Environment.NewLine);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
