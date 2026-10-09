using Ivy.Collectors.Abstractions;

namespace Ivy.Collectors.Host;

/// <summary>
/// Platform implementations. The Win32 ones are compiled only into the <c>net8.0-windows10.0.19041.0</c>
/// target (<c>#if WINDOWS</c>) and only returned when running on Windows; the plain <c>net8.0</c> build
/// (macOS tests) returns null, and the affected collectors report themselves as unsupported/fallback.
/// </summary>
public static class PlatformServices
{
    public static IUsnJournal? CreateUsnJournal()
    {
#if WINDOWS
        if (OperatingSystem.IsWindows()) return new Windows.WindowsUsnJournal();
#endif
        return null;
    }

    public static IForegroundWindowProbe? CreateForegroundProbe()
    {
#if WINDOWS
        if (OperatingSystem.IsWindows()) return new Windows.WindowsForegroundWindowProbe();
#endif
        return null;
    }

    /// <summary>True when this assembly was built with the Win32 implementations.</summary>
    public static bool HasWindowsImplementations =>
#if WINDOWS
        true;
#else
        false;
#endif
}
