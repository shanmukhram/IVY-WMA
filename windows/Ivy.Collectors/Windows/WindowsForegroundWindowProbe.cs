#if WINDOWS
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Ivy.Collectors.Abstractions;
using static Ivy.Collectors.Windows.NativeMethods;

namespace Ivy.Collectors.Windows;

/// <summary>
/// GetForegroundWindow → GetWindowThreadProcessId → OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) →
/// QueryFullProcessImageName; friendly name from the exe's FileDescription (cached). UWP apps run inside
/// ApplicationFrameHost.exe, so for those the first child window owned by another process is used.
/// Idle time from GetLastInputInfo. NOT VERIFIED ON macOS: compiled for the Windows target only.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsForegroundWindowProbe : IForegroundWindowProbe
{
    private readonly Dictionary<string, string> _friendly = new(StringComparer.OrdinalIgnoreCase);

    public ForegroundSample? Sample()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        var title = WindowTitle(hwnd);
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0) return null;
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

    private static string? WindowTitle(IntPtr hwnd)
    {
        var len = GetWindowTextLengthW(hwnd);
        if (len <= 0) return null;
        var buf = new char[len + 1];
        var n = GetWindowTextW(hwnd, buf, buf.Length);
        return n > 0 ? new string(buf, 0, n) : null;
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
