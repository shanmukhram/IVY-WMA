namespace Ivy.Collectors.Notifications;

/// <summary>Settings for the <c>notifications</c> collector (WC5).</summary>
public sealed class NotificationSettings
{
    /// <summary>Path to <c>wpndatabase.db</c>; null = <c>%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db</c>.</summary>
    public string? DatabasePath { get; init; }

    public double PollSeconds { get; init; } = 60;

    /// <summary>Notifications read per poll.</summary>
    public int BatchSize { get; init; } = 500;

    /// <summary>Handler PrimaryIds (app ids) to skip; case-insensitive substring.</summary>
    public IReadOnlyList<string> ExcludedApps { get; init; } = Array.Empty<string>();

    public static string DefaultDatabasePath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Windows", "Notifications", "wpndatabase.db");
}
