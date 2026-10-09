using SkiaSharp;

namespace Ivy.Collectors.Thumbnails;

/// <summary>
/// PDF first page via PDFtoImage (PDFium, MIT/BSD). Native PDFium ships for win-x64/x86/arm64, osx and linux,
/// so this is exercised by the macOS tests too.
/// </summary>
public sealed class PdfToImageRenderer : IPdfPageRenderer
{
    public static bool IsAvailable => OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() || OperatingSystem.IsLinux();

    /// <summary>Needs a seekable stream (the page size is read first).</summary>
    public SKBitmap? RenderFirstPage(Stream pdf, int maxEdge)
    {
        if (!(OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() || OperatingSystem.IsLinux())) return null;
        try
        {
            // Size the render from the page box so the long edge is maxEdge (Width+Height together would stretch).
            var start = pdf.CanSeek ? pdf.Position : 0;
            var size = PDFtoImage.Conversion.GetPageSize(pdf, 0, leaveOpen: true, password: null);
            if (pdf.CanSeek) pdf.Position = start;
            if (size.Width <= 0 || size.Height <= 0) return null;
            var landscape = size.Width >= size.Height;
            var options = new PDFtoImage.RenderOptions
            {
                Width = landscape ? maxEdge : null,
                Height = landscape ? null : maxEdge,
                WithAspectRatio = true,
                WithAnnotations = true,
                BackgroundColor = SKColors.White,
            };
            return PDFtoImage.Conversion.ToImage(pdf, page: 0, leaveOpen: true, password: null, options: options);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            // Encrypted, damaged or unsupported PDFs simply get no thumbnail.
            return null;
        }
    }
}
