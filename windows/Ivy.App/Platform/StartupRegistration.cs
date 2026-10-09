using System.Runtime.Versioning;
using Ivy.App.Core;
using Microsoft.Win32;

namespace Ivy.App.Platform;

/// <summary>Run at login through HKCU\Software\Microsoft\Windows\CurrentVersion\Run (PRD WP2). Per user; no elevation.</summary>
[SupportedOSPlatform("windows")]
internal sealed class RegistryStartupRegistration : IStartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public string? RegisteredCommand()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
        return key?.GetValue(StartupCommand.ValueName) as string;
    }

    public void Register(string command)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        key.SetValue(StartupCommand.ValueName, command, RegistryValueKind.String);
    }

    public void Unregister()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        key?.DeleteValue(StartupCommand.ValueName, throwOnMissingValue: false);
    }
}
