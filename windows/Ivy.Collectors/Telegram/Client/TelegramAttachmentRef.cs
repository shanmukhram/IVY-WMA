using TL;

namespace Ivy.Collectors.Telegram.Client;

/// <summary>
/// A self-contained handle for one Telegram attachment original, stable enough to resolve to bytes later (the
/// media-policy download and an on-request <c>file_request</c>, WT4). It carries the MTProto file-location
/// fields so a download needs no live message object — important because an on-request fetch may arrive long
/// after the message was mapped, even across a restart. Encoded as a short text string so it round-trips
/// through the collector's SQLite <c>att_ref</c> column and the wire <c>fileId = "tg:&lt;ref&gt;"</c>.
/// </summary>
public sealed record TelegramAttachmentRef(
    char Kind,          // 'd' = document, 'p' = photo
    long Id,
    long AccessHash,
    int DcId,
    long Size,
    string? ThumbType,  // photo size letter; null for documents (full file)
    byte[] FileReference)
{
    public string Encode()
    {
        var parts = new[]
        {
            Kind.ToString(),
            Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
            AccessHash.ToString(System.Globalization.CultureInfo.InvariantCulture),
            DcId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            Size.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ThumbType ?? "",
            Convert.ToBase64String(FileReference),
        };
        return string.Join('|', parts);
    }

    public static bool TryDecode(string s, out TelegramAttachmentRef? reference)
    {
        reference = null;
        var p = s.Split('|');
        if (p.Length != 7 || p[0].Length != 1) return false;
        if (!long.TryParse(p[1], out var id) || !long.TryParse(p[2], out var ah) ||
            !int.TryParse(p[3], out var dc) || !long.TryParse(p[4], out var size)) return false;
        byte[] fileRef;
        try { fileRef = Convert.FromBase64String(p[6]); }
        catch (FormatException) { return false; }
        reference = new TelegramAttachmentRef(p[0][0], id, ah, dc, size, p[5].Length == 0 ? null : p[5], fileRef);
        return true;
    }

    /// <summary>Rebuild the MTProto location for <c>upload.getFile</c>.</summary>
    public InputFileLocationBase ToFileLocation() => Kind == 'p'
        ? new InputPhotoFileLocation { id = Id, access_hash = AccessHash, file_reference = FileReference, thumb_size = ThumbType ?? "" }
        : new InputDocumentFileLocation { id = Id, access_hash = AccessHash, file_reference = FileReference, thumb_size = "" };
}
