namespace Ivy.Collectors.Telegram.Client;

/// <summary>The session the client acts as: the user id, the main DC, and the per-DC MTProto auth keys.</summary>
public sealed record TelegramSession(long UserId, int MainDcId, IReadOnlyDictionary<int, byte[]> AuthKeys);

public enum TgConvKind { Dm, Group }

/// <summary>Chat metadata as the platform reports it (maps to <c>message_batch.chatMeta</c>).</summary>
public sealed record TgChatMeta(string? Title, int? ParticipantCount, string ChatType);

/// <summary>
/// One dialog (chat/contact/group/channel) the user is in. <see cref="ConvKey"/> is stable across runs and
/// across sources, so the Mac can merge copies (WX1); it is the platform's peer identity, e.g.
/// <c>user:123</c>, <c>chat:456</c>, <c>channel:789</c>. <see cref="Archived"/> is true when the owner moved
/// the chat to Telegram's Archive folder (the dialog's <c>folder_id</c> is 1).
/// </summary>
public sealed record TgDialog(
    string ConvKey,
    TgConvKind ConvKind,
    string? Peer,
    TgChatMeta Meta,
    long TopMessageId,
    bool IsChannel,
    string? AvatarRef = null,
    bool Archived = false);

public enum TgAttachmentKind { Image, Video, Audio, Doc }

/// <summary>
/// An attachment reference. <see cref="FileRef"/> is an opaque, stable handle the client can later resolve
/// to bytes (used both for the media-policy auto-download and for an on-request <c>file_request</c>).
/// </summary>
public sealed record TgAttachment(
    string AttId,
    TgAttachmentKind Kind,
    string Filename,
    long Size,
    string? OriginHash,
    string FileRef);

/// <summary>One message as the session sees it in the cloud.</summary>
public sealed record TgMessage(
    long MsgId,
    string Sender,
    DateTimeOffset SentAt,
    string Text,
    long? ReplyTo = null,
    DateTimeOffset? EditedAt = null,
    string? ForwardedFrom = null,
    string? MediaKind = null,
    bool Deleted = false,
    DateTimeOffset? DeletedAt = null,
    IReadOnlyList<TgAttachment>? Attachments = null,
    bool FromMe = false,
    string? SenderName = null)
{
    public IReadOnlyList<TgAttachment> Files => Attachments ?? Array.Empty<TgAttachment>();
}

/// <summary>A page of history, newest first, as returned by <c>messages.getHistory</c> paging.</summary>
public sealed record TgHistoryPage(IReadOnlyList<TgMessage> Messages, bool HasMore);

public enum TgChange { Added, Edited, Deleted }

/// <summary>One incremental change to a conversation (new message, edit, or deletion).</summary>
public sealed record TgMessageUpdate(string ConvKey, TgChange Change, TgMessage Message);

/// <summary>
/// The result of <c>updates.getDifference</c>: the changes since the last state token and a new token.
/// <see cref="More"/> is true when the server has more to give immediately (the collector pages again).
/// <see cref="DialogsChanged"/> is true when a chat moved into or out of a folder (archive/unarchive), so the
/// collector re-lists dialogs on its next tick.
/// </summary>
public sealed record TgDifference(IReadOnlyList<TgMessageUpdate> Updates, string NewState, bool More, bool DialogsChanged = false);

/// <summary>Thrown on Telegram's <c>FLOOD_WAIT_X</c>: the caller must wait <see cref="Seconds"/> before retrying.</summary>
public sealed class FloodWaitException : Exception
{
    public FloodWaitException(int seconds) : base($"FLOOD_WAIT {seconds}s") => Seconds = seconds;
    public int Seconds { get; }
}

/// <summary>Thrown when the session's auth key is no longer valid (logged out elsewhere, AUTH_KEY_UNREGISTERED).</summary>
public sealed class SessionInvalidException : Exception
{
    public SessionInvalidException(string message) : base(message) { }
}

/// <summary>
/// The MTProto surface the Telegram collector drives. The real implementation starts from the raw auth key
/// extracted from <c>tdata</c> (no login); tests drive a scripted fake. Keeping the client behind this
/// interface is what lets everything build and test on macOS with no Telegram install.
/// </summary>
public interface ITelegramClient : IAsyncDisposable
{
    /// <summary>Attach to Telegram using the extracted session. Throws <see cref="SessionInvalidException"/> if rejected.</summary>
    Task ConnectAsync(TelegramSession session, CancellationToken ct);

    /// <summary>Every dialog the user is in. Channels are included only when <paramref name="includeChannels"/>.</summary>
    Task<IReadOnlyList<TgDialog>> GetDialogsAsync(bool includeChannels, CancellationToken ct);

    /// <summary>
    /// A page of history for <paramref name="dialog"/>, messages with id &lt; <paramref name="offsetId"/>
    /// (0 = from the latest), newest first, up to <paramref name="limit"/> (<c>messages.getHistory</c>).
    /// </summary>
    Task<TgHistoryPage> GetHistoryAsync(TgDialog dialog, long offsetId, int limit, CancellationToken ct);

    /// <summary>Changes since <paramref name="stateToken"/> (null = from now): new messages, edits, deletions.</summary>
    Task<TgDifference> GetDifferenceAsync(string? stateToken, CancellationToken ct);

    /// <summary>Open the attachment original for reading, or null if it is gone. Used for media policy and file_request.</summary>
    Task<Stream?> DownloadAsync(string fileRef, CancellationToken ct);
    /// <summary>Download the small profile photo named by <paramref name="avatarRef"/> (from a dialog), or null.</summary>
    Task<Stream?> DownloadAvatarAsync(string avatarRef, CancellationToken ct);

    /// <summary>Secret-chat identifiers detected on this session: reported as phone-only in status, never as records (WT3).</summary>
    IReadOnlyList<string> SecretChats { get; }
}
