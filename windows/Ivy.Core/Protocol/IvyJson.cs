using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ivy.Core.Protocol;

/// <summary>
/// Shared System.Text.Json settings for every wire object. Field names are explicit
/// (<see cref="JsonPropertyNameAttribute"/>) and match the TS zod schemas; optional fields that are
/// null are omitted (like <c>undefined</c> in JSON.stringify); the relaxed encoder keeps base64
/// <c>+</c>/<c>/</c>/<c>=</c> and non-ASCII text unescaped, so ASCII-only objects (manifest, bootstrap,
/// pairing payload) serialize byte-identically to the reference's <c>JSON.stringify</c>.
/// </summary>
public static class IvyJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
        NumberHandling = JsonNumberHandling.Strict,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        AllowTrailingCommas = false,
    };

    /// <summary>Serialize by RUNTIME type, so a record held as <c>IvyRecord</c> keeps its derived fields.</summary>
    public static byte[] SerializeToUtf8<T>(T value) where T : notnull => JsonSerializer.SerializeToUtf8Bytes(value, value.GetType(), Options);

    /// <summary>Serialize by RUNTIME type.</summary>
    public static string Serialize<T>(T value) where T : notnull => JsonSerializer.Serialize(value, value.GetType(), Options);

    public static T Deserialize<T>(ReadOnlySpan<byte> utf8) =>
        JsonSerializer.Deserialize<T>(utf8, Options) ?? throw new JsonException($"null {typeof(T).Name}");

    public static T Deserialize<T>(string json) =>
        JsonSerializer.Deserialize<T>(json, Options) ?? throw new JsonException($"null {typeof(T).Name}");
}

/// <summary>ISO-8601 timestamps in the same shape as JavaScript's <c>Date.prototype.toISOString()</c>.</summary>
public static class IvyTime
{
    public static string Format(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static string Now(TimeProvider? time = null) => Format((time ?? TimeProvider.System).GetUtcNow());

    public static DateTimeOffset Parse(string s) =>
        DateTimeOffset.Parse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
}
