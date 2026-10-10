namespace Ivy.Collectors.Line;

/// <summary>How the store for a given LINE version is protected (PRD WL1, source map "Keys").</summary>
public enum LineKeyStrategy
{
    /// <summary>The db file is a plain SQLite file (header <c>SQLite format 3\0</c>); read it directly.</summary>
    PlainSqlite,

    /// <summary>
    /// wxSQLite3 / SQLite3 Multiple Ciphers, AES-128-CBC, passphrase key (NOTES.md). We do not ship a key
    /// deriver: the <see cref="ILineStoreUnlocker"/> default is <see cref="NotImplementedUnlocker"/>.
    /// </summary>
    EncryptedWxSqlite3Aes128Cbc,

    /// <summary>Protection is unknown for this version; always red until a probe tells us.</summary>
    Unknown,
}

/// <summary>Columns of the message table, named per LINE version (PRD WL1: pinned per version).</summary>
public sealed record LineMessageColumns
{
    public required string Table { get; init; }
    /// <summary>Platform message id (emitted as <c>msgId</c>). Must be the store's own id, never invented.</summary>
    public required string MsgId { get; init; }
    public required string ChatId { get; init; }
    public required string Sender { get; init; }
    /// <summary>Send time column; interpreted per <see cref="LineStoreMap.TimeUnit"/>.</summary>
    public required string SentAt { get; init; }
    public required string Text { get; init; }
    /// <summary>Optional: integer content-type column (0 text, 1 image, ...); null when the version has none.</summary>
    public string? ContentType { get; init; }
    /// <summary>Optional: JSON metadata column holding attachment file names/urls.</summary>
    public string? ContentMetadata { get; init; }

    public IEnumerable<string> Required()
    {
        yield return MsgId;
        yield return ChatId;
        yield return Sender;
        yield return SentAt;
        yield return Text;
        if (ContentType is not null) yield return ContentType;
        if (ContentMetadata is not null) yield return ContentMetadata;
    }
}

/// <summary>Columns of the chat table.</summary>
public sealed record LineChatColumns
{
    public required string Table { get; init; }
    public required string ChatId { get; init; }

    public IEnumerable<string> Required()
    {
        yield return ChatId;
    }
}

/// <summary>Optional name-resolution tables (group/square/room/contact), used only when present.</summary>
public sealed record LineNameTables
{
    public string? GroupTable { get; init; }
    public string? GroupChatId { get; init; }
    public string? GroupName { get; init; }
    public string? SquareTable { get; init; }
    public string? SquareChatId { get; init; }
    public string? SquareName { get; init; }
    public string? RoomTable { get; init; }
    public string? RoomChatId { get; init; }
    public string? ContactTable { get; init; }
    public string? ContactMid { get; init; }
    public string? ContactDisplayName { get; init; }
}

/// <summary>Units for the message time column.</summary>
public enum LineTimeUnit { UnixMilliseconds, UnixSeconds }

/// <summary>
/// A declarative mapping from a LINE for Windows version to its store layout (PRD WL1). The collector
/// never assumes this is correct: it verifies the map against the real snapshot and only reads when
/// verification passes (WL3). Ship a map with <see cref="Verified"/> = false so it is used only after
/// on-PC verification. Timestamp/column/table drift between versions is the expected failure, not a crash.
/// </summary>
public sealed record LineStoreMap
{
    /// <summary>The LINE for Windows version this map targets (e.g. "26.3"); "*" means "best effort for any".</summary>
    public required string Version { get; init; }

    /// <summary>
    /// False until a human has confirmed this map against a real store. A map with <c>Verified = false</c>
    /// is still verified against the live snapshot on every run; the flag records whether *we* have ever
    /// seen it match reality, and is surfaced ("unverified map") in the UI (AC2a drift discipline).
    /// </summary>
    public bool Verified { get; init; }

    /// <summary>Glob for the db file inside the LINE data folder (e.g. <c>*.edb</c>).</summary>
    public required string DbFilePattern { get; init; }

    public required LineKeyStrategy KeyStrategy { get; init; }

    /// <summary>
    /// The fixed leading bytes (hex) of this version's encrypted store, as seen by the probe. The real LINE
    /// for Windows store shares a fixed magic across all its <c>.edb</c> files, so a container format with a
    /// header rather than a per-file-random scheme. Null for a plain-SQLite map. Used only to recognise the
    /// store and report precisely; it is not a key.
    /// </summary>
    public string? EncryptedHeaderMagicHex { get; init; }

    public required LineMessageColumns Messages { get; init; }
    public required LineChatColumns Chats { get; init; }
    public LineNameTables? Names { get; init; }
    public LineTimeUnit TimeUnit { get; init; } = LineTimeUnit.UnixMilliseconds;

    /// <summary>
    /// The shipped starting point for the current LINE for Windows version (NOTES.md). Marked
    /// <c>Verified = false</c>: used only after on-PC verification passes (WL3). Schema from the publicly
    /// reported LINE PC layout; treated as a hypothesis, re-checked against the real store every run.
    /// </summary>
    public static LineStoreMap ShippedDefault { get; } = new()
    {
        Version = "26.5",
        Verified = false,
        DbFilePattern = "*.edb",
        // The store is a container with a fixed magic (probe report docs/reports/line-probe-26.5-windows.json)
        // whose WAL sidecar carries the standard SQLite WAL magic, so SQLite pages under a page cipher. With no
        // key available on disk, an encrypted store yields an honest state and the full history comes from the
        // phone; a plain store (older builds) is detected by its header at runtime and read.
        KeyStrategy = LineKeyStrategy.EncryptedWxSqlite3Aes128Cbc,
        EncryptedHeaderMagicHex = "ea8ac8444445429a",
        Messages = new LineMessageColumns
        {
            Table = "_message",
            MsgId = "_id",
            ChatId = "_chatId",
            Sender = "_from",
            SentAt = "_createdTime",
            Text = "_text",
            ContentType = "_contentType",
            ContentMetadata = "_contentMetadata",
        },
        Chats = new LineChatColumns { Table = "_chat", ChatId = "_id" },
        Names = new LineNameTables
        {
            GroupTable = "_groupChat",
            GroupChatId = "_chatMid",
            GroupName = "_chatName",
            SquareTable = "_squareChat",
            SquareChatId = "_squareChatMid",
            SquareName = "_name",
            RoomTable = "_room",
            RoomChatId = "_mid",
            ContactTable = "_contact",
            ContactMid = "_mid",
            ContactDisplayName = "_displayName",
        },
        TimeUnit = LineTimeUnit.UnixMilliseconds,
    };

    /// <summary>Content-type ids to the platform media-kind name (NOTES.md); unknown → null (plain text).</summary>
    public static string? MediaKindFor(long? contentType) => contentType switch
    {
        null or 0 => null,
        1 => "image",
        2 => "video",
        3 => "audio",
        6 => "location",
        7 => "sticker",
        13 => "contact",
        14 => "file",
        16 => "link",
        _ => "other",
    };

    /// <summary>Protocol attachment kind (image|video|audio|doc) for a content type; null = no attachment.</summary>
    public static string? AttachmentKindFor(long? contentType) => contentType switch
    {
        1 => "image",
        2 => "video",
        3 => "audio",
        14 => "doc",
        _ => null,
    };
}
