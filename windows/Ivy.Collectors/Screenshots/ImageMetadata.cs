using System.Globalization;
using MetadataExtractor;
using MetadataExtractor.Formats.Exif;
using SkiaSharp;

namespace Ivy.Collectors.Screenshots;

/// <summary>Width/height (SkiaSharp codec header read) and EXIF DateTimeOriginal (MetadataExtractor).</summary>
public static class ImageMetadata
{
    public static (int Width, int Height)? Dimensions(Stream s)
    {
        try
        {
            using var codec = SKCodec.Create(s);
            if (codec is null) return null;
            var info = codec.Info;
            if (info.Width <= 0 || info.Height <= 0) return null;
            var swap = codec.EncodedOrigin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
            return swap ? (info.Height, info.Width) : (info.Width, info.Height);
        }
        catch (Exception e) when (e is not OutOfMemoryException) { return null; }
    }

    /// <summary>
    /// EXIF DateTimeOriginal (falling back to DateTimeDigitized). EXIF times are local wall-clock time; the
    /// OffsetTimeOriginal tag is used when present, otherwise <paramref name="localZone"/>.
    /// </summary>
    public static DateTimeOffset? TakenAt(Stream s, TimeZoneInfo? localZone = null)
    {
        IReadOnlyList<MetadataExtractor.Directory> dirs;
        try { dirs = ImageMetadataReader.ReadMetadata(s); }
        catch (Exception e) when (e is ImageProcessingException or IOException or ArgumentException or NotSupportedException) { return null; }
        var sub = dirs.OfType<ExifSubIfdDirectory>().FirstOrDefault();
        if (sub is null) return null;
        var raw = sub.GetDescription(ExifDirectoryBase.TagDateTimeOriginal) ?? sub.GetDescription(ExifDirectoryBase.TagDateTimeDigitized);
        if (raw is null || !DateTime.TryParseExact(raw.Trim(), "yyyy:MM:dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var local))
            return null;
        var offsetText = sub.GetDescription(ExifDirectoryBase.TagTimeZoneOriginal);
        if (offsetText is not null && TimeSpan.TryParseExact(offsetText.Trim().TrimStart('+', '-'), @"hh\:mm", CultureInfo.InvariantCulture, out var off))
            return new DateTimeOffset(local, offsetText.Trim().StartsWith('-') ? -off : off);
        var zone = localZone ?? TimeZoneInfo.Local;
        return new DateTimeOffset(local, zone.GetUtcOffset(local));
    }
}
