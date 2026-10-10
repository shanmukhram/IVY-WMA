using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using Ivy.App.Core.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.UI.Dispatching;

namespace Ivy.App.Platform;

/// <summary>One tray menu entry; <see cref="Text"/> null means a separator.</summary>
internal sealed record TrayMenuItem(string? Text, Action? OnClick = null, bool Enabled = true)
{
    public static readonly TrayMenuItem Separator = new(Text: null);
}

/// <summary>
/// Notification-area icon via Shell_NotifyIcon, on its own thread. The hidden message window, its GetMessage loop,
/// every Shell_NotifyIconW call and the popup menu live on a dedicated "IVY tray" thread, so a slow Explorer
/// (Shell_NotifyIconW is synchronous) cannot stall the WinUI thread, and a busy WinUI thread cannot stall the
/// tray (second Windows run, AppHangB1). Left click and menu commands are marshalled back to the UI thread through
/// its DispatcherQueue. The menu is built on the tray thread from <c>menu</c>, so that delegate must only read
/// cheap cached state (labels, the cached paired flag). The tooltip is pushed to the shell only when its text
/// changes. Re-adds itself when Explorer restarts (TaskbarCreated).
/// </summary>
internal sealed class TrayIcon : IDisposable
{
    private const string ClassName = "IvyTrayIconWindow";
    private const uint CallbackMessage = Win32.WM_APP + 1;
    private const uint UpdateTipMessage = Win32.WM_APP + 2;
    private const uint ShutdownMessage = Win32.WM_APP + 3;
    private const uint IconId = 1;
    private static readonly TimeSpan SlowShell = TimeSpan.FromMilliseconds(100);
    private readonly Win32.WndProc _wndProc; // kept alive: native code holds a pointer to it
    private readonly DispatcherQueue _ui;
    private readonly Thread _thread;
    private readonly Action _onOpen;
    private readonly Func<IReadOnlyList<TrayMenuItem>> _menu;
    private readonly Action<Exception> _onError;
    private readonly ILogger? _log;
    private readonly object _tipLock = new();
    private string _tooltip;
    // Tray thread only:
    private IntPtr _hwnd;
    private IntPtr _icon;
    private bool _ownsIcon;
    private uint _taskbarCreated;
    private bool _added;
    private int _disposed;

