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

    /// <summary>
    /// For a second launch redirected to the running instance: true when the running instance should show its window.
    /// <paramref name="commandLine"/> is the redirected launch's full command line (exe path included, as
    /// AppLifecycle reports it), or null when it was not a plain launch (then the window is shown). A Run-key
    /// launch (<c>--minimized</c>) leaves the tray instance hidden; a double-click on the exe brings the window up.
    /// </summary>
    public static bool ShouldShowWindowOnRedirect(string? commandLine) =>
        commandLine is null || !IsMinimizedLaunch(SplitArgs(commandLine));

    /// <summary>Whitespace-separated tokens with double quotes grouping (enough to find a switch; not a full CommandLineToArgvW).</summary>
    private static IEnumerable<string> SplitArgs(string commandLine)
    {
        var current = new System.Text.StringBuilder();
        var quoted = false;
        foreach (var c in commandLine)
        {
            if (c == '"') { quoted = !quoted; continue; }
            if (char.IsWhiteSpace(c) && !quoted)
            {
                if (current.Length > 0) { yield return current.ToString(); current.Clear(); }
                continue;
            }
            current.Append(c);
        }
        if (current.Length > 0) yield return current.ToString();
    }
}
