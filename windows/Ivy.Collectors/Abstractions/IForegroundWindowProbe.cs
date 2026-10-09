namespace Ivy.Collectors.Abstractions;

/// <summary>What is in the foreground right now. <see cref="Exe"/> is the executable file name (e.g. <c>chrome.exe</c>).</summary>
public sealed record ForegroundSample(string App, string? Exe, string? Title);

/// <summary>Windows: GetForegroundWindow / GetWindowThreadProcessId / QueryFullProcessImageName / GetLastInputInfo.</summary>
public interface IForegroundWindowProbe
{
    /// <summary>The foreground window, or null when there is none (locked workstation, desktop).</summary>
    ForegroundSample? Sample();

    /// <summary>Time since the last keyboard/mouse input.</summary>
    TimeSpan IdleTime();
}
