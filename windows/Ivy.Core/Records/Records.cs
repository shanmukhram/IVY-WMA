using System.Text.Json;
using System.Text.Json.Serialization;
using Ivy.Core.Protocol;

namespace Ivy.Core.Records;

/// <summary>Thrown when a decoded record does not satisfy its schema (PROTOCOL.md §6).</summary>
public sealed class RecordValidationException : Exception
{
    public RecordValidationException(string message) : base(message) { }
}

/// <summary>
/// Fields present on every capture/command record (§6): <c>v</c>, <c>kind</c>, <c>deviceId</c>,
/// <c>eventTime</c> (the source's original event time) and <c>captureTime</c> (when the device
/// observed it). They are separate and never merged. Timestamps are ISO-8601 strings.
/// </summary>
public abstract record IvyRecord
{
    protected IvyRecord(Kind kind)
    {
        RecordKind = kind;
        Kind = kind.WireName();
    }

    [JsonIgnore] public Kind RecordKind { get; }

    [JsonPropertyName("v"), JsonPropertyOrder(-5)] public int V { get; init; } = 1;
    [JsonPropertyName("kind"), JsonPropertyOrder(-4)] public string Kind { get; init; }
    [JsonPropertyName("deviceId"), JsonPropertyOrder(-3)] public required string DeviceId { get; init; }
    [JsonPropertyName("eventTime"), JsonPropertyOrder(-2)] public required string EventTime { get; init; }
    [JsonPropertyName("captureTime"), JsonPropertyOrder(-1)] public required string CaptureTime { get; init; }

    /// <summary>Validate schema constraints. Throws <see cref="RecordValidationException"/>.</summary>
    public virtual void Validate()
    {
        if (V != 1) throw new RecordValidationException($"unsupported record version {V}");
        if (Kind != RecordKind.WireName()) throw new RecordValidationException($"kind '{Kind}' does not match {RecordKind.WireName()}");
        Require(DeviceId, "deviceId");
        Require(EventTime, "eventTime");
        Require(CaptureTime, "captureTime");
    }

    protected static void Require(string? s, string field)
    {
        if (string.IsNullOrEmpty(s)) throw new RecordValidationException($"{field} is required");
    }

    protected static void Optional(string? s, string field)
    {
        if (s is not null && s.Length == 0) throw new RecordValidationException($"{field} must be non-empty when present");
    }

    protected static void NonNegative(long n, string field)
    {
        if (n < 0) throw new RecordValidationException($"{field} must be non-negative");
    }
}

/// <summary><c>file_meta</c> (WC1/WC2): metadata, plus the original when the media policy uploads it (PLAN decision 8).</summary>
public sealed record FileMetaRecord() : IvyRecord(Protocol.Kind.FileMeta)
{
    [JsonPropertyName("path")] public required string Path { get; init; }
    [JsonPropertyName("name")] public required string Name { get; init; }
    [JsonPropertyName("size")] public long? Size { get; init; }
    [JsonPropertyName("ext")] public required string Ext { get; init; }
    [JsonPropertyName("mtime")] public string? Mtime { get; init; }
    [JsonPropertyName("quickHash")] public string? QuickHash { get; init; }
    [JsonPropertyName("thumbBlobOid")] public string? ThumbBlobOid { get; init; }

    /// <summary>
    /// Optional (§6): oid of the chunked blob holding the original bytes, uploaded by the device on its own
    /// (payload kind <c>photo</c> or <c>document</c>). Absent: original on request only. Omitted when null.
    /// </summary>
    [JsonPropertyName("originalBlobOid")] public string? OriginalBlobOid { get; init; }

