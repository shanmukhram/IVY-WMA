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

/// <summary><c>file_meta</c> (WC1/WC2): metadata only, original on request.</summary>
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

/// <summary>One collector row in a device report.</summary>
public sealed record CollectorStateRecord
{
    [JsonPropertyName("name")] public required string Name { get; init; }
    [JsonPropertyName("enabled")] public required bool Enabled { get; init; }
    [JsonPropertyName("lastRunAt")] public string? LastRunAt { get; init; }
    [JsonPropertyName("cursor")] public string? Cursor { get; init; }
    [JsonPropertyName("queueDepth")] public required int QueueDepth { get; init; }
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
        foreach (var c in Collectors) NonNegative(c.QueueDepth, "queueDepth");
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
