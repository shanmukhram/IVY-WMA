namespace Ivy.Collectors.Line;

/// <summary>
/// LINE desktop collector settings (editable via <c>collector_config</c>, WR3): a data-folder override and a
/// one-shot "run probe" request, plus poll/batch sizing and the reported LINE version.
/// </summary>
public sealed class LineSettings
{
    /// <summary>Override for the LINE data folder; null = the auto-detected locations (NOTES.md).</summary>
    public string? DataPath { get; init; }

    /// <summary>Set true to run the probe (PRD WL1) on the next tick; the collector clears it after running.</summary>
    public bool RunProbe { get; init; }

    /// <summary>The installed LINE for Windows version, if known; drives map selection and re-verification.</summary>
    public string? Version { get; init; }

    /// <summary>
    /// The account label put on every LINE record (part of the WX1 merge key). Left at "default", the collector
    /// labels records with the open store's own account id (the own-profile mid, or the store file's
    /// <c>qw&lt;hex&gt;</c> name if the mid cannot be read), so two LINE accounts used on this PC stay apart.
    /// Any other value set here is used as the label as is. Cursors are kept per store either way.
    /// </summary>
    public string Account { get; init; } = "default";

    /// <summary>Messages read per chat per tick.</summary>
    public int BatchSize { get; init; } = 500;

    /// <summary>Seconds between polls. Kept to a few seconds so a new message shows up almost at once; each tick snapshots and reads the small store.</summary>
    public int PollSeconds { get; init; } = 5;
}
