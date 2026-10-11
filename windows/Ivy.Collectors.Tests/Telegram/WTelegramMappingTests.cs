using System.Text;
using Ivy.Collectors.Telegram.Client;
using TL;

namespace Ivy.Collectors.Tests.Telegram;

/// <summary>
/// Unit tests for the WTelegramClient → domain mapping layer and the session construction, with hand-built TL
/// objects and a fixture auth key. No network: this is everything about the real adapter we can verify on macOS.
/// </summary>
public class WTelegramMappingTests
{
    private static Dictionary<long, User> Users(params User[] u) => u.ToDictionary(x => x.id);
    private static Dictionary<long, ChatBase> Chats(params ChatBase[] c) => c.ToDictionary(x => x.ID);

    [Fact]
    public void MapDialog_dm_maps_user_name_and_kind()
    {
        var users = Users(new User { id = 5, first_name = "Al", last_name = "Pha", access_hash = 9, username = "al" });
        var dialog = new Dialog { peer = new PeerUser { user_id = 5 }, top_message = 42 };

        var d = TelegramTypeMapper.MapDialog(dialog, users, Chats());

        Assert.Equal("user:5", d.ConvKey);
        Assert.Equal(TgConvKind.Dm, d.ConvKind);
        Assert.False(d.IsChannel);
        Assert.Equal("Al Pha", d.Meta.Title);
        Assert.Equal("private", d.Meta.ChatType);
        Assert.Equal(42, d.TopMessageId);
    }

    [Fact]
    public void MapDialog_folder_id_1_is_archived_and_DialogFolder_rows_are_skipped()
    {
        var users = Users(new User { id = 5, first_name = "Al", access_hash = 9 });
        var archived = new Dialog { peer = new PeerUser { user_id = 5 }, flags = Dialog.Flags.has_folder_id, folder_id = 1 };
        var normal = new Dialog { peer = new PeerUser { user_id = 5 } };
        var otherFolder = new Dialog { peer = new PeerUser { user_id = 5 }, flags = Dialog.Flags.has_folder_id, folder_id = 0 };

        Assert.True(TelegramTypeMapper.MapDialog(archived, users, Chats()).Archived);
        Assert.True(TelegramTypeMapper.TryMapDialog(archived, users, Chats())!.Archived);
        Assert.False(TelegramTypeMapper.MapDialog(normal, users, Chats()).Archived);
        Assert.False(TelegramTypeMapper.MapDialog(otherFolder, users, Chats()).Archived);

        // the collapsed "Archived chats" entry is not a chat
        var folderRow = new DialogFolder { folder = new Folder { id = 1, title = "Archived Chats" }, peer = new PeerChannel { channel_id = 99 } };
        Assert.Null(TelegramTypeMapper.TryMapDialog(folderRow, users, Chats()));
    }

    [Fact]
    public void MapDialog_group_and_channel_and_supergroup()
    {
        var chat = new Chat { id = 11, title = "Group", participants_count = 3 };
        var broadcast = new Channel { id = 7, title = "News", access_hash = 1, flags = Channel.Flags.broadcast, participants_count = 1000 };
        var supergroup = new Channel { id = 8, title = "Mega", access_hash = 2, participants_count = 50 };
        var chats = Chats(chat, broadcast, supergroup);

        var g = TelegramTypeMapper.MapDialog(new Dialog { peer = new PeerChat { chat_id = 11 } }, Users(), chats);
        Assert.Equal("chat:11", g.ConvKey);
        Assert.Equal(TgConvKind.Group, g.ConvKind);
        Assert.False(g.IsChannel);
        Assert.Equal("group", g.Meta.ChatType);
        Assert.Equal(3, g.Meta.ParticipantCount);

        var ch = TelegramTypeMapper.MapDialog(new Dialog { peer = new PeerChannel { channel_id = 7 } }, Users(), chats);
        Assert.Equal("channel:7", ch.ConvKey);
        Assert.True(ch.IsChannel);
        Assert.Equal("channel", ch.Meta.ChatType);

        var sg = TelegramTypeMapper.MapDialog(new Dialog { peer = new PeerChannel { channel_id = 8 } }, Users(), chats);
        Assert.False(sg.IsChannel);
        Assert.Equal("supergroup", sg.Meta.ChatType);
    }

