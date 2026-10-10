namespace Ivy.Collectors.Telegram;

/// <summary>
/// Telegram collector settings (camelCase on the wire, via <c>collector_config.settings</c> and the Windows
/// app). Unknown keys are rejected (see <c>SettingsJson</c>), so a typo is an error, not a silent no-op.
/// </summary>
public sealed class TelegramSettings
{
    /// <summary>Explicit <c>tdata</c> path. Null = auto-detect (%APPDATA%\Telegram Desktop\tdata, then portable).</summary>
    public string? TdataPath { get; set; }

    /// <summary>Include channels the user is in (WT1). Groups and DMs are always included.</summary>
    public bool IncludeChannels { get; set; } = true;

    /// <summary>Messages per <c>messages.getHistory</c> page (Telegram allows up to 100).</summary>
    public int HistoryPageSize { get; set; } = 100;

    /// <summary>History pages fetched per tick, to bound work and respect flood limits during the first backfill.</summary>
    public int HistoryPagesPerTick { get; set; } = 50;

    // Media policy (PLAN decision 8), applied to attachments.
    public bool AutoUploadImages { get; set; } = true;
    public int ImageCapMB { get; set; } = 25;
    public bool AutoUploadDocuments { get; set; } = true;
    public int DocumentCapMB { get; set; } = 10;

    /// <summary>Cap on attachment-original bytes auto-downloaded per tick, so bulk media never starves the index.</summary>
    public long OriginalsBytesPerTick { get; set; } = 64L * 1024 * 1024;

    public long ImageCapBytes => (long)ImageCapMB * 1024 * 1024;
    public long DocumentCapBytes => (long)DocumentCapMB * 1024 * 1024;
}
