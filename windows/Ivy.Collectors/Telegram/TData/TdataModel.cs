namespace Ivy.Collectors.Telegram.TData;

/// <summary>
/// One logged-in Telegram account recovered from <c>tdata</c>: its user id, the main data-centre id and the
/// MTProto auth key per DC. The auth keys are raw secret material (256 bytes each); they live only in memory
/// and are never serialized to the queue, logged, or uploaded (WX2).
/// </summary>
public sealed class TelegramAccount
{
    public required long UserId { get; init; }
    public required int MainDcId { get; init; }

    /// <summary>DC id → 256-byte MTProto auth key. The client connects to <see cref="MainDcId"/> using its key.</summary>
    public required IReadOnlyDictionary<int, byte[]> AuthKeys { get; init; }

    /// <summary>The index tdesktop assigned this account (0 is the first/primary).</summary>
    public required int Index { get; init; }

    public byte[] MainAuthKey => AuthKeys.TryGetValue(MainDcId, out var k)
        ? k
        : throw new TdataFormatException($"no auth key for main dc {MainDcId}");
}

/// <summary>All accounts tdesktop has signed in, plus which one is active.</summary>
public sealed class TdataAccounts
{
    public required IReadOnlyList<TelegramAccount> Accounts { get; init; }
    public required int ActiveIndex { get; init; }

    public TelegramAccount Active =>
        Accounts.FirstOrDefault(a => a.Index == ActiveIndex)
        ?? Accounts.FirstOrDefault()
        ?? throw new TdataFormatException("no accounts in tdata");
}
