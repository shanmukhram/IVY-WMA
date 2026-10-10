// ivy-ocr: long-running OCR + thumbnail helper for the IVY Mac service.
//
// Protocol: newline-delimited JSON. One request per stdin line, one response per stdout line.
// Responses can arrive out of order when --workers > 1; match them by "id".
//
// Request:  {"id": <any>, "op": "recognize"?, "path": "/abs/file", "ocr": true?, "languages": [..]?,
//            "thumb": {"path": "/abs/out.jpg", "maxEdge": 256?, "quality": 0.8?}?}
//           {"id": <any>, "op": "ping"}
// Response: {"id": <any>, "ok": true, ...} or {"id": <any>, "error": "...", "code": "..."}
//
// Every failure is reported as an error line; the process keeps serving.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

let helperVersion = "0.1.0"

// MARK: - Errors

struct HelperError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

// MARK: - Output

final class Output {
    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    func send(_ obj: [String: Any]) {
        var data: Data
        if JSONSerialization.isValidJSONObject(obj),
           let d = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) {
            data = d
        } else {
            // Should not happen (all numbers are sanitised), but never crash over it.
            let fallback: [String: Any] = [
                "id": obj["id"] ?? NSNull(),
                "error": "internal: response not serialisable",
                "code": "internal",
            ]
            data = (try? JSONSerialization.data(withJSONObject: fallback)) ?? Data("{\"id\":null,\"error\":\"internal\",\"code\":\"internal\"}".utf8)
        }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        do {
            try handle.write(contentsOf: data)
        } catch {
            // Parent went away; nothing left to serve.
            exit(0)
        }
    }
}

let output = Output()

/// Rounds and guards against NaN/Inf; NSDecimalNumber keeps the JSON short ("0.08333", not "0.0833300000001").
func finite(_ v: Double, _ places: Double = 100000) -> NSNumber {
    guard v.isFinite else { return 0 }
    let r = (v * places).rounded() / places
    return NSDecimalNumber(string: String(format: "%.\(Int(log10(places)))f", r))
}

// MARK: - Loading

