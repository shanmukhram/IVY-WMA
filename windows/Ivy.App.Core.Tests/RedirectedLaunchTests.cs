namespace Ivy.App.Core.Tests;

/// <summary>Whether the running tray instance shows its window when a second launch is redirected to it.</summary>
public class RedirectedLaunchTests
{
    [Theory]
    [InlineData("\"C:\\Users\\b\\AppData\\Local\\IVY\\app\\Ivy.App.exe\" --minimized")] // the Run-key value
    [InlineData("\"C:\\Program Files\\IVY\\Ivy.App.exe\" --MINIMIZED")]
    [InlineData("--minimized")]                                                     // arguments without the exe
    [InlineData("C:\\ivy\\Ivy.App.exe --minimized")]
    public void Run_key_launch_keeps_the_window_hidden(string commandLine)
    {
        Assert.False(StartupCommand.ShouldShowWindowOnRedirect(commandLine));
    }

    [Theory]
    [InlineData("\"C:\\Users\\b\\AppData\\Local\\IVY\\app\\Ivy.App.exe\"")] // double-click on the exe
    [InlineData("C:\\ivy\\Ivy.App.exe")]
    [InlineData("")]
    [InlineData("\"C:\\a folder --minimized\\Ivy.App.exe\"")]               // the switch inside a quoted path is not the switch
    [InlineData("\"C:\\ivy\\Ivy.App.exe\" --minimizedx")]
    [InlineData(null)]                                                       // not a plain launch
    public void Other_launches_show_the_window(string? commandLine)
    {
        Assert.True(StartupCommand.ShouldShowWindowOnRedirect(commandLine));
    }
}
