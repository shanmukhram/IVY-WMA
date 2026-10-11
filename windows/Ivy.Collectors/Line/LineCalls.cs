using System.Globalization;
using System.Text.Json;
using Ivy.Core.Records;

namespace Ivy.Collectors.Line;

/// <summary>
/// Reads LINE's call record (content type 6) from a message's <c>_contentMetadata</c> JSON. LINE writes each
/// audio/video call into the chat as a message whose metadata holds <c>TYPE</c> (A audio, V video),
/// <c>RESULT</c> (NORMAL, NO_RESPONSE, REJECTED, CANCELED) and <c>DURATION</c> in milliseconds. Values we do
/// not recognise become <c>unknown</c> rather than a guess. The row's <c>_text</c> (LINE's own system string)
/// is kept as the message text; the Mac renders this object instead.
/// </summary>
public static class LineCalls
{
    public const long CallContentType = 6;

    /// <summary>The call object for a content-type-6 row; null for any other type or unparseable metadata.</summary>
    public static MessageCall? FromContentMetadata(long? contentType, string? metaJson, bool? fromMe)
    {
        if (contentType != CallContentType || string.IsNullOrWhiteSpace(metaJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(metaJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var kind = Str(root, "TYPE") switch
            {
                "A" => "audio",
                "V" => "video",
                _ => "unknown",
            };
            var outcome = Str(root, "RESULT") switch
            {
                "NORMAL" => "completed",
                "NO_RESPONSE" => "missed",
                "REJECTED" => "declined",
                "CANCELED" => "cancelled",
                _ => "unknown",
            };
            long? durationSec = null;
            if (outcome == "completed" && Millis(root, "DURATION") is long ms && ms >= 0)
                durationSec = (long)Math.Round(ms / 1000.0, MidpointRounding.AwayFromZero);

            return new MessageCall
            {
                Kind = kind,
                Outcome = outcome,
                DurationSec = durationSec,
                Direction = fromMe switch { true => "outgoing", false => "incoming", null => null },
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? Str(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>LINE stores DURATION as a string of digits; accept a JSON number too.</summary>
    private static long? Millis(JsonElement obj, string key)
    {
        if (!obj.TryGetProperty(key, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
        if (v.ValueKind == JsonValueKind.String &&
            long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s)) return s;
        return null;
    }
}
