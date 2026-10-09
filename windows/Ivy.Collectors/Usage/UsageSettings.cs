namespace Ivy.Collectors.Usage;

/// <summary>Settings for the <c>usage</c> collector (WC4).</summary>
public sealed class UsageSettings
{
    public double SampleSeconds { get; init; } = 30;

    /// <summary>Window titles can carry content, so capture is a setting (default on, PRD WC4).</summary>
    public bool CaptureTitles { get; init; } = true;

    /// <summary>
    /// Title exclusions: a pattern with <c>*</c>/<c>?</c> is a case-insensitive glob over the whole title or
    /// exe; otherwise a case-insensitive substring of the title or exe. A match records the title as absent.
    /// </summary>
    public IReadOnlyList<string> TitleExclusions { get; init; } = new[] { "InPrivate", "Incognito", "Private Browsing", "KeePass*", "1Password*", "Bitwarden*" };

    /// <summary>Close the current event after this much keyboard/mouse inactivity.</summary>
    public double IdleMinutes { get; init; } = 5;

    /// <summary>Long sessions are flushed as an event this often (a new event continues the session).</summary>
    public double MaxEventMinutes { get; init; } = 10;
}
