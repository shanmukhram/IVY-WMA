using System.Text;
using SkiaSharp;

namespace Ivy.Collectors.Tests.Support;

/// <summary>Test fixtures generated in code: PNG/JPEG via SkiaSharp, EXIF injected by hand, a minimal PDF.</summary>
public static class Images
{
    public static byte[] Png(int w, int h, bool transparent = true) => Encode(w, h, SKEncodedImageFormat.Png, transparent);

    public static byte[] Jpeg(int w, int h) => Encode(w, h, SKEncodedImageFormat.Jpeg, false);

    private static byte[] Encode(int w, int h, SKEncodedImageFormat format, bool transparent)
    {
        using var bmp = new SKBitmap(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(bmp))
        {
            canvas.Clear(transparent ? SKColors.Transparent : SKColors.SkyBlue);
            using var paint = new SKPaint { Color = SKColors.Red };
            canvas.DrawRect(0, 0, w / 2f, h / 2f, paint);
        }
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(format, 90);
        return data.ToArray();
    }

    /// <summary>Insert an APP1 EXIF segment (IFD0 → ExifIFD with DateTimeOriginal, optional Orientation) after SOI.</summary>
    public static byte[] WithExif(byte[] jpeg, string dateTimeOriginal, ushort orientation = 1)
    {
        var tiff = new List<byte>();
        void U16(int v) { tiff.Add((byte)v); tiff.Add((byte)(v >> 8)); }
        void U32(long v) { for (var i = 0; i < 4; i++) tiff.Add((byte)(v >> (8 * i))); }
        tiff.AddRange("II"u8.ToArray()); U16(42); U32(8);
        // IFD0 @8: 2 entries (Orientation, ExifIFDPointer), next IFD 0.
        U16(2);
        U16(0x0112); U16(3); U32(1); U16(orientation); U16(0);
        const int exifIfdOffset = 8 + 2 + 2 * 12 + 4;
        U16(0x8769); U16(4); U32(1); U32(exifIfdOffset);
        U32(0);
        // Exif IFD: 1 entry DateTimeOriginal (ASCII, 20 bytes) stored after the IFD.
        var dateOffset = exifIfdOffset + 2 + 12 + 4;
        U16(1);
        U16(0x9003); U16(2); U32(20); U32(dateOffset);
        U32(0);
        tiff.AddRange(Encoding.ASCII.GetBytes(dateTimeOriginal.PadRight(19)[..19]));
        tiff.Add(0);

        var payload = "Exif\0\0"u8.ToArray().Concat(tiff).ToArray();
        var len = payload.Length + 2;
        var seg = new byte[] { 0xFF, 0xE1, (byte)(len >> 8), (byte)len }.Concat(payload);
        return jpeg.Take(2).Concat(seg).Concat(jpeg.Skip(2)).ToArray();
    }

    /// <summary>A one-page PDF (US Letter) with a filled rectangle, xref offsets computed.</summary>
    public static byte[] Pdf()
    {
        var content = "1 0 0 rg 72 72 300 400 re f";
        var objects = new[]
        {
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
            $"<< /Length {content.Length} >>\nstream\n{content}\nendstream",
        };
        var sb = new StringBuilder("%PDF-1.4\n");
        var offsets = new List<int>();
        for (var i = 0; i < objects.Length; i++)
        {
            offsets.Add(Encoding.ASCII.GetByteCount(sb.ToString()));
            sb.Append($"{i + 1} 0 obj\n{objects[i]}\nendobj\n");
        }
        var xref = Encoding.ASCII.GetByteCount(sb.ToString());
        sb.Append($"xref\n0 {objects.Length + 1}\n0000000000 65535 f \n");
        foreach (var o in offsets) sb.Append($"{o:D10} 00000 n \n");
        sb.Append($"trailer\n<< /Size {objects.Length + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return Encoding.ASCII.GetBytes(sb.ToString());
    }
}
