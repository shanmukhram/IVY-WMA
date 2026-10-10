// ivy-fixture: test-only helper. Renders known text into images/PDFs and probes pixels.
//
//   ivy-fixture image <out> --format png|jpeg|heic|tiff|webp --text "..." [--size 1200x600] [--font 44]
//   ivy-fixture rotated-jpeg <out> --text "..."     (stored landscape, EXIF orientation 6, displays portrait:
//                                                    red band on top, blue band at bottom)
//   ivy-fixture pdf <out> --page "page one text" --page "page two text"
//   ivy-fixture probe <image>                        (JSON: raw size + mean colour of top/bottom/left/right bands)
//   ivy-fixture types                                (JSON: writable ImageIO type identifiers)

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("ivy-fixture: \(msg)\n".utf8))
    exit(2)
}

func parseFlags(_ args: ArraySlice<String>) -> [String: [String]] {
    var out: [String: [String]] = [:]
    var it = args.makeIterator()
    while let a = it.next() {
        guard a.hasPrefix("--") else { fail("unexpected argument \(a)") }
        guard let v = it.next() else { fail("missing value for \(a)") }
        out[String(a.dropFirst(2)), default: []].append(v.replacingOccurrences(of: "\\n", with: "\n"))
    }
    return out
}

func bitmap(_ w: Int, _ h: Int) -> CGContext {
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("bitmap alloc") }
    return ctx
}

func drawText(_ ctx: CGContext, _ text: String, in rect: CGRect, size: CGFloat) {
    let font = CTFontCreateWithName("Helvetica" as CFString, size, nil)
    let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
    ]
    let s = NSAttributedString(string: text, attributes: attrs)
    let fs = CTFramesetterCreateWithAttributedString(s as CFAttributedString)
    let frame = CTFramesetterCreateFrame(fs, CFRange(location: 0, length: 0), CGPath(rect: rect, transform: nil), nil)
    ctx.textMatrix = .identity
    CTFrameDraw(frame, ctx)
}

func textImage(_ text: String, w: Int, h: Int, font: CGFloat) -> CGImage {
    let ctx = bitmap(w, h)
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    drawText(ctx, text, in: CGRect(x: 40, y: 40, width: w - 80, height: h - 80), size: font)
    return ctx.makeImage()!
}

func write(_ image: CGImage, to out: String, type: String, props: [CFString: Any] = [:]) {
    let url = URL(fileURLWithPath: out)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type as CFString, 1, nil) else {
        fail("ImageIO cannot write type \(type)")
    }
    var p = props
    p[kCGImageDestinationLossyCompressionQuality] = 0.92
    CGImageDestinationAddImage(dest, image, p as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { fail("encode failed for \(type)") }
}

func typeFor(_ format: String) -> String {
    switch format.lowercased() {
    case "png": return UTType.png.identifier
    case "jpg", "jpeg": return UTType.jpeg.identifier
    case "heic": return UTType.heic.identifier
    case "tif", "tiff": return UTType.tiff.identifier
    case "webp": return UTType.webP.identifier
    default: fail("unknown format \(format)")
    }
}

func size(_ s: String?, _ dw: Int, _ dh: Int) -> (Int, Int) {
    guard let s = s else { return (dw, dh) }
    let parts = s.split(separator: "x").compactMap { Int($0) }
    guard parts.count == 2 else { fail("bad --size \(s)") }
    return (parts[0], parts[1])
}

func meanColor(_ buf: UnsafeMutablePointer<UInt8>, _ w: Int, _ h: Int, _ bpr: Int, _ r: CGRect) -> [Int] {
    var sum = [0, 0, 0], n = 0
    for y in Int(r.minY)..<Int(r.maxY) {
        for x in Int(r.minX)..<Int(r.maxX) {
            let p = buf + y * bpr + x * 4
            sum[0] += Int(p[0]); sum[1] += Int(p[1]); sum[2] += Int(p[2]); n += 1
        }
    }
    return n == 0 ? [0, 0, 0] : sum.map { $0 / n }
}

