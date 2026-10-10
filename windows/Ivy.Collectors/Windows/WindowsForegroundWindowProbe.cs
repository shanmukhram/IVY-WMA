#if WINDOWS
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Usage;
using static Ivy.Collectors.Windows.NativeMethods;

namespace Ivy.Collectors.Windows;

/// <summary>
/// GetForegroundWindow → GetWindowThreadProcessId → OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) →
/// QueryFullProcessImageName; friendly name from the exe's FileDescription (cached). UWP apps run inside
/// ApplicationFrameHost.exe, so for those the first child window owned by another process is used.
/// Idle time from GetLastInputInfo. The title goes through <see cref="ForegroundTitleReader"/>: never a
/// blocking WM_GETTEXT, and never to IVY's own windows. NOT VERIFIED ON macOS: compiled for the Windows target only.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsForegroundWindowProbe : IForegroundWindowProbe
{
    private readonly Dictionary<string, string> _friendly = new(StringComparer.OrdinalIgnoreCase);
    private readonly ForegroundTitleReader _titles = new(new TimeoutWindowTextSource());

    public ForegroundSample? Sample()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0) return null;
        var title = _titles.Title(hwnd, pid);
        var exePath = ImagePath(pid);
        if (exePath is not null && Path.GetFileName(exePath).Equals("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase))
        {
            var childPid = ChildProcessOf(hwnd, pid);
            if (childPid != 0 && ImagePath(childPid) is { } inner) exePath = inner;
        }
        var exe = exePath is null ? null : Path.GetFileName(exePath);
        var app = exePath is null ? (exe ?? $"pid {pid}") : FriendlyName(exePath);
        return new ForegroundSample(app, exe, string.IsNullOrEmpty(title) ? null : title);
    }

    public TimeSpan IdleTime()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return TimeSpan.Zero;
        var elapsed = unchecked(GetTickCount() - info.dwTime); // both wrap at 49.7 days; unsigned subtraction handles it
        return TimeSpan.FromMilliseconds(elapsed);
    }

    /// <summary>WM_GETTEXTLENGTH then WM_GETTEXT, each through SendMessageTimeout(SMTO_ABORTIFHUNG).</summary>
    private sealed class TimeoutWindowTextSource : IWindowTextSource
    {
        private const int MaxChars = 4096;

        public string? ReadTitle(IntPtr hwnd, TimeSpan timeout)
        {
            var ms = (uint)Math.Max(1, timeout.TotalMilliseconds);
            if (SendMessageTimeoutW(hwnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, ms, out var lenResult) == IntPtr.Zero) return null;
            var len = (int)Math.Min(lenResult.ToInt64(), MaxChars);
            if (len <= 0) return null;
            var buf = new char[len + 1];
            if (SendMessageTimeoutW(hwnd, WM_GETTEXT, (IntPtr)buf.Length, buf, SMTO_ABORTIFHUNG, ms, out var copied) == IntPtr.Zero) return null;
            var n = (int)Math.Clamp(copied.ToInt64(), 0, len);
            return n > 0 ? new string(buf, 0, n) : null;
        }
    }

    private static string? ImagePath(uint pid)
    {
        using var h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h.IsInvalid) return null;
        var buf = new char[32768];
        var size = buf.Length;
        return QueryFullProcessImageNameW(h, 0, buf, ref size) ? new string(buf, 0, size) : null;
    }

    private static uint ChildProcessOf(IntPtr hwnd, uint hostPid)
    {
        uint found = 0;
        EnumChildWindows(hwnd, (child, _) =>
        {
            GetWindowThreadProcessId(child, out var p);
            if (p != 0 && p != hostPid) { found = p; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private string FriendlyName(string exePath)
    {
        if (_friendly.TryGetValue(exePath, out var name)) return name;
        try
        {
            var vi = FileVersionInfo.GetVersionInfo(exePath);
            name = !string.IsNullOrWhiteSpace(vi.FileDescription) ? vi.FileDescription.Trim()
                : !string.IsNullOrWhiteSpace(vi.ProductName) ? vi.ProductName.Trim()
                : Path.GetFileNameWithoutExtension(exePath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or FileNotFoundException)
        {
            name = Path.GetFileNameWithoutExtension(exePath);
        }
        if (_friendly.Count > 2000) _friendly.Clear();
        _friendly[exePath] = name;
        return name;
    }
}
#endif
