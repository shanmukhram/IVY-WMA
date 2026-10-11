using System.Text.Json.Nodes;
using Ivy.Core.Protocol;
using Ivy.Core.Records;

namespace Ivy.Core.Tests;

/// <summary><c>message_batch</c> (PROTOCOL.md §6; PRD WX1): the C# record matches the TypeScript reference schema.</summary>
public class MessageBatchTests
{
    private const string T = "2026-10-09T10:00:00.000Z";

    private static MessageBatchRecord Batch(params ChatMessage[] messages) => new()
    {
        DeviceId = "dev", EventTime = T, CaptureTime = "2026-10-10T00:00:00.000Z",
        Platform = MessagePlatforms.Telegram, Account = "@bunny", ConvKey = "-100123", ConvKind = "group",
        SourceSession = SourceSessions.WindowsTelegramDesktop, Coverage = MessageCoverage.Complete, Cursor = "7782",
        Messages = messages,
    };

    private static ChatMessage Msg(string id = "7781") => new() { MsgId = id, Sender = "Aki", SentAt = T, Text = "hi", SourceStatus = MessageSourceStatus.Live };

    [Fact]
    public void Serializes_with_reference_field_names_order_and_omits_absent_optionals()
    {
        var r = Batch(Msg()) with { Peer = "Robotics lab" };
        r.Validate();
        var expected = ("{'v':1,'kind':'message_batch','deviceId':'dev','eventTime':'2026-10-09T10:00:00.000Z','captureTime':'2026-10-10T00:00:00.000Z'," +
            "'platform':'telegram','account':'@bunny','convKey':'-100123','peer':'Robotics lab','convKind':'group','sourceSession':'windows:telegram-desktop'," +
            "'coverage':'complete','messages':[{'msgId':'7781','sender':'Aki','sentAt':'2026-10-09T10:00:00.000Z','text':'hi','sourceStatus':'live','attachments':[]}],'cursor':'7782'}")
            .Replace('\'', '"');
        Assert.Equal(expected, IvyJson.Serialize(r));
    }

    [Fact]
    public void Carries_the_multi_source_fields_and_round_trips()
    {
        var r = Batch(
            Msg() with
            {
                ForwardedFrom = "Robotics News", MediaKind = "photo", ReplyTo = "7700", EditedAt = T,
                Attachments = new[] { new MessageAttachment { AttId = "a1", Kind = "image", Filename = "p.jpg", Size = 10, OriginHash = "h" } },
            },
            Msg("7782") with { SourceStatus = MessageSourceStatus.DeletedAtSource, DeletedAtSource = "2026-10-09T11:00:00.000Z" })
            with { ChatMeta = new ChatMeta { Title = "Robotics lab", ParticipantCount = 42, ChatType = "supergroup" } };
        r.Validate();
        var json = IvyJson.Serialize(r);
        var o = JsonNode.Parse(json)!.AsObject();
        Assert.Equal(new[] { "v", "kind", "deviceId", "eventTime", "captureTime", "platform", "account", "convKey", "convKind", "sourceSession", "coverage", "chatMeta", "messages", "cursor" },
            o.Select(p => p.Key));
        Assert.Equal("""{"title":"Robotics lab","participantCount":42,"chatType":"supergroup"}""", o["chatMeta"]!.ToJsonString());
        Assert.Equal(new[] { "msgId", "sender", "sentAt", "text", "replyTo", "editedAt", "sourceStatus", "forwardedFrom", "mediaKind", "attachments" },
            o["messages"]![0]!.AsObject().Select(p => p.Key));
        Assert.Equal("2026-10-09T11:00:00.000Z", o["messages"]![1]!["deletedAtSource"]!.GetValue<string>());
        Assert.Equal(new[] { "attId", "kind", "filename", "size", "originHash" }, o["messages"]![0]!["attachments"]![0]!.AsObject().Select(p => p.Key));

        var back = RecordJson.Parse<MessageBatchRecord>(Bytes.Utf8.GetBytes(json));
        Assert.Equal(json, IvyJson.Serialize(back));
        Assert.Equal(Kind.MessageBatch, back.RecordKind);
    }

