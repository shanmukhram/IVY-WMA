namespace Ivy.Collectors.Telegram.Client;

/// <summary>
/// The production data-centre addresses Telegram publishes (the same list Telegram Desktop and every MTProto
/// client ship as a bootstrap). They are not secret; the server returns the authoritative <c>dc_options</c> on
/// the first <c>help.getConfig</c>, so this table only has to get the client connected to the DC that holds the
/// account's auth key. An imported session carries the main DC id but no address, so this seeds one.
/// </summary>
public static class TelegramDcEndpoints
{
    /// <summary>DC id → (ipv4, port). Ports are always 443.</summary>
    public static readonly IReadOnlyDictionary<int, (string Ip, int Port)> Production = new Dictionary<int, (string, int)>
    {
        [1] = ("149.154.175.53", 443),
        [2] = ("149.154.167.51", 443),
        [3] = ("149.154.175.100", 443),
        [4] = ("149.154.167.91", 443),
        [5] = ("91.108.56.130", 443),
    };

    public static (string Ip, int Port) ForDc(int dcId) =>
        Production.TryGetValue(dcId, out var e) ? e : Production[2];
}