struct Loaded {
    let image: CGImage            // decoded pixels, as stored
    let orientation: CGImagePropertyOrientation
    let width: Int                // display width (orientation applied)
    let height: Int               // display height (orientation applied)
    let format: String
    let pages: Int?               // PDFs only
    let source: CGImageSource?    // raster only (used for thumbnails)
    let sourceIndex: Int
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
let maxPdfEdge: CGFloat = 8000

func isPDF(_ url: URL) -> Bool {
    if url.pathExtension.lowercased() == "pdf" { return true }
    guard let fh = try? FileHandle(forReadingFrom: url) else { return false }
    defer { try? fh.close() }
    let head = (try? fh.read(upToCount: 5)) ?? Data()
    return head == Data("%PDF-".utf8)
}

func loadImage(path: String) throws -> Loaded {
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else {
        throw HelperError("not_found", "file not found: \(path)")
    }
    guard !isDir.boolValue else { throw HelperError("unreadable", "path is a directory: \(path)") }
    guard FileManager.default.isReadableFile(atPath: path) else {
        throw HelperError("unreadable", "file not readable (permissions): \(path)")
    }
    let url = URL(fileURLWithPath: path)
    if isPDF(url) { return try loadPDF(url: url) }

    let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let src = CGImageSourceCreateWithURL(url as CFURL, srcOpts),
          let type = CGImageSourceGetType(src) as String?,
          CGImageSourceGetCount(src) > 0
    else {
        throw HelperError("unreadable", "not a decodable image: \(path)")
    }
    if type == UTType.pdf.identifier { return try loadPDF(url: url) }

    let index = CGImageSourceGetPrimaryImageIndex(src)
    let props = CGImageSourceCopyPropertiesAtIndex(src, index, nil) as? [CFString: Any] ?? [:]
    let rawOrientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up

    let decodeOpts = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
    guard let image = CGImageSourceCreateImageAtIndex(src, index, decodeOpts) else {
        throw HelperError("unreadable", "image data could not be decoded (\(type)): \(path)")
    }
    let swaps = [.left, .leftMirrored, .right, .rightMirrored].contains(orientation)
    let format = UTType(type)?.preferredFilenameExtension ?? type
    return Loaded(
        image: image, orientation: orientation,
        width: swaps ? image.height : image.width,
        height: swaps ? image.width : image.height,
        format: format, pages: nil, source: src, sourceIndex: index
    )
}

/// Renders page 1 at 2x (long edge capped at maxPdfEdge) onto white.
func loadPDF(url: URL) throws -> Loaded {
    guard let doc = CGPDFDocument(url as CFURL) else {
        throw HelperError("unreadable", "not a readable PDF: \(url.path)")
    }
    if doc.isEncrypted && !doc.isUnlocked && !doc.unlockWithPassword("") {
        throw HelperError("unreadable", "PDF is password protected: \(url.path)")
    }
    guard doc.numberOfPages > 0, let page = doc.page(at: 1) else {
        throw HelperError("unreadable", "PDF has no pages: \(url.path)")
    }
    let box = page.getBoxRect(.cropBox)
    let rot = ((Int(page.rotationAngle) % 360) + 360) % 360
    var w = box.width, h = box.height
    if rot == 90 || rot == 270 { swap(&w, &h) }
    guard w >= 1, h >= 1 else { throw HelperError("unreadable", "PDF page has empty bounds: \(url.path)") }
    let scale = min(2.0, maxPdfEdge / max(w, h))
    let pw = max(1, Int((w * scale).rounded(.up)))
    let ph = max(1, Int((h * scale).rounded(.up)))
    guard let ctx = CGContext(
        data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else {
        throw HelperError("internal", "could not allocate \(pw)x\(ph) bitmap for PDF render")
    }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: pw, height: ph))
    ctx.interpolationQuality = .high
    ctx.scaleBy(x: scale, y: scale)
    // Rect equals the (rotated) box size, so this transform only rotates/translates, never scales.
    ctx.concatenate(page.getDrawingTransform(.cropBox, rect: CGRect(x: 0, y: 0, width: w, height: h), rotate: 0, preserveAspectRatio: true))
    ctx.clip(to: box)
    ctx.drawPDFPage(page)
    guard let image = ctx.makeImage() else {
        throw HelperError("internal", "PDF render failed: \(url.path)")
    }
    return Loaded(
        image: image, orientation: .up, width: pw, height: ph, format: "pdf",
        pages: doc.numberOfPages, source: nil, sourceIndex: 0
    )
}

// MARK: - OCR

struct Line {
    let text: String
    let confidence: Double
    let box: CGRect   // Vision normalized coords, origin bottom-left
}

func recognize(_ img: Loaded, languages: [String]?) throws -> (text: String, lines: [[String: Any]], confidence: Double) {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if let langs = languages, !langs.isEmpty {
        request.recognitionLanguages = langs
        request.automaticallyDetectsLanguage = false
    } else {
        request.automaticallyDetectsLanguage = true
    }
    let handler = VNImageRequestHandler(cgImage: img.image, orientation: img.orientation, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw HelperError("ocr_failed", "Vision text recognition failed: \(error.localizedDescription)")
    }

    var items: [Line] = (request.results ?? []).compactMap { obs in
        guard let cand = obs.topCandidates(1).first else { return nil }
        let s = cand.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        return Line(text: s, confidence: Double(cand.confidence), box: obs.boundingBox)
    }
    // Reading order: top-to-bottom rows, left-to-right within a row.
    items.sort { $0.box.midY > $1.box.midY }
    var rows: [[Line]] = []
    for it in items {
        if let ref = rows.last?.first {
            let overlap = min(ref.box.maxY, it.box.maxY) - max(ref.box.minY, it.box.minY)
            if overlap > 0.5 * min(ref.box.height, it.box.height) {
                rows[rows.count - 1].append(it)
                continue
            }
        }
        rows.append([it])
    }
    rows = rows.map { $0.sorted { $0.box.minX < $1.box.minX } }

    let heights = items.map { $0.box.height }.sorted()
    let medianHeight = heights.isEmpty ? 0 : heights[heights.count / 2]

    var text = ""
    var prevBottom: CGFloat? = nil
    var outLines: [[String: Any]] = []
    for row in rows {
        let top = row.map { $0.box.maxY }.max() ?? 0
        let bottom = row.map { $0.box.minY }.min() ?? 0
        if let pb = prevBottom {
            // A vertical gap taller than a typical line separates blocks.
            text += (pb - top) > medianHeight * 1.0 ? "\n\n" : "\n"
        }
        text += row.map { $0.text }.joined(separator: " ")
        prevBottom = bottom
        for l in row {
            outLines.append([
                "text": l.text,
                "confidence": finite(l.confidence, 1000),
                // Normalized, origin top-left (y down), relative to the displayed (oriented) image.
                "box": [
                    "x": finite(Double(l.box.minX)),
                    "y": finite(Double(1 - l.box.maxY)),
                    "w": finite(Double(l.box.width)),
                    "h": finite(Double(l.box.height)),
                ],
            ])
        }
    }
    let mean = items.isEmpty ? 0 : items.map { $0.confidence }.reduce(0, +) / Double(items.count)
    return (text, outLines, mean)
}