    [Fact]
    public void MapMessage_carries_text_edit_reply_and_document_attachment()
    {
        var doc = new Document
        {
            id = 123, access_hash = 456, dc_id = 4, size = 2048, mime_type = "application/pdf",
            file_reference = new byte[] { 1, 2, 3 },
            attributes = new DocumentAttribute[] { new DocumentAttributeFilename { file_name = "report.pdf" } },
        };
        var m = new Message
        {
            id = 100, from_id = new PeerUser { user_id = 5 }, peer_id = new PeerChat { chat_id = 11 },
            date = new DateTime(2024, 1, 2, 3, 4, 5, DateTimeKind.Utc), edit_date = new DateTime(2024, 1, 2, 4, 0, 0, DateTimeKind.Utc),
            message = "see attached", reply_to = new MessageReplyHeader { reply_to_msg_id = 99 },
            media = new MessageMediaDocument { document = doc },
        };

        var mapped = TelegramTypeMapper.MapMessage(m)!;
        Assert.Equal(100, mapped.MsgId);
        Assert.Equal("5", mapped.Sender);
        Assert.Equal("see attached", mapped.Text);
        Assert.Equal(99, mapped.ReplyTo);
        Assert.NotNull(mapped.EditedAt);
        Assert.Equal("document", mapped.MediaKind);
        var att = Assert.Single(mapped.Files);
        Assert.Equal(TgAttachmentKind.Doc, att.Kind);
        Assert.Equal("report.pdf", att.Filename);
        Assert.Equal(2048, att.Size);

        Assert.True(TelegramAttachmentRef.TryDecode(att.FileRef, out var reference));
        Assert.Equal('d', reference!.Kind);
        Assert.Equal(123, reference.Id);
        Assert.Equal(456, reference.AccessHash);
        Assert.Equal(4, reference.DcId);
        Assert.Equal(new byte[] { 1, 2, 3 }, reference.FileReference);
        Assert.IsType<InputDocumentFileLocation>(reference.ToFileLocation());
    }

    [Fact]
    public void MapMessage_photo_and_service_and_empty()
    {
        var photo = new Photo { id = 9, access_hash = 8, dc_id = 2, file_reference = new byte[] { 9 },
            sizes = new PhotoSizeBase[] { new PhotoSize { type = "x", w = 100, h = 100, size = 5000 } } };
        var withPhoto = new Message { id = 1, peer_id = new PeerUser { user_id = 5 }, media = new MessageMediaPhoto { photo = photo }, message = "" };
        var mp = TelegramTypeMapper.MapMessage(withPhoto)!;
        Assert.Equal("photo", mp.MediaKind);
        var pa = Assert.Single(mp.Files);
        Assert.Equal(TgAttachmentKind.Image, pa.Kind);
        Assert.True(TelegramAttachmentRef.TryDecode(pa.FileRef, out var pref));
        Assert.Equal("x", pref!.ThumbType);
        Assert.IsType<InputPhotoFileLocation>(pref.ToFileLocation());

        var service = TelegramTypeMapper.MapMessage(new MessageService { id = 2, peer_id = new PeerUser { user_id = 5 }, date = new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc) })!;
        Assert.Equal("", service.Text);
        Assert.Empty(service.Files);

        Assert.Null(TelegramTypeMapper.MapMessage(new MessageEmpty { id = 3 }));
    }

    [Fact]
    public void AttachmentRef_round_trips()
    {
        var r = new TelegramAttachmentRef('d', 1, 2, 4, 10, null, new byte[] { 5, 6, 7 });
        Assert.True(TelegramAttachmentRef.TryDecode(r.Encode(), out var back));
        Assert.Equal(r.Kind, back!.Kind);
        Assert.Equal(r.Id, back.Id);
        Assert.Equal(r.AccessHash, back.AccessHash);
        Assert.Equal(r.DcId, back.DcId);
        Assert.Equal(r.Size, back.Size);
        Assert.Null(back.ThumbType);
        Assert.Equal(r.FileReference, back.FileReference);
        Assert.False(TelegramAttachmentRef.TryDecode("garbage", out _));
    }

    [Fact]
    public void Session_build_hides_auth_key_in_the_ciphertext_only()
    {
        var authKey = new byte[WTelegramSession.AuthKeySize];
        for (var i = 0; i < authKey.Length; i++) authKey[i] = (byte)(i * 7 + 1);
        var session = new TelegramSession(12345, 4, new Dictionary<int, byte[]> { [4] = authKey });

        var built = WTelegramSession.Build(session, apiId: 2040);

        // The raw key never appears in the produced buffer as a contiguous plaintext run.
        Assert.False(ContainsSequence(built.SessionBytes, authKey), "auth key bytes leaked into the session buffer");

        // Decrypting with the per-process key gives JSON carrying the DC and the base64 key WTelegramClient reads.
        var json = Encoding.UTF8.GetString(WTelegramSession.DecryptForTest(built.SessionBytes, built.SessionKey));
        Assert.Contains("\"MainDC\":4", json);
        Assert.Contains("\"ApiId\":2040", json);
        Assert.Contains("\"UserId\":12345", json);
        Assert.Contains(Convert.ToBase64String(authKey), json);
        Assert.Contains(TelegramDcEndpoints.ForDc(4).Ip, json);
    }

    [Fact]
    public void Session_build_rejects_missing_or_wrong_sized_key()
    {
        var bad = new TelegramSession(1, 2, new Dictionary<int, byte[]> { [2] = new byte[16] });
        Assert.Throws<ArgumentException>(() => WTelegramSession.Build(bad, 1));
    }

    private static bool ContainsSequence(byte[] haystack, byte[] needle)
    {
        for (var i = 0; i + needle.Length <= haystack.Length; i++)
        {
            var ok = true;
            for (var j = 0; j < needle.Length; j++)
                if (haystack[i + j] != needle[j]) { ok = false; break; }
            if (ok) return true;
        }
        return false;
    }
}
