namespace Ivy.Collectors.Telegram.Client;

/// <summary>
/// The <c>api_id</c>/<c>api_hash</c> an MTProto client presents. To reuse Telegram Desktop's existing session
/// and have Telegram list IVY as the same active session (not a new client), the client must present
/// Telegram Desktop's own public constants (WT1/WT2). These ship in the open-source tdesktop tree
/// (<c>TELEGRAM_API_ID</c>/<c>TELEGRAM_API_HASH</c>); they are not secret, but the real values must be set
/// for the production build and confirmed on the PC, which is why they are left as a required configuration
/// rather than hard-coded placeholders that would silently present as a different client.
/// </summary>
public sealed record TelegramApiCredentials(int ApiId, string ApiHash)
{
    /// <summary>
    /// The desktop client's own constants, filled in for the real build. Left unset here so a wrong value is
    /// never shipped by accident; the collector works against the fake client without them.
    /// </summary>
    public static TelegramApiCredentials? DesktopDefault { get; set; } =
        // Telegram Desktop's own public constants, from the open-source tdesktop tree
        // (Telegram/SourceFiles/config.h: ApiId / ApiHash, now the TDESKTOP_API_ID / TDESKTOP_API_HASH build
        // defaults). Set on the PC in the third Windows run; the "no new session in Settings > Devices" check
        // is still pending because no Telegram Desktop install was available on that PC.
        new(2040, "b18441a1ff607e10a989891a5462e627");
}
