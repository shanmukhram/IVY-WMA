using Ivy.Collectors.Screenshots;
using Ivy.Collectors.Tests.Support;
using Ivy.Collectors.Thumbnails;
using SkiaSharp;

namespace Ivy.Collectors.Tests;

public class ThumbnailTests
{
    private static (int W, int H, SKEncodedImageFormat F) Probe(byte[] jpeg)
    {
        using var codec = SKCodec.Create(new MemoryStream(jpeg));
        return (codec.Info.Width, codec.Info.Height, codec.EncodedFormat);
    }

    [Fact]
    public void Png_with_alpha_becomes_a_256px_jpeg()
    {
        var g = new ThumbnailGenerator();
        Assert.True(g.Supports("png"));
        var thumb = g.Generate(new MemoryStream(Images.Png(1024, 512)), "png")!;
        Assert.Equal((256, 128, SKEncodedImageFormat.Jpeg), Probe(thumb));
        // Transparent areas are flattened onto white, not black.
        using var bmp = SKBitmap.Decode(thumb);
        var px = bmp.GetPixel(200, 100);
        Assert.True(px.Red > 240 && px.Green > 240 && px.Blue > 240, $"expected white, got {px}");
        var red = bmp.GetPixel(10, 10);
        Assert.True(red.Red > 200 && red.Green < 60, $"expected red, got {red}");
    }

    [Fact]
    public void Jpeg_portrait_fits_the_long_edge()
    {
        var thumb = new ThumbnailGenerator().Generate(new MemoryStream(Images.Jpeg(600, 1200)), "jpg")!;
        Assert.Equal((128, 256, SKEncodedImageFormat.Jpeg), Probe(thumb));
    }

    [Fact]
    public void Exif_orientation_is_applied()
    {
        // Stored landscape 400x200 with Orientation=6 (rotate 90° CW) displays as portrait.
        var jpeg = Images.WithExif(Images.Jpeg(400, 200), "2025:01:02 03:04:05", orientation: 6);
        var thumb = new ThumbnailGenerator().Generate(new MemoryStream(jpeg), "jpeg")!;
        Assert.Equal((128, 256, SKEncodedImageFormat.Jpeg), Probe(thumb));
        Assert.Equal((200, 400), ImageMetadata.Dimensions(new MemoryStream(jpeg)));
    }

    [Fact]
    public void Small_images_are_not_upscaled_and_garbage_returns_null()
    {
        var g = new ThumbnailGenerator();
        Assert.Equal((100, 50, SKEncodedImageFormat.Jpeg), Probe(g.Generate(new MemoryStream(Images.Png(100, 50)), "png")!));
        Assert.Null(g.Generate(new MemoryStream("not an image"u8.ToArray()), "png"));
        Assert.False(g.Supports("txt"));
    }

    [Fact]
    public void Pdf_first_page_is_rendered()
    {
        var g = ThumbnailGenerator.CreateDefault();
        Assert.True(g.Supports("pdf"));
        var thumb = g.Generate(new MemoryStream(Images.Pdf()), "pdf");
        Assert.NotNull(thumb);
        var (w, h, f) = Probe(thumb!);
        Assert.Equal(SKEncodedImageFormat.Jpeg, f);
        Assert.Equal(256, h);                       // 612x792 portrait → long edge 256
        Assert.InRange(w, 196, 200);
        Assert.Null(g.Generate(new MemoryStream("%PDF-1.4 broken"u8.ToArray()), "pdf"));
        Assert.False(new ThumbnailGenerator(pdf: null).Supports("pdf"));
    }
}