    /// <summary>
    /// True when this record reports a deletion (default false; omitted from the wire when false). When
    /// true, <c>size</c>/<c>mtime</c>/<c>quickHash</c> MAY be omitted and <c>eventTime</c> is when the
    /// deletion was observed. A live record still carries all three.
    /// </summary>
    [JsonPropertyName("deleted"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Deleted { get; init; }

    public override void Validate()
    {
        base.Validate();
        if (Size is { } sz) NonNegative(sz, "size");
        Optional(ThumbBlobOid, "thumbBlobOid");
        Optional(OriginalBlobOid, "originalBlobOid");
        if (!Deleted)
        {
            if (Size is null) throw new RecordValidationException("size is required unless deleted");
            Require(Mtime, "mtime");
            Require(QuickHash, "quickHash");
        }
    }
}

/// <summary><c>screenshot</c> (WC3): <c>blobOid</c> references the chunked blob with the original image.</summary>
public sealed record ScreenshotRecord() : IvyRecord(Protocol.Kind.Screenshot)
{
    [JsonPropertyName("sourcePath")] public required string SourcePath { get; init; }
    [JsonPropertyName("width")] public int? Width { get; init; }
    [JsonPropertyName("height")] public int? Height { get; init; }
    [JsonPropertyName("sha256")] public required string Sha256 { get; init; }
    [JsonPropertyName("blobOid")] public required string BlobOid { get; init; }
    [JsonPropertyName("takenAt")] public string? TakenAt { get; init; }
    [JsonPropertyName("savedAt")] public string? SavedAt { get; init; }

    public override void Validate()
    {
        base.Validate();
        if (Width is <= 0) throw new RecordValidationException("width must be positive");
        if (Height is <= 0) throw new RecordValidationException("height must be positive");
        Optional(TakenAt, "takenAt");
        Optional(SavedAt, "savedAt");
    }
}

/// <summary><c>usage_event</c> (WC4).</summary>
public sealed record UsageEventRecord() : IvyRecord(Protocol.Kind.UsageEvent)
{
    [JsonPropertyName("app")] public required string App { get; init; }
    [JsonPropertyName("exe")] public string? Exe { get; init; }

    private readonly string? _title;
    private readonly bool _titleCaptured;

    /// <summary>
    /// Foreground window title (PROTOCOL.md §6), serialized as <c>string | null | absent</c>: a string is
    /// the captured title; <c>null</c> means a title was captured but excluded by a setting; absent means
    /// no title was captured. Setting this property (in code, or when a <c>title</c> key is present on
    /// deserialization) marks the title as captured; leave it unset and set <see cref="TitleCaptured"/>
    /// to false for the not-captured case.
    /// </summary>
    [JsonPropertyName("title")]
    public string? Title
    {
        get => _title;
        init { _title = value; _titleCaptured = true; }
    }

    /// <summary>Whether a title was captured at all. Controls whether <c>title</c> appears on the wire (see <see cref="IvyJson"/>).</summary>
    [JsonIgnore] public bool TitleCaptured { get => _titleCaptured; init => _titleCaptured = value; }

    [JsonPropertyName("startedAt")] public required string StartedAt { get; init; }
    [JsonPropertyName("endedAt")] public required string EndedAt { get; init; }

    public override void Validate()
    {
        base.Validate();
        Require(StartedAt, "startedAt");
        Require(EndedAt, "endedAt");
    }
}

/// <summary><c>windows_notification</c> (WC5).</summary>
public sealed record WindowsNotificationRecord() : IvyRecord(Protocol.Kind.WindowsNotification)
{
    [JsonPropertyName("app")] public required string App { get; init; }
    [JsonPropertyName("title")] public required string Title { get; init; }
    [JsonPropertyName("text")] public required string Text { get; init; }
    [JsonPropertyName("sender")] public string? Sender { get; init; }
    [JsonPropertyName("postedAt")] public required string PostedAt { get; init; }

    public override void Validate()
    {
        base.Validate();
        Require(PostedAt, "postedAt");
    }
}

/// <summary>Wire values for <c>message_batch.coverage</c>: what the sending source holds for the conversation.</summary>
public static class MessageCoverage
{
    public const string Complete = "complete";
    public const string Partial = "partial";
    public const string NotificationOnly = "notification_only";

    public static bool IsValid(string s) => s is Complete or Partial or NotificationOnly;
}

/// <summary>Wire values for <c>message_batch.platform</c>.</summary>
public static class MessagePlatforms
{
    public const string Line = "line";
    public const string Telegram = "telegram";
    public const string WhatsApp = "whatsapp";
    public const string Sms = "sms";
    public const string Instagram = "instagram";
    public const string Snapchat = "snapchat";

    public static bool IsValid(string s) => s is Line or Telegram or WhatsApp or Sms or Instagram or Snapchat;
}

/// <summary>
/// <c>message_batch.sourceSession</c> (§6, PRD WX1): the capture source as <c>&lt;role&gt;:&lt;collector&gt;</c>, lowercase,
/// where the role is the sending device's role. The Mac quarantines a batch whose role is not the sender's.
/// </summary>
public static class SourceSessions
{
    public const string WindowsTelegramDesktop = "windows:telegram-desktop";
    public const string WindowsLineDesktop = "windows:line-desktop";
    public const string AndroidRootDb = "android:root-db";
    public const string AndroidNotification = "android:notification";

    private static readonly System.Text.RegularExpressions.Regex Pattern =
        new("^(windows|android):[a-z0-9][a-z0-9._-]*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    public static bool IsValid(string? s) => s is not null && Pattern.IsMatch(s);
}

/// <summary>One attachment reference of a message (C4).</summary>
public sealed record MessageAttachment
{
    [JsonPropertyName("attId")] public required string AttId { get; init; }
    /// <summary><c>image</c>, <c>video</c>, <c>audio</c> or <c>doc</c>.</summary>
    [JsonPropertyName("kind")] public required string Kind { get; init; }
    [JsonPropertyName("filename")] public required string Filename { get; init; }
    [JsonPropertyName("size")] public required long Size { get; init; }
    [JsonPropertyName("originHash")] public string? OriginHash { get; init; }
    /// <summary>oid of the chunked blob holding the original, when uploaded.</summary>
    [JsonPropertyName("blobOid")] public string? BlobOid { get; init; }
}

/// <summary>One message of a <see cref="MessageBatchRecord"/>.</summary>
public sealed record ChatMessage
{
    /// <summary>
    /// The platform's own message id (Telegram message id, LINE local/server id, ...), never one the collector
    /// invents: the Mac merges copies from different sources on platform + account + convKey + msgId (WX1, C8).
    /// </summary>
    [JsonPropertyName("msgId")] public required string MsgId { get; init; }
    [JsonPropertyName("sender")] public required string Sender { get; init; }
    /// <summary>True when the account's own user sent this message (drives the bubble side on the Mac).</summary>
    [JsonPropertyName("fromMe")] public bool? FromMe { get; init; }
    /// <summary>The sender's resolved human display name; <see cref="Sender"/> stays the stable platform id.</summary>
    [JsonPropertyName("senderName")] public string? SenderName { get; init; }
    /// <summary>The source's own send time (ISO-8601).</summary>
    [JsonPropertyName("sentAt")] public required string SentAt { get; init; }
    [JsonPropertyName("text")] public required string Text { get; init; }
    /// <summary>The platform id of the message this one replies to.</summary>
    [JsonPropertyName("replyTo")] public string? ReplyTo { get; init; }
    [JsonPropertyName("editedAt")] public string? EditedAt { get; init; }
    /// <summary><c>live</c> or <c>deleted_at_source</c> (<see cref="MessageSourceStatus"/>).</summary>
    [JsonPropertyName("sourceStatus")] public required string SourceStatus { get; init; }
    /// <summary>Who it was forwarded from, as the platform shows it.</summary>
    [JsonPropertyName("forwardedFrom")] public string? ForwardedFrom { get; init; }
    /// <summary>The media kind as the platform names it (<c>photo</c>, <c>sticker</c>, <c>voice</c>, ...); null for plain text.</summary>
    [JsonPropertyName("mediaKind")] public string? MediaKind { get; init; }
    /// <summary>When the source observed the deletion; only with <c>sourceStatus: deleted_at_source</c>.</summary>
    [JsonPropertyName("deletedAtSource")] public string? DeletedAtSource { get; init; }
    [JsonPropertyName("attachments")] public IReadOnlyList<MessageAttachment> Attachments { get; init; } = Array.Empty<MessageAttachment>();
}

/// <summary>Wire values for <c>message.sourceStatus</c>.</summary>
public static class MessageSourceStatus
{
    public const string Live = "live";
    public const string DeletedAtSource = "deleted_at_source";

    public static bool IsValid(string s) => s is Live or DeletedAtSource;
}

/// <summary>Optional chat metadata, as the platform reports it.</summary>
public sealed record ChatMeta
{
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("participantCount")] public int? ParticipantCount { get; init; }
    /// <summary>The chat type in the platform's own words (<c>private</c>, <c>group</c>, <c>supergroup</c>, <c>channel</c>, <c>secret</c>, ...).</summary>
    [JsonPropertyName("chatType")] public string? ChatType { get; init; }
    /// <summary>The chat/peer profile image, uploaded as a chunked blob (payloadKind <c>avatar</c>).</summary>
    [JsonPropertyName("avatarBlobOid")] public string? AvatarBlobOid { get; init; }
}

/// <summary><c>message_batch</c> (C1-C10, WT1-WT4, WL1-WL3, WX1): messages of one conversation from one capture source.</summary>
public sealed record MessageBatchRecord() : IvyRecord(Protocol.Kind.MessageBatch)
{
    /// <summary><see cref="MessagePlatforms"/>.</summary>
    [JsonPropertyName("platform")] public required string Platform { get; init; }
    [JsonPropertyName("account")] public required string Account { get; init; }
    [JsonPropertyName("convKey")] public required string ConvKey { get; init; }
    [JsonPropertyName("peer")] public string? Peer { get; init; }
    /// <summary><c>dm</c> or <c>group</c>.</summary>
    [JsonPropertyName("convKind")] public required string ConvKind { get; init; }
    /// <summary>The capture source (<see cref="SourceSessions"/>).</summary>
    [JsonPropertyName("sourceSession")] public required string SourceSession { get; init; }
    /// <summary>What THIS source holds for the conversation (<see cref="MessageCoverage"/>); the Mac keeps one claim per source.</summary>
    [JsonPropertyName("coverage")] public required string Coverage { get; init; }
    [JsonPropertyName("chatMeta")] public ChatMeta? ChatMeta { get; init; }
    [JsonPropertyName("messages")] public required IReadOnlyList<ChatMessage> Messages { get; init; }
    /// <summary>Per-conversation progress cursor (message id, rowid or hash).</summary>
    [JsonPropertyName("cursor")] public required string Cursor { get; init; }

    public override void Validate()
    {
        base.Validate();
        if (!MessagePlatforms.IsValid(Platform)) throw new RecordValidationException($"invalid platform '{Platform}'");
        if (ConvKind is not ("dm" or "group")) throw new RecordValidationException($"invalid convKind '{ConvKind}'");
        if (!SourceSessions.IsValid(SourceSession)) throw new RecordValidationException($"sourceSession '{SourceSession}' must be <role>:<collector>");
        if (!MessageCoverage.IsValid(Coverage)) throw new RecordValidationException($"invalid coverage '{Coverage}'");
        if (ChatMeta is { ParticipantCount: < 0 }) throw new RecordValidationException("chatMeta.participantCount must be non-negative");
        if (ChatMeta is not null) Optional(ChatMeta.ChatType, "chatMeta.chatType");
        if (Messages is null) throw new RecordValidationException("messages is required");
        foreach (var m in Messages)
        {
            Require(m.MsgId, "msgId");
            Require(m.SentAt, "sentAt");
            if (m.Sender is null) throw new RecordValidationException("sender is required");
            if (m.Text is null) throw new RecordValidationException("text is required");
            if (!MessageSourceStatus.IsValid(m.SourceStatus)) throw new RecordValidationException($"invalid sourceStatus '{m.SourceStatus}'");
            Optional(m.EditedAt, "editedAt");
            Optional(m.ForwardedFrom, "forwardedFrom");
            Optional(m.MediaKind, "mediaKind");
            Optional(m.DeletedAtSource, "deletedAtSource");
            if (m.DeletedAtSource is not null && m.SourceStatus != MessageSourceStatus.DeletedAtSource)
                throw new RecordValidationException("deletedAtSource requires sourceStatus deleted_at_source");
            if (m.Attachments is null) throw new RecordValidationException("attachments is required");
            foreach (var a in m.Attachments)
            {
                Require(a.AttId, "attId");
                if (a.Kind is not ("image" or "video" or "audio" or "doc")) throw new RecordValidationException($"invalid attachment kind '{a.Kind}'");
                if (a.Filename is null) throw new RecordValidationException("filename is required");
                NonNegative(a.Size, "size");
            }
        }
    }
}

/// <summary>Command parameters: a discriminated union on <c>type</c>.</summary>
[JsonConverter(typeof(CommandParamsConverter))]
public abstract record CommandParams
{
    [JsonPropertyName("type"), JsonPropertyOrder(-1)] public abstract string Type { get; }
}

/// <summary><c>file_request</c> (F2, WR1): locate by file id (preferred) or path.</summary>
public sealed record FileRequestParams : CommandParams
{
    public const string TypeName = "file_request";
    [JsonPropertyName("type"), JsonPropertyOrder(-1)] public override string Type => TypeName;
    [JsonPropertyName("fileId")] public string? FileId { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
}

/// <summary><c>rescan</c> (WR3).</summary>
public sealed record RescanParams : CommandParams
{
    public const string TypeName = "rescan";
    [JsonPropertyName("type"), JsonPropertyOrder(-1)] public override string Type => TypeName;
    [JsonPropertyName("collector")] public required string Collector { get; init; }
    [JsonPropertyName("scope")] public string? Scope { get; init; }
}

/// <summary><c>collector_config</c> (WR3).</summary>
public sealed record CollectorConfigParams : CommandParams
{
    public const string TypeName = "collector_config";
    [JsonPropertyName("type"), JsonPropertyOrder(-1)] public override string Type => TypeName;
    [JsonPropertyName("collector")] public required string Collector { get; init; }
    [JsonPropertyName("enabled")] public bool? Enabled { get; init; }
    [JsonPropertyName("settings")] public Dictionary<string, JsonElement>? Settings { get; init; }
}

/// <summary>Reads <c>type</c> wherever it appears in the object, then binds the matching params record.</summary>
internal sealed class CommandParamsConverter : JsonConverter<CommandParams>
{
    public override CommandParams Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new JsonException("command params must be an object");
        if (!root.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) throw new JsonException("command params missing type");
        var raw = root.GetRawText();
        return t.GetString() switch
        {
            FileRequestParams.TypeName => Bind<FileRequestParams>(raw),
            RescanParams.TypeName => Bind<RescanParams>(raw),
            CollectorConfigParams.TypeName => Bind<CollectorConfigParams>(raw),
            var other => throw new JsonException($"unknown command type '{other}'"),
        };
    }

    // Bind against options that do not include this converter (derived types carry no converter attribute).
    private static T Bind<T>(string raw) where T : CommandParams =>
        JsonSerializer.Deserialize<T>(raw, BindOptions) ?? throw new JsonException("null params");

    private static readonly JsonSerializerOptions BindOptions = new(IvyJson.Options);

    public override void Write(Utf8JsonWriter writer, CommandParams value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, value, value.GetType(), options);
}

/// <summary><c>command</c> (Mac → device).</summary>
public sealed record CommandRecord() : IvyRecord(Protocol.Kind.Command)
{
    [JsonPropertyName("commandId")] public required string CommandId { get; init; }
    [JsonPropertyName("issuedAt")] public required string IssuedAt { get; init; }
    [JsonPropertyName("params")] public required CommandParams Params { get; init; }

    public override void Validate()
    {
        base.Validate();
        Require(IssuedAt, "issuedAt");
        if (Params is RescanParams r && r.Collector is null) throw new RecordValidationException("rescan.collector is required");
        if (Params is CollectorConfigParams c && c.Collector is null) throw new RecordValidationException("collector_config.collector is required");
    }
}

/// <summary>Wire values for <c>command_status.status</c>.</summary>
public static class CommandStatusValues
{
    public const string Uploaded = "uploaded";
    public const string Done = "done";
    public const string NotFound = "not_found";
    public const string AccessDenied = "access_denied";
    public const string TooLarge = "too_large";
    public const string Error = "error";

    public static bool IsValid(string s) => s is Uploaded or Done or NotFound or AccessDenied or TooLarge or Error;
}

/// <summary><c>command_status</c> (WR2).</summary>
public sealed record CommandStatusRecord() : IvyRecord(Protocol.Kind.CommandStatus)
{
    [JsonPropertyName("commandId")] public required string CommandId { get; init; }
    [JsonPropertyName("status")] public required string Status { get; init; }
    [JsonPropertyName("detail")] public string? Detail { get; init; }
    [JsonPropertyName("resultOid")] public string? ResultOid { get; init; }
    [JsonPropertyName("reportedAt")] public required string ReportedAt { get; init; }

    public override void Validate()
    {
        base.Validate();
        if (!CommandStatusValues.IsValid(Status)) throw new RecordValidationException($"invalid status '{Status}'");
        Require(ReportedAt, "reportedAt");
    }
}

/// <summary>Wire values for <c>device_report.collectors[].phase</c> (§6).</summary>
public static class ImportPhases
{
    /// <summary>The first full index of the collector's sources.</summary>
    public const string Initial = "initial";
    /// <summary>Live capture after a completed pass (watcher, journal, polling).</summary>
    public const string Incremental = "incremental";
    /// <summary>A later full or scoped pass (periodic, settings change, rescan command, lost events).</summary>
    public const string Rescan = "rescan";

    public static bool IsValid(string s) => s is Initial or Incremental or Rescan;
}

/// <summary>Import progress of a collector's current (or last) bulk pass. <see cref="Total"/> is null until counted.</summary>
public sealed record ImportProgress(long? Total, long Done, string Phase);

/// <summary>One collector row in a device report.</summary>
public sealed record CollectorStateRecord
{
    [JsonPropertyName("name")] public required string Name { get; init; }
    [JsonPropertyName("enabled")] public required bool Enabled { get; init; }
    [JsonPropertyName("lastRunAt")] public string? LastRunAt { get; init; }
    [JsonPropertyName("cursor")] public string? Cursor { get; init; }
    [JsonPropertyName("queueDepth")] public required int QueueDepth { get; init; }
    /// <summary>Optional (§6): items the current/last bulk pass expects; omitted while unknown.</summary>
    [JsonPropertyName("importTotal")] public long? ImportTotal { get; init; }
    /// <summary>Optional (§6): items that pass has processed so far.</summary>
    [JsonPropertyName("importDone")] public long? ImportDone { get; init; }
    /// <summary>Optional (§6): <c>initial</c>, <c>incremental</c> or <c>rescan</c> (<see cref="ImportPhases"/>).</summary>
    [JsonPropertyName("phase")] public string? Phase { get; init; }
}

/// <summary><c>device_report</c> (D1–D5): honest per-collector coverage.</summary>
public sealed record DeviceReportRecord() : IvyRecord(Protocol.Kind.DeviceReport)
{
    [JsonPropertyName("role")] public required string Role { get; init; }
    [JsonPropertyName("appVersion")] public string? AppVersion { get; init; }
    [JsonPropertyName("queueDepthTotal")] public required int QueueDepthTotal { get; init; }
    [JsonPropertyName("collectors")] public required IReadOnlyList<CollectorStateRecord> Collectors { get; init; }
    [JsonPropertyName("reportedAt")] public required string ReportedAt { get; init; }

    public override void Validate()
    {
        base.Validate();
        if (Role is not ("windows" or "android")) throw new RecordValidationException($"invalid role '{Role}'");
        NonNegative(QueueDepthTotal, "queueDepthTotal");
        foreach (var c in Collectors)
        {
            NonNegative(c.QueueDepth, "queueDepth");
            if (c.ImportTotal is { } t) NonNegative(t, "importTotal");
            if (c.ImportDone is { } d) NonNegative(d, "importDone");
            if (c.Phase is not null && !ImportPhases.IsValid(c.Phase)) throw new RecordValidationException($"invalid phase '{c.Phase}'");
        }
    }
}

/// <summary><c>pairing_device</c> (§7 step 4).</summary>
public sealed record PairingDeviceRecord() : IvyRecord(Protocol.Kind.PairingDevice)
{
    [JsonPropertyName("role")] public required string Role { get; init; }
    [JsonPropertyName("pairingId")] public required string PairingId { get; init; }
    /// <summary>Base64 device X25519 public key.</summary>
    [JsonPropertyName("publicKey")] public required string PublicKey { get; init; }
    [JsonPropertyName("fingerprint")] public required string Fingerprint { get; init; }
}

/// <summary>One manifest chunk entry.</summary>
public sealed record ManifestChunk(
    [property: JsonPropertyName("index")] int Index,
    [property: JsonPropertyName("ctLen")] int CtLen,
    [property: JsonPropertyName("sha256")] string Sha256);

/// <summary>Chunked-object manifest (§2.2). Not an <see cref="IvyRecord"/>: it has no device/time fields.</summary>
public sealed record ManifestRecord
{
    [JsonPropertyName("v")] public int V { get; init; } = 1;
    [JsonPropertyName("objectId")] public required string ObjectId { get; init; }
    [JsonPropertyName("payloadKind")] public required string PayloadKind { get; init; }
    [JsonPropertyName("totalSize")] public required long TotalSize { get; init; }
    [JsonPropertyName("chunkSize")] public required int ChunkSize { get; init; }
    [JsonPropertyName("totalChunks")] public required int TotalChunks { get; init; }
    /// <summary>Base64 content key. Only ever exists inside the encrypted manifest envelope.</summary>
    [JsonPropertyName("cek")] public required string Cek { get; init; }
    [JsonPropertyName("chunks")] public required IReadOnlyList<ManifestChunk> Chunks { get; init; }
    /// <summary>
    /// Optional (§2.2): the <c>commandId</c> of the <c>file_request</c> this blob answers, so the Mac can show
    /// the transfer before <c>command_status</c> arrives. Omitted when null (the reference serializes it after
    /// <c>chunks</c>, and so does this record's property order).
    /// </summary>
    [JsonPropertyName("commandId")] public string? CommandId { get; init; }
    /// <summary>Receiver-side resume state; senders omit it.</summary>
    [JsonPropertyName("committedParts")] public IReadOnlyList<int>? CommittedParts { get; init; }
}

public static class RecordJson
{
    /// <summary>Deserialize and validate a record of a known type.</summary>
    public static T Parse<T>(ReadOnlySpan<byte> utf8) where T : IvyRecord
    {
        var r = IvyJson.Deserialize<T>(utf8);
        r.Validate();
        return r;
    }
}
