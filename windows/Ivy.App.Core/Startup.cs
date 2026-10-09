namespace Ivy.App.Core;

/// <summary>Run-at-login registration (HKCU\Software\Microsoft\Windows\CurrentVersion\Run on Windows).</summary>
public interface IStartupRegistration
{
    /// <summary>The registered command line, or null when not registered.</summary>
    string? RegisteredCommand();
    void Register(string command);
    void Unregister();
}

public static class StartupCommand
{
    public const string ValueName = "IVY";
    public const string MinimizedSwitch = "--minimized";

    /// <summary>The Run-key value: the quoted exe path and the switch that starts hidden in the tray.</summary>
    public static string Build(string exePath) => "\"" + exePath + "\" " + MinimizedSwitch;

    /// <summary>True when <paramref name="registered"/> launches <paramref name="exePath"/> (case-insensitive, quotes optional).</summary>
    public static bool PointsAt(string? registered, string exePath)
    {
        if (string.IsNullOrWhiteSpace(registered)) return false;
        var s = registered.Trim();
        string path;
        if (s.StartsWith('"'))
        {
            var end = s.IndexOf('"', 1);
            path = end < 0 ? s[1..] : s[1..end];
        }
        else
        {
            var sp = s.IndexOf(' ');
            path = sp < 0 ? s : s[..sp];
        }
        return string.Equals(path, exePath, StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsMinimizedLaunch(IEnumerable<string> args) =>
        args.Any(a => string.Equals(a, MinimizedSwitch, StringComparison.OrdinalIgnoreCase));
}
