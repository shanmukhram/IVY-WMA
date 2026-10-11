using System.Globalization;
using TL;

namespace Ivy.Collectors.Telegram.Client;

/// <summary>
/// Pure translation from WTelegramClient's TL types to the collector's domain types. Kept apart from the live
/// client so it is unit-tested on macOS with hand-built TL objects (no network). Nothing here talks to
/// Telegram; the live adapter supplies the TL objects and the peer→access-hash lookups.
/// </summary>
public static class TelegramTypeMapper
{
    public static string ConvKey(Peer peer) => peer switch
    {
        PeerUser u => "user:" + u.user_id.ToString(CultureInfo.InvariantCulture),
        PeerChat c => "chat:" + c.chat_id.ToString(CultureInfo.InvariantCulture),
        PeerChannel ch => "channel:" + ch.channel_id.ToString(CultureInfo.InvariantCulture),
        _ => "unknown",
    };

    public static TgConvKind ConvKindOf(Peer peer) => peer is PeerUser ? TgConvKind.Dm : TgConvKind.Group;

    /// <summary>Telegram's folder id for the Archive (<c>dialog.folder_id == 1</c>).</summary>
    public const int ArchiveFolderId = 1;

    /// <summary>
    /// Map one row of <c>messages.getDialogs</c>, or return null for a row that is not a chat: a
    /// <see cref="DialogFolder"/> is the collapsed "Archived chats" entry itself, and its chats come as their
    /// own <see cref="Dialog"/> rows with <c>folder_id</c> set.
    /// </summary>
    public static TgDialog? TryMapDialog(DialogBase dialogBase, IReadOnlyDictionary<long, User> users, IReadOnlyDictionary<long, ChatBase> chats) =>
        dialogBase is Dialog ? MapDialog(dialogBase, users, chats) : null;

    /// <summary>Map a dialog plus the peers that came with it into a domain <see cref="TgDialog"/>.</summary>
    public static TgDialog MapDialog(DialogBase dialogBase, IReadOnlyDictionary<long, User> users, IReadOnlyDictionary<long, ChatBase> chats)
    {
        var peer = dialogBase.Peer;
        var convKey = ConvKey(peer);
        string? title = null, peerName = null, chatType = null;
        int? participants = null;
        var isChannel = false;
        var kind = ConvKindOf(peer);

        switch (peer)
        {
            case PeerUser u when users.TryGetValue(u.user_id, out var user):
                title = DisplayName(user);
                peerName = user.MainUsername ?? title;
                chatType = "private";
                break;
            case PeerChat c when chats.TryGetValue(c.chat_id, out var chat):
                title = chat.Title;
                chatType = "group";
                participants = (chat as Chat)?.participants_count;
                break;
            case PeerChannel ch when chats.TryGetValue(ch.channel_id, out var chat):
                title = chat.Title;
                isChannel = chat.IsChannel;
                chatType = chat.IsChannel ? "channel" : "supergroup";
                participants = (chat as Channel)?.participants_count;
                break;
        }

        var meta = new TgChatMeta(title, participants, chatType ?? (kind == TgConvKind.Dm ? "private" : "group"));
        var avatarRef = AvatarRefOf(convKey, peer, users, chats);
        // folder_id is 0 when unset; 1 is the Archive folder.
        var archived = dialogBase is Dialog dialog && dialog.folder_id == ArchiveFolderId;
        return new TgDialog(convKey, kind, peerName, meta, dialogBase.TopMessage, isChannel, avatarRef, archived);
    }

    // A profile-photo handle the adapter can resolve: convKey, the photo id, and its dc. Null when there is no photo.
    private static string? AvatarRefOf(string convKey, Peer peer, IReadOnlyDictionary<long, User> users, IReadOnlyDictionary<long, ChatBase> chats)
    {
        long photoId = 0, dcId = 0;
        switch (peer)
        {
            case PeerUser u when users.TryGetValue(u.user_id, out var user) && user.photo is UserProfilePhoto upp:
                photoId = upp.photo_id; dcId = upp.dc_id; break;
            case PeerChat c when chats.TryGetValue(c.chat_id, out var chat) && (chat as Chat)?.photo is ChatPhoto cp:
                photoId = cp.photo_id; dcId = cp.dc_id; break;
            case PeerChannel ch when chats.TryGetValue(ch.channel_id, out var chat) && (chat as Channel)?.photo is ChatPhoto cpc:
                photoId = cpc.photo_id; dcId = cpc.dc_id; break;
        }
        return photoId != 0 ? $"{convKey}|{photoId}|{dcId}" : null;
    }

