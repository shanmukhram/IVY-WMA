using SkiaSharp;

namespace Ivy.Collectors.Thumbnails;

/// <summary>Renders a PDF's first page. Behind an interface so a platform without PDFium can opt out.</summary>
public interface IPdfPageRenderer
{
    /// <summary>First page fitted inside <paramref name="maxEdge"/>², or null when the PDF cannot be rendered.</summary>
    SKBitmap? RenderFirstPage(Stream pdf, int maxEdge);
}

public interface IThumbnailGenerator
{
    bool Supports(string ext);

    /// <summary>JPEG bytes no larger than <see cref="ThumbnailGenerator.MaxEdge"/> on the long edge, or null if the source cannot be decoded.</summary>
    byte[]? Generate(Stream source, string ext);
}

/// <summary>
/// WC2 thumbnails: images (JPEG, PNG, GIF, BMP, WebP via SkiaSharp, EXIF orientation applied) and PDF
/// first pages (via <see cref="IPdfPageRenderer"/>), 256 px on the long edge, JPEG, transparent areas on white.
/// SkiaSharp is used instead of System.Drawing (Windows-only) so this runs and is tested on macOS.
/// </summary>
public sealed class ThumbnailGenerator : IThumbnailGenerator
{
    public const int MaxEdge = 256;
    public const int JpegQuality = 80;

    /// <summary>Refuse to decode images above this many pixels (decompression bombs).</summary>
    public const long MaxSourcePixels = 200_000_000;

    private static readonly HashSet<string> ImageExts = new(StringComparer.OrdinalIgnoreCase) { "jpg", "jpeg", "jfif", "png", "gif", "bmp", "webp" };

    private readonly IPdfPageRenderer? _pdf;

    public ThumbnailGenerator(IPdfPageRenderer? pdf = null) => _pdf = pdf;

    /// <summary>Default generator with PDF support where PDFium is available (Windows, macOS, Linux).</summary>
    public static ThumbnailGenerator CreateDefault() => new(PdfToImageRenderer.IsAvailable ? new PdfToImageRenderer() : null);

    public bool Supports(string ext) => ImageExts.Contains(ext) || (_pdf is not null && ext.Equals("pdf", StringComparison.OrdinalIgnoreCase));

    public byte[]? Generate(Stream source, string ext)
    {
        if (ext.Equals("pdf", StringComparison.OrdinalIgnoreCase))
        {
            if (_pdf is null) return null;
            using var page = _pdf.RenderFirstPage(source, MaxEdge);
            if (page is null) return null;
            using var fitted = Fit(page, SKEncodedOrigin.TopLeft);
            return Encode(fitted);
        }
        if (!ImageExts.Contains(ext)) return null;
        using var data = SKData.Create(source);
        if (data is null) return null;
        using var codec = SKCodec.Create(data);
        if (codec is null) return null;
        var info = codec.Info;
        if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > MaxSourcePixels) return null;

        // Let the codec downscale while decoding where it can (JPEG: 1/2, 1/4, 1/8).
        var scale = Math.Min(1f, (float)MaxEdge / Math.Max(info.Width, info.Height));
        var dims = codec.GetScaledDimensions(scale);
        // The codec rounds to the scales it supports (e.g. 5/8); never decode below the target size.
        var target = Math.Min(MaxEdge, Math.Max(info.Width, info.Height));
        if (dims.Width < 1 || dims.Height < 1 || Math.Max(dims.Width, dims.Height) < target) dims = new SKSizeI(info.Width, info.Height);
        var decodeInfo = new SKImageInfo(dims.Width, dims.Height, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var bitmap = new SKBitmap(decodeInfo);
        var result = codec.GetPixels(decodeInfo, bitmap.GetPixels());
        if (result is not (SKCodecResult.Success or SKCodecResult.IncompleteInput))
        {
            // Some codecs cannot scale; decode full size.
            if (dims.Width == info.Width && dims.Height == info.Height) return null;
            var full = new SKImageInfo(info.Width, info.Height, SKColorType.Rgba8888, SKAlphaType.Premul);
            using var fb = new SKBitmap(full);
            var r2 = codec.GetPixels(full, fb.GetPixels());
            if (r2 is not (SKCodecResult.Success or SKCodecResult.IncompleteInput)) return null;
            using var f2 = Fit(fb, codec.EncodedOrigin);
            return Encode(f2);
        }
        using var fittedImage = Fit(bitmap, codec.EncodedOrigin);
        return Encode(fittedImage);
    }

    /// <summary>Resize to fit MaxEdge (never upscale), apply the EXIF origin, flatten onto white.</summary>
    internal static SKBitmap Fit(SKBitmap src, SKEncodedOrigin origin)
    {
        var s = Math.Min(1f, (float)MaxEdge / Math.Max(src.Width, src.Height));
        var w = Math.Max(1, (int)Math.Round(src.Width * s));
        var h = Math.Max(1, (int)Math.Round(src.Height * s));
        var swap = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
        var outW = swap ? h : w;
        var outH = swap ? w : h;
        var output = new SKBitmap(new SKImageInfo(outW, outH, SKColorType.Rgba8888, SKAlphaType.Premul));
        using var canvas = new SKCanvas(output);
        canvas.Clear(SKColors.White);
        canvas.SetMatrix(OriginMatrix(origin, w, h));
        using var image = SKImage.FromBitmap(src);
        var sampling = new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear);
        canvas.DrawImage(image, new SKRect(0, 0, src.Width, src.Height), new SKRect(0, 0, w, h), sampling, null);
        canvas.Flush();
        return output;
    }

    /// <summary>Maps the stored (w×h) image to display orientation (EXIF 1–8).</summary>
    private static SKMatrix OriginMatrix(SKEncodedOrigin origin, float w, float h) => origin switch
    {
        SKEncodedOrigin.TopRight => new SKMatrix(-1, 0, w, 0, 1, 0, 0, 0, 1),
        SKEncodedOrigin.BottomRight => new SKMatrix(-1, 0, w, 0, -1, h, 0, 0, 1),
        SKEncodedOrigin.BottomLeft => new SKMatrix(1, 0, 0, 0, -1, h, 0, 0, 1),
        SKEncodedOrigin.LeftTop => new SKMatrix(0, 1, 0, 1, 0, 0, 0, 0, 1),
        SKEncodedOrigin.RightTop => new SKMatrix(0, -1, h, 1, 0, 0, 0, 0, 1),
        SKEncodedOrigin.RightBottom => new SKMatrix(0, -1, h, -1, 0, w, 0, 0, 1),
        SKEncodedOrigin.LeftBottom => new SKMatrix(0, 1, 0, -1, 0, w, 0, 0, 1),
        _ => SKMatrix.Identity,
    };

    private static byte[] Encode(SKBitmap bitmap)
    {
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Jpeg, JpegQuality);
        return data.ToArray();
    }
}
