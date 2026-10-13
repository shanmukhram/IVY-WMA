using System.Text.Json;
using Ivy.Core.Records;

namespace Ivy.Collectors.Line;

/// <summary>
/// Builds attachment references from a message's content type and <c>_contentMetadata</c> JSON (NOTES.md).
/// LINE's chat media is app-private and not referenced by path in the row, so we emit a reference (kind +
/// best-effort filename) without a blob; originals follow the Windows media policy and are attached later
/// when the file is found under the LINE data folder.
/// </summary>
public static class LineAttachments
{
    private static readonly string[] NameKeys = { "FILE_NAME", "fileName", "title", "url", "linkUrl" };
    // Size is reported by LINE under one of these metadata keys (NOTES.md: images/videos/files carry FILE_SIZE).
    private static readonly string[] SizeKeys = { "FILE_SIZE", "fileSize", "size" };

    public static IReadOnlyList<MessageAttachment> FromContentMetadata(string msgId, long? contentType, string? metaJson)
    {
        var kind = LineStoreMap.AttachmentKindFor(contentType);
        if (kind is null) return Array.Empty<MessageAttachment>();
        var obj = ParseObject(metaJson);
        var filename = NameFrom(obj) ?? $"{kind}-{msgId}";
        // LINE for Windows does not store the media bytes on disk (only server references OID/DOWNLOAD_URL, some
        // E2EE). We carry the real size so the Mac shows every photo/video/file as a labelled item with a
        // placeholder; the original bytes are fetched later (deferred) from LINE's CDN. OriginHash stays null so
        // the Mac treats it as "original on request", never as a dropped attachment.
        var size = SizeFrom(obj);
        return new[]
        {
            new MessageAttachment
            {
                AttId = msgId + "#0",
                Kind = kind,
                Filename = filename,
                Size = size,
            },
        };
    }

    private static JsonElement? ParseObject(string? metaJson)
    {
        if (string.IsNullOrWhiteSpace(metaJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(metaJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            return doc.RootElement.Clone();
        }
        catch (JsonException) { return null; }
    }

    private static string? NameFrom(JsonElement? obj)
    {
        if (obj is not { } o) return null;
        foreach (var key in NameKeys)
            if (o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
            {
                var s = v.GetString();
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }
        return null;
    }

    /// <summary>The media byte size from the metadata, or 0 when LINE does not record it. Never negative.</summary>
    private static long SizeFrom(JsonElement? obj)
    {
        if (obj is not { } o) return 0;
        foreach (var key in SizeKeys)
        {
            if (!o.TryGetProperty(key, out var v)) continue;
            // LINE writes FILE_SIZE as a JSON string ("202482"); accept a number too, defensively.
            if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var s) && s > 0) return s;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) && n > 0) return n;
        }
        return 0;
    }
}
