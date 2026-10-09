using System.Runtime.InteropServices;

namespace Ivy.App.Platform;

/// <summary>One tray menu entry; <see cref="Text"/> null means a separator.</summary>
internal sealed record TrayMenuItem(string? Text, Action? OnClick = null, bool Enabled = true)
{
    public static readonly TrayMenuItem Separator = new(Text: null);
}

/// <summary>
/// Notification-area icon via Shell_NotifyIcon. A hidden top-level window on the UI thread receives the
/// callback messages (the WinUI message loop dispatches them), so handlers run on the UI thread. Left click
/// opens the window; right click shows a native popup menu built fresh each time (so labels such as
/// Pause/Resume are current). Re-adds itself when Explorer restarts (TaskbarCreated).
/// </summary>
internal sealed class TrayIcon : IDisposable
{
    private const string ClassName = "IvyTrayIconWindow";
    private const uint CallbackMessage = Win32.WM_APP + 1;
    private const uint IconId = 1;
    private readonly Win32.WndProc _wndProc; // kept alive: native code holds a pointer to it
    private readonly IntPtr _hwnd;
    private readonly IntPtr _icon;
    private readonly bool _ownsIcon;
    private readonly uint _taskbarCreated;
    private readonly Action _onOpen;
    private readonly Func<IReadOnlyList<TrayMenuItem>> _menu;
    private readonly Action<Exception> _onError;
    private string _tooltip;
    private bool _added;
    private bool _disposed;

    public TrayIcon(string iconPath, string tooltip, Action onOpen, Func<IReadOnlyList<TrayMenuItem>> menu, Action<Exception> onError)
    {
        _tooltip = tooltip;
        _onOpen = onOpen;
        _menu = menu;
        _onError = onError;
        _wndProc = WndProc;
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
        Add();
    }

    public string Tooltip
    {
        get => _tooltip;
        set
        {
            _tooltip = value.Length > 127 ? value[..127] : value;
            if (!_added) return;
            var data = Data(Win32.NIF_TIP);
            Win32.Shell_NotifyIconW(Win32.NIM_MODIFY, ref data);
        }
    }

    private Win32.NOTIFYICONDATAW Data(uint flags) => new()
    {
        cbSize = (uint)Marshal.SizeOf<Win32.NOTIFYICONDATAW>(),
        hWnd = _hwnd,
        uID = IconId,
        uFlags = flags,
        uCallbackMessage = CallbackMessage,
        hIcon = _icon,
        szTip = _tooltip,
        szInfo = "",
        szInfoTitle = "",
    };

    private void Add()
    {
        var data = Data(Win32.NIF_MESSAGE | Win32.NIF_ICON | Win32.NIF_TIP);
        _added = Win32.Shell_NotifyIconW(Win32.NIM_ADD, ref data);
    }

    private IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (msg == CallbackMessage)
            {
                var evt = (uint)(lParam.ToInt64() & 0xFFFF);
                if (evt is Win32.WM_LBUTTONUP or Win32.WM_LBUTTONDBLCLK) _onOpen();
                else if (evt == Win32.WM_RBUTTONUP) ShowMenu();
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

    private void ShowMenu()
    {
        var items = _menu();
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
            if (cmd > 0 && cmd <= items.Count && items[cmd - 1] is { Enabled: true, OnClick: { } click }) click();
        }
        finally
        {
            Win32.DestroyMenu(menu);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_added)
        {
            var data = Data(0);
            Win32.Shell_NotifyIconW(Win32.NIM_DELETE, ref data);
            _added = false;
        }
        if (_ownsIcon) Win32.DestroyIcon(_icon);
        Win32.DestroyWindow(_hwnd);
    }
}
