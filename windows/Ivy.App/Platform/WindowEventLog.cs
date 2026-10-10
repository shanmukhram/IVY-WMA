using Ivy.App.Core.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;

namespace Ivy.App.Platform;

/// <summary>
/// Logs the main window's lifecycle and the session events around it, so a hang can be lined up with what the
/// desktop was doing: show/hide (AppWindow.Changed), activation, WM_DISPLAYCHANGE, WM_DPICHANGED and
/// WM_WTSSESSION_CHANGE (lock, unlock, remote connect...; registered with WTSRegisterSessionNotification). The
/// window messages come from a comctl32 subclass of the WinUI window. Close is logged by the app's Closing
/// handler. Identifiers and numbers only.
/// </summary>
internal sealed class WindowEventLog : IDisposable
{
    private static readonly UIntPtr SubclassId = new(0x1717);
    private readonly IntPtr _hwnd;
    private readonly ILogger _log;
    private readonly Win32.SubclassProc _proc; // kept alive: native code holds a pointer to it
    private readonly bool _subclassed;
    private readonly bool _sessionNotifications;

    /// <summary>Create on the UI thread after the window exists.</summary>
    public WindowEventLog(Window window, IntPtr hwnd, ILogger log)
    {
        _hwnd = hwnd;
        _log = log;
        _proc = Proc;
        _subclassed = Win32.SetWindowSubclass(hwnd, _proc, SubclassId, UIntPtr.Zero);
        if (!_subclassed) log.LogWarning("window: SetWindowSubclass failed; display/DPI/session events are not logged");
        _sessionNotifications = Win32.WTSRegisterSessionNotification(hwnd, Win32.NOTIFY_FOR_THIS_SESSION);
        if (!_sessionNotifications) log.LogWarning("window: WTSRegisterSessionNotification failed (error {Error})", System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        window.Activated += (_, e) => _log.LogInformation("window: activation {State}", e.WindowActivationState);
        window.AppWindow.Changed += OnChanged;
    }

    private void OnChanged(AppWindow sender, AppWindowChangedEventArgs args)
    {
        if (args.DidVisibilityChange) _log.LogInformation("window: {State}", sender.IsVisible ? "shown" : "hidden");
    }

    private IntPtr Proc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, UIntPtr id, UIntPtr refData)
    {
        try
        {
            switch (msg)
            {
                case Win32.WM_DISPLAYCHANGE:
                    _log.LogInformation("window: WM_DISPLAYCHANGE {Bpp} bpp {Width}x{Height}",
                        wParam.ToInt64(), lParam.ToInt64() & 0xFFFF, (lParam.ToInt64() >> 16) & 0xFFFF);
                    break;
                case Win32.WM_DPICHANGED:
                    _log.LogInformation("window: WM_DPICHANGED dpi {Dpi}", wParam.ToInt64() & 0xFFFF);
                    break;
                case Win32.WM_WTSSESSION_CHANGE:
                    _log.LogInformation("session: {Event} (session {Session})", HangReport.SessionChange((int)wParam.ToInt64()), lParam.ToInt64());
                    break;
            }
        }
        catch (Exception)
        {
            // Logging must never unwind into the window procedure.
        }
        return Win32.DefSubclassProc(hWnd, msg, wParam, lParam);
    }

    public void Dispose()
    {
        if (_sessionNotifications) Win32.WTSUnRegisterSessionNotification(_hwnd);
        if (_subclassed) Win32.RemoveWindowSubclass(_hwnd, _proc, SubclassId);
    }
}