// MARK: - Thumbnails

/// Flattens onto white (JPEG has no alpha) and optionally scales to `size`.
func flatten(_ image: CGImage, width: Int, height: Int) -> CGImage? {
    guard let ctx = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return ctx.makeImage()
}

func makeThumbnail(_ img: Loaded, out: String, maxEdge: Int, quality: Double) throws -> [String: Any] {
    guard maxEdge >= 8, maxEdge <= 8192 else {
        throw HelperError("bad_request", "thumb.maxEdge must be between 8 and 8192")
    }
    var thumb: CGImage
    if let src = img.source {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
            kCGImageSourceCreateThumbnailWithTransform: true, // applies EXIF orientation
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let t = CGImageSourceCreateThumbnailAtIndex(src, img.sourceIndex, opts as CFDictionary) else {
            throw HelperError("thumb_failed", "ImageIO could not create a thumbnail")
        }
        thumb = t
    } else {
        thumb = img.image
    }
    // Enforce the long-edge cap (PDF path, or any source ImageIO returned larger).
    var tw = thumb.width, th = thumb.height
    let long = max(tw, th)
    if long > maxEdge {
        let s = Double(maxEdge) / Double(long)
        tw = max(1, Int((Double(tw) * s).rounded()))
        th = max(1, Int((Double(th) * s).rounded()))
    }
    guard let flat = flatten(thumb, width: tw, height: th) else {
        throw HelperError("thumb_failed", "could not rasterise thumbnail")
    }
    thumb = flat

    let outURL = URL(fileURLWithPath: out)
    do {
        try FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    } catch {
        throw HelperError("thumb_failed", "cannot create thumbnail directory: \(error.localizedDescription)")
    }
    let tmp = outURL.deletingLastPathComponent()
        .appendingPathComponent(".\(outURL.lastPathComponent).\(getpid()).\(UInt32.random(in: 0...UInt32.max)).tmp")
    guard let dest = CGImageDestinationCreateWithURL(tmp as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw HelperError("thumb_failed", "cannot open thumbnail for writing: \(out)")
    }
    let q = min(1.0, max(0.1, quality))
    CGImageDestinationAddImage(dest, thumb, [kCGImageDestinationLossyCompressionQuality: q] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {
        try? FileManager.default.removeItem(at: tmp)
        throw HelperError("thumb_failed", "JPEG encode failed: \(out)")
    }
    if rename(tmp.path, outURL.path) != 0 {
        let err = String(cString: strerror(errno))
        try? FileManager.default.removeItem(at: tmp)
        throw HelperError("thumb_failed", "cannot move thumbnail into place: \(err)")
    }
    return ["path": out, "width": thumb.width, "height": thumb.height]
}

// MARK: - Request handling

let debugEnabled = ProcessInfo.processInfo.environment["IVY_OCR_DEBUG"] == "1"

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let any = try? JSONSerialization.jsonObject(with: data),
          let req = any as? [String: Any]
    else {
        output.send(["id": NSNull(), "error": "request is not a JSON object", "code": "bad_request"])
        return
    }
    let id = req["id"] ?? NSNull()
    let op = req["op"] as? String ?? "recognize"
    let started = DispatchTime.now()
    func elapsedMs() -> NSNumber {
        finite(Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e6, 10)
    }

    do {
        switch op {
        case "ping":
            let readTypes = (CGImageSourceCopyTypeIdentifiers() as? [String]) ?? []
            output.send(["id": id, "ok": true, "version": helperVersion, "pid": Int(getpid()), "readTypes": readTypes])
        case "sleep" where debugEnabled:
            let ms = (req["ms"] as? NSNumber)?.doubleValue ?? 1000
            Thread.sleep(forTimeInterval: ms / 1000)
            output.send(["id": id, "ok": true])
        case "exit" where debugEnabled:
            // Simulates a helper crash mid-request (tests restart/retry handling).
            exit(3)
        case "recognize":
            guard let path = req["path"] as? String, !path.isEmpty else {
                throw HelperError("bad_request", "missing \"path\"")
            }
            let doOCR = req["ocr"] as? Bool ?? true
            let languages = req["languages"] as? [String]
            let img = try loadImage(path: path)
            var resp: [String: Any] = [
                "id": id, "ok": true, "path": path, "format": img.format,
                "width": img.width, "height": img.height, "orientation": Int(img.orientation.rawValue),
            ]
            if let p = img.pages { resp["pages"] = p }

            if let t = req["thumb"] as? [String: Any] {
                if let out = t["path"] as? String, !out.isEmpty {
                    let maxEdge = (t["maxEdge"] as? NSNumber)?.intValue ?? 256
                    let quality = (t["quality"] as? NSNumber)?.doubleValue ?? 0.8
                    do {
                        resp["thumb"] = try makeThumbnail(img, out: out, maxEdge: maxEdge, quality: quality)
                    } catch let e as HelperError {
                        resp["thumbError"] = e.message
                    }
                } else {
                    resp["thumbError"] = "missing thumb.path"
                }
            }
            if doOCR {
                let ocrStart = DispatchTime.now()
                let r = try recognize(img, languages: languages)
                resp["text"] = r.text
                resp["lines"] = r.lines
                resp["confidence"] = finite(r.confidence, 1000)
                resp["ocrMs"] = finite(Double(DispatchTime.now().uptimeNanoseconds - ocrStart.uptimeNanoseconds) / 1e6, 10)
            }
            resp["ms"] = elapsedMs()
            output.send(resp)
        default:
            throw HelperError("bad_request", "unknown op \"\(op)\"")
        }
    } catch let e as HelperError {
        output.send(["id": id, "error": e.message, "code": e.code, "ms": elapsedMs()])
    } catch {
        output.send(["id": id, "error": "\(error)", "code": "internal", "ms": elapsedMs()])
    }
}

// MARK: - Main loop

signal(SIGPIPE, SIG_IGN)

var workers = 2
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    switch a {
    case "--workers":
        if let v = args.next(), let n = Int(v), n >= 1, n <= 32 { workers = n }
    case "--version":
        print(helperVersion)
        exit(0)
    default:
        FileHandle.standardError.write(Data("ivy-ocr: ignoring unknown argument \(a)\n".utf8))
    }
}

let slots = DispatchSemaphore(value: workers)
let group = DispatchGroup()
let queue = DispatchQueue(label: "ivy.ocr.work", qos: .userInitiated, attributes: .concurrent)

while let raw = readLine(strippingNewline: true) {
    let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if line.isEmpty { continue }
    slots.wait()
    group.enter()
    queue.async {
        autoreleasepool { handle(line) }
        slots.signal()
        group.leave()
    }
}
// stdin closed: finish in-flight work, then exit cleanly.
group.wait()
exit(0)