    private static string DisplayName(User user)
    {
        var name = string.Join(' ', new[] { user.first_name, user.last_name }.Where(s => !string.IsNullOrEmpty(s)));
        return name.Length > 0 ? name : user.MainUsername ?? user.id.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>Map one history/update message. Returns null for empties; service messages become text-less entries.</summary>
    public static TgMessage? MapMessage(MessageBase messageBase, IReadOnlyDictionary<long, User>? users = null)
    {
        if (messageBase is MessageEmpty) return null;
        if (messageBase is not Message m)
        {
            // MessageService (joins, title changes, ...): keep the slot so ids/cursors stay dense, no body.
            return new TgMessage(messageBase.ID, SenderOf(messageBase.From, messageBase.Peer), AsUtc(messageBase.Date), "");
        }
        var fromMe = m.flags.HasFlag(Message.Flags.out_);
        var senderName = ResolveSenderName(m.from_id, users);

        var attachments = MapMedia(m.media, m.id);
        return new TgMessage(
            MsgId: m.id,
            Sender: SenderOf(m.from_id, m.peer_id),
            SentAt: AsUtc(m.date),
            Text: m.message ?? "",
            ReplyTo: (m.reply_to as MessageReplyHeader)?.reply_to_msg_id is int rid and > 0 ? rid : null,
            EditedAt: m.edit_date == default ? null : AsUtc(m.edit_date),
            ForwardedFrom: ForwardedFrom(m.fwd_from),
            MediaKind: MediaKind(m.media),
            Deleted: false,
            DeletedAt: null,
            Attachments: attachments,
            FromMe: fromMe,
            SenderName: senderName);
    }

    private static string? ResolveSenderName(Peer? from, IReadOnlyDictionary<long, User>? users)
    {
        if (from is PeerUser pu && users is not null && users.TryGetValue(pu.user_id, out var u)) return DisplayName(u);
        return null;
    }

    private static string SenderOf(Peer? from, Peer? peer)
    {
        var p = from ?? peer;
        return p is null ? "" : p.ID.ToString(CultureInfo.InvariantCulture);
    }

    private static string? ForwardedFrom(MessageFwdHeader? fwd)
    {
        if (fwd is null) return null;
        if (!string.IsNullOrEmpty(fwd.from_name)) return fwd.from_name;
        return fwd.from_id?.ID.ToString(CultureInfo.InvariantCulture);
    }

    private static DateTimeOffset AsUtc(DateTime dt) =>
        new(DateTime.SpecifyKind(dt == default ? DateTime.UnixEpoch : dt, DateTimeKind.Utc));

    public static string? MediaKind(MessageMedia? media) => media switch
    {
        MessageMediaPhoto => "photo",
        MessageMediaDocument d when d.document is Document doc => DocumentKind(doc) switch
        {
            TgAttachmentKind.Video => "video",
            TgAttachmentKind.Audio => "audio",
            TgAttachmentKind.Image => "photo",
            _ => "document",
        },
        null => null,
        _ => "other",
    };

    private static IReadOnlyList<TgAttachment>? MapMedia(MessageMedia? media, int msgId)
    {
        switch (media)
        {
            case MessageMediaPhoto { photo: Photo photo }:
            {
                var largest = photo.LargestPhotoSize;
                var reference = new TelegramAttachmentRef('p', photo.id, photo.access_hash, photo.dc_id,
                    largest?.FileSize ?? 0, largest?.Type ?? "", photo.file_reference ?? Array.Empty<byte>());
                return new[]
                {
                    new TgAttachment(
                        AttId: msgId.ToString(CultureInfo.InvariantCulture) + ":" + photo.id.ToString(CultureInfo.InvariantCulture),
                        Kind: TgAttachmentKind.Image,
                        Filename: "photo_" + photo.id.ToString(CultureInfo.InvariantCulture) + ".jpg",
                        Size: largest?.FileSize ?? 0,
                        OriginHash: null,
                        FileRef: reference.Encode()),
                };
            }
            case MessageMediaDocument { document: Document doc }:
            {
                var kind = DocumentKind(doc);
                var reference = new TelegramAttachmentRef('d', doc.id, doc.access_hash, doc.dc_id, doc.size, null,
                    doc.file_reference ?? Array.Empty<byte>());
                return new[]
                {
                    new TgAttachment(
                        AttId: msgId.ToString(CultureInfo.InvariantCulture) + ":" + doc.id.ToString(CultureInfo.InvariantCulture),
                        Kind: kind,
                        Filename: DocumentFilename(doc),
                        Size: doc.size,
                        OriginHash: null,
                        FileRef: reference.Encode()),
                };
            }
            default:
                return null;
        }
    }

    private static TgAttachmentKind DocumentKind(Document doc)
    {
        var attrs = doc.attributes ?? Array.Empty<DocumentAttribute>();
        if (attrs.Any(a => a is DocumentAttributeVideo)) return TgAttachmentKind.Video;
        if (attrs.Any(a => a is DocumentAttributeAudio)) return TgAttachmentKind.Audio;
        if (attrs.Any(a => a is DocumentAttributeImageSize) || (doc.mime_type?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ?? false))
            return TgAttachmentKind.Image;
        return TgAttachmentKind.Doc;
    }

    private static string DocumentFilename(Document doc)
    {
        var named = (doc.attributes ?? Array.Empty<DocumentAttribute>()).OfType<DocumentAttributeFilename>().FirstOrDefault();
        if (named is not null && !string.IsNullOrEmpty(named.file_name)) return named.file_name;
        return "file_" + doc.id.ToString(CultureInfo.InvariantCulture);
    }
}
