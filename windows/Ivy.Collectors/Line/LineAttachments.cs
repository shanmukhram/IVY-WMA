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

    public static IReadOnlyList<MessageAttachment> FromContentMetadata(string msgId, long? contentType, string? metaJson)
    {
        var kind = LineStoreMap.AttachmentKindFor(contentType);
        if (kind is null) return Array.Empty<MessageAttachment>();
        var filename = NameFrom(metaJson) ?? $"{kind}-{msgId}";
        return new[]
        {
            new MessageAttachment
            {
                AttId = msgId + "#0",
                Kind = kind,
                Filename = filename,
                Size = 0,
            },
        };
    }

    private static string? NameFrom(string? metaJson)
    {
        if (string.IsNullOrWhiteSpace(metaJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(metaJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            foreach (var key in NameKeys)
                if (doc.RootElement.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
                {
                    var s = v.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) return s;
                }
        }
        catch (JsonException) { /* not JSON, or not the shape we expect — no filename */ }
        return null;
    }
}