let argv = CommandLine.arguments
guard argv.count >= 2 else { fail("usage: ivy-fixture <image|rotated-jpeg|pdf|probe|types> ...") }

switch argv[1] {
case "types":
    let types = (CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? []
    let d = try! JSONSerialization.data(withJSONObject: types)
    print(String(data: d, encoding: .utf8)!)

case "image":
    guard argv.count >= 3 else { fail("image <out> --format ... --text ...") }
    let f = parseFlags(argv.dropFirst(3))
    let (w, h) = size(f["size"]?.first, 1200, 600)
    let font = CGFloat(Double(f["font"]?.first ?? "44") ?? 44)
    let img = textImage(f["text"]?.first ?? "", w: w, h: h, font: font)
    write(img, to: argv[2], type: typeFor(f["format"]?.first ?? "png"))

case "rotated-jpeg":
    guard argv.count >= 3 else { fail("rotated-jpeg <out> --text ...") }
    let f = parseFlags(argv.dropFirst(3))
    // Displayed image D: 600x900 portrait. CG origin is bottom-left.
    let dw = 600, dh = 900
    let d = bitmap(dw, dh)
    d.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); d.fill(CGRect(x: 0, y: 0, width: dw, height: dh))
    d.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1)); d.fill(CGRect(x: 0, y: 700, width: dw, height: 200)) // top
    d.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1)); d.fill(CGRect(x: 0, y: 0, width: dw, height: 200))   // bottom
    drawText(d, f["text"]?.first ?? "ROTATED", in: CGRect(x: 40, y: 240, width: dw - 80, height: 420), size: 48)
    let displayed = d.makeImage()!
    // Stored = D rotated 90 deg counter-clockwise (900x600); EXIF 6 says "rotate 90 CW to display".
    let s = bitmap(dh, dw)
    s.concatenate(CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: CGFloat(dh), ty: 0))
    s.draw(displayed, in: CGRect(x: 0, y: 0, width: dw, height: dh))
    write(s.makeImage()!, to: argv[2], type: UTType.jpeg.identifier, props: [kCGImagePropertyOrientation: 6])

case "pdf":
    guard argv.count >= 3 else { fail("pdf <out> --page ... [--page ...]") }
    let f = parseFlags(argv.dropFirst(3))
    var box = CGRect(x: 0, y: 0, width: 612, height: 792)
    let url = URL(fileURLWithPath: argv[2])
    guard let ctx = CGContext(url as CFURL, mediaBox: &box, nil) else { fail("cannot create PDF") }
    for text in f["page"] ?? [""] {
        ctx.beginPDFPage(nil)
        drawText(ctx, text, in: box.insetBy(dx: 54, dy: 54), size: 28)
        ctx.endPDFPage()
    }
    ctx.closePDF()

case "probe":
    guard argv.count >= 3 else { fail("probe <image>") }
    let url = URL(fileURLWithPath: argv[2])
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot decode \(argv[2])") }
    let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
    let w = img.width, h = img.height
    let ctx = bitmap(w, h)
    // Bitmap memory is top row first.
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    let buf = ctx.data!.bindMemory(to: UInt8.self, capacity: ctx.bytesPerRow * h)
    let bpr = ctx.bytesPerRow
    let band = 0.15
    let out: [String: Any] = [
        "width": w, "height": h,
        "orientation": (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1,
        "top": meanColor(buf, w, h, bpr, CGRect(x: 0, y: 0, width: Double(w), height: Double(h) * band)),
        "bottom": meanColor(buf, w, h, bpr, CGRect(x: 0, y: Double(h) * (1 - band), width: Double(w), height: Double(h) * band)),
        "left": meanColor(buf, w, h, bpr, CGRect(x: 0, y: 0, width: Double(w) * band, height: Double(h))),
        "right": meanColor(buf, w, h, bpr, CGRect(x: Double(w) * (1 - band), y: 0, width: Double(w) * band, height: Double(h))),
    ]
    let d = try! JSONSerialization.data(withJSONObject: out)
    print(String(data: d, encoding: .utf8)!)

default:
    fail("unknown command \(argv[1])")
}