    /// <summary>Create on the UI thread (its DispatcherQueue receives the commands).</summary>
    public TrayIcon(string iconPath, string tooltip, Action onOpen, Func<IReadOnlyList<TrayMenuItem>> menu, Action<Exception> onError,
        ILogger? log = null)
    {
        _ui = DispatcherQueue.GetForCurrentThread() ?? throw new InvalidOperationException("create the tray icon on the UI thread");
        _tooltip = Clip(tooltip);
        _onOpen = onOpen;
        _menu = menu;
        _onError = onError;
        _log = log;
        _wndProc = WndProc;

        var ready = new ManualResetEventSlim(); // not disposed: the tray thread may still Set it after a timeout
        Exception? startError = null;
        _thread = new Thread(() => Run(iconPath, ready, e => startError = e)) { IsBackground = true, Name = "IVY tray" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        // Only the window creation is waited for; NIM_ADD happens after this on the tray thread.
        if (!ready.Wait(TimeSpan.FromSeconds(10))) throw new InvalidOperationException("the tray thread did not start");
        if (startError is not null) throw new InvalidOperationException("tray icon: " + startError.Message, startError);
    }

    /// <summary>Any thread. Unchanged text is a no-op; a change is applied on the tray thread.</summary>
    public string Tooltip
    {
        get
        {
            lock (_tipLock) return _tooltip;
        }
        set
        {
            var v = Clip(value);
            lock (_tipLock)
            {
                if (string.Equals(v, _tooltip, StringComparison.Ordinal)) return;
                _tooltip = v;
            }
            if (Volatile.Read(ref _disposed) == 0) Win32.PostMessageW(_hwnd, UpdateTipMessage, IntPtr.Zero, IntPtr.Zero);
        }
    }

    private static string Clip(string s) => s.Length > 127 ? s[..127] : s;

    // ------------------------------------------------------------------ tray thread

    private void Run(string iconPath, ManualResetEventSlim ready, Action<Exception> fail)
    {
        try { CreateWindow(iconPath); }
        catch (Exception e)
        {
            fail(e);
            ready.Set();
            return;
        }
        ready.Set();
        try
        {
            Add();
            while (true)
            {
                var r = Win32.GetMessageW(out var msg, IntPtr.Zero, 0, 0);
                if (r == 0) break; // WM_QUIT
                if (r == -1)
                {
                    _log?.LogWarning("tray: GetMessage failed (error {Error}); tray thread exits", Marshal.GetLastWin32Error());
                    break;
                }
                Win32.TranslateMessage(ref msg);
                Win32.DispatchMessageW(ref msg);
            }
        }
        catch (Exception e)
        {
            _onError(e);
        }
    }

    private void CreateWindow(string iconPath)
    {
        var hInstance = Win32.GetModuleHandleW(null);
        var wc = new Win32.WNDCLASSEXW
        {
            cbSize = (uint)Marshal.SizeOf<Win32.WNDCLASSEXW>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
            hInstance = hInstance,
            lpszClassName = ClassName,
        };
        // Returns 0 if the class already exists (e.g. a second TrayIcon in one process); CreateWindowEx still works then.
        Win32.RegisterClassExW(ref wc);
        _hwnd = Win32.CreateWindowExW(0, ClassName, "IVY tray", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, hInstance, IntPtr.Zero);
        if (_hwnd == IntPtr.Zero) throw new InvalidOperationException("could not create the tray message window (error " + Marshal.GetLastWin32Error() + ")");
        _taskbarCreated = Win32.RegisterWindowMessageW("TaskbarCreated");

        // Small-icon size for the current DPI (16 px at 100 %, 24 at 150 %); the .ico carries 16-64 px images.
        var cx = Math.Max(16, Win32.GetSystemMetrics(Win32.SM_CXSMICON));
        var cy = Math.Max(16, Win32.GetSystemMetrics(Win32.SM_CYSMICON));
        _icon = File.Exists(iconPath) ? Win32.LoadImageW(IntPtr.Zero, iconPath, Win32.IMAGE_ICON, cx, cy, Win32.LR_LOADFROMFILE) : IntPtr.Zero;
        _ownsIcon = _icon != IntPtr.Zero;
        if (!_ownsIcon) _icon = Win32.LoadIconW(IntPtr.Zero, Win32.IDI_APPLICATION);
    }

    private Win32.NOTIFYICONDATAW Data(uint flags) => new()
    {
        cbSize = (uint)Marshal.SizeOf<Win32.NOTIFYICONDATAW>(),
        hWnd = _hwnd,
        uID = IconId,
        uFlags = flags,
        uCallbackMessage = CallbackMessage,
        hIcon = _icon,
        szTip = Tooltip,
        szInfo = "",
        szInfoTitle = "",
    };

    /// <summary>Shell_NotifyIconW, timed: Explorer answers synchronously and can be slow.</summary>
    private bool Notify(uint message, uint flags, string what)
    {
        var data = Data(flags);
        var t0 = Stopwatch.GetTimestamp();
        var ok = Win32.Shell_NotifyIconW(message, ref data);
        var took = Stopwatch.GetElapsedTime(t0);
        if (took > SlowShell) _log?.LogWarning("{Line}", HangReport.Slow("Shell_NotifyIconW " + what, took));
        return ok;
    }

    private void Add() => _added = Notify(Win32.NIM_ADD, Win32.NIF_MESSAGE | Win32.NIF_ICON | Win32.NIF_TIP, "add");

    private IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        using var crumb = UiBreadcrumb.Enter("tray WndProc msg=0x" + msg.ToString("X4", CultureInfo.InvariantCulture));
        try
        {
            if (msg == CallbackMessage)
            {
                var evt = (uint)(lParam.ToInt64() & 0xFFFF);
                if (evt is Win32.WM_LBUTTONUP or Win32.WM_LBUTTONDBLCLK) PostToUi(_onOpen);
                else if (evt == Win32.WM_RBUTTONUP) ShowMenu();
                return IntPtr.Zero;
            }
            if (msg == UpdateTipMessage)
            {
                if (_added) Notify(Win32.NIM_MODIFY, Win32.NIF_TIP, "modify");
                return IntPtr.Zero;
            }
            if (msg == ShutdownMessage)
            {
                Teardown();
                return IntPtr.Zero;
            }
            if (msg == _taskbarCreated && _taskbarCreated != 0)
            {
                Add();
                return IntPtr.Zero;
            }
        }
        catch (Exception e)
        {
            // Never let an exception unwind into native code.
            _onError(e);
        }
        return Win32.DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private void PostToUi(Action action)
    {
        var queued = _ui.TryEnqueue(() =>
        {
            try { action(); }
            catch (Exception e) { _onError(e); }
        });
        if (!queued) _log?.LogWarning("tray: the UI dispatcher refused a tray command");
    }

    private void ShowMenu()
    {
        var items = _menu();
        using var crumb = UiBreadcrumb.Enter("tray ShowMenu items=" + items.Count.ToString(CultureInfo.InvariantCulture));
        var menu = Win32.CreatePopupMenu();
        if (menu == IntPtr.Zero) return;
        try
        {
            for (var i = 0; i < items.Count; i++)
            {
                var it = items[i];
                if (it.Text is null) Win32.AppendMenuW(menu, Win32.MF_SEPARATOR, UIntPtr.Zero, null);
                else Win32.AppendMenuW(menu, Win32.MF_STRING | (it.Enabled ? 0 : Win32.MF_GRAYED), (UIntPtr)(uint)(i + 1), it.Text);
            }
            Win32.GetCursorPos(out var pt);
            // Required so the menu closes when the user clicks elsewhere (documented TrackPopupMenu quirk).
            Win32.SetForegroundWindow(_hwnd);
            var cmd = Win32.TrackPopupMenuEx(menu, Win32.TPM_RIGHTBUTTON | Win32.TPM_RETURNCMD | Win32.TPM_NONOTIFY, pt.X, pt.Y, _hwnd, IntPtr.Zero);
            Win32.PostMessageW(_hwnd, Win32.WM_NULL, IntPtr.Zero, IntPtr.Zero);
            if (cmd > 0 && cmd <= items.Count && items[cmd - 1] is { Enabled: true, OnClick: { } click }) PostToUi(click);
        }
        finally
        {
            Win32.DestroyMenu(menu);
        }
    }

    private void Teardown()
    {
        if (_added)
        {
            Notify(Win32.NIM_DELETE, 0, "delete");
            _added = false;
        }
        if (_ownsIcon) Win32.DestroyIcon(_icon);
        Win32.DestroyWindow(_hwnd);
        Win32.PostQuitMessage(0);
    }

    // ------------------------------------------------------------------ any thread

    /// <summary>Removes the icon and ends the tray thread (waits up to two seconds for it).</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        if (_hwnd != IntPtr.Zero) Win32.PostMessageW(_hwnd, ShutdownMessage, IntPtr.Zero, IntPtr.Zero);
        if (Thread.CurrentThread != _thread && !_thread.Join(TimeSpan.FromSeconds(2)))
            _log?.LogWarning("tray: the tray thread did not end within 2 s (Explorer busy?); exiting without waiting");
    }
}