    [Fact]
    public void Call_object_uses_the_reference_field_names_and_round_trips()
    {
        var r = Batch(
            Msg() with
            {
                MediaKind = "call",
                Call = new MessageCall { Kind = "video", Outcome = "completed", DurationSec = 155, Direction = "outgoing" },
            },
            Msg("7782") with { MediaKind = "call", Call = new MessageCall { Kind = "audio", Outcome = "missed" } });
        r.Validate();
        var json = IvyJson.Serialize(r);
        var o = JsonNode.Parse(json)!.AsObject();
        Assert.Equal(new[] { "msgId", "sender", "sentAt", "text", "sourceStatus", "mediaKind", "call", "attachments" },
            o["messages"]![0]!.AsObject().Select(p => p.Key));
        Assert.Equal("""{"kind":"video","outcome":"completed","durationSec":155,"direction":"outgoing"}""", o["messages"]![0]!["call"]!.ToJsonString());
        Assert.Equal("""{"kind":"audio","outcome":"missed"}""", o["messages"]![1]!["call"]!.ToJsonString()); // absent optionals omitted

        var back = RecordJson.Parse<MessageBatchRecord>(Bytes.Utf8.GetBytes(json));
        Assert.Equal(json, IvyJson.Serialize(back));
        Assert.Equal(155, back.Messages[0].Call!.DurationSec);

        Assert.Throws<RecordValidationException>(() => Batch(Msg() with { Call = new MessageCall { Kind = "fax", Outcome = "completed" } }).Validate());
        Assert.Throws<RecordValidationException>(() => Batch(Msg() with { Call = new MessageCall { Kind = "audio", Outcome = "busy" } }).Validate());
        Assert.Throws<RecordValidationException>(() => Batch(Msg() with { Call = new MessageCall { Kind = "audio", Outcome = "completed", DurationSec = -1 } }).Validate());
        Assert.Throws<RecordValidationException>(() => Batch(Msg() with { Call = new MessageCall { Kind = "audio", Outcome = "completed", Direction = "sideways" } }).Validate());
    }

    [Fact]
    public void Validation_matches_the_reference()
    {
        Assert.Throws<RecordValidationException>(() => (Batch(Msg()) with { SourceSession = "telegram" }).Validate());
        Assert.Throws<RecordValidationException>(() => (Batch(Msg()) with { SourceSession = "mac:telegram" }).Validate());
        Assert.Throws<RecordValidationException>(() => (Batch(Msg()) with { SourceSession = "Windows:Telegram" }).Validate());
        Assert.Throws<RecordValidationException>(() => (Batch(Msg()) with { Coverage = "full" }).Validate());
        Assert.Throws<RecordValidationException>(() => (Batch(Msg()) with { Platform = "signal" }).Validate());
        Assert.Throws<RecordValidationException>(() => (Batch(Msg()) with { ChatMeta = new ChatMeta { ParticipantCount = -1 } }).Validate());
        Assert.Throws<RecordValidationException>(() => Batch(Msg("")).Validate());
        Assert.Throws<RecordValidationException>(() => Batch(Msg() with { DeletedAtSource = T }).Validate()); // only with deleted_at_source
        Assert.Throws<RecordValidationException>(() => Batch(Msg() with { SourceStatus = "gone" }).Validate());
        Assert.Throws<RecordValidationException>(() => Batch(Msg() with { MediaKind = "" }).Validate());

        // a record without sourceSession does not bind
        var noSession = IvyJson.Serialize(Batch(Msg())).Replace("\"sourceSession\":\"windows:telegram-desktop\",", "");
        Assert.ThrowsAny<Exception>(() => RecordJson.Parse<MessageBatchRecord>(Bytes.Utf8.GetBytes(noSession)));

        Batch(Msg() with { SourceStatus = MessageSourceStatus.DeletedAtSource }).Validate(); // dated by captureTime on the Mac
        (Batch(Msg()) with { SourceSession = SourceSessions.WindowsLineDesktop, Platform = MessagePlatforms.Line, Coverage = MessageCoverage.Partial }).Validate();
    }
}
