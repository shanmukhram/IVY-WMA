# @ivy/mac-ocr

This package does local OCR and thumbnails for the IVY Mac dashboard (PRD M1 and M3). It uses Apple Vision and ImageIO and nothing leaves the machine. It has no database dependency: `mac/service` calls it and indexes the text it returns.

There are two parts:

- `swift/` is a Swift package that builds `ivy-ocr`, a long-running helper. It reads requests from stdin and writes results to stdout, one JSON object per line.
- `src/` is a TypeScript wrapper. It keeps one helper process warm, sends it requests and matches each reply to its request by id.

## Build

You need macOS 13 or later and a Swift toolchain. The Xcode Command Line Tools are enough; `xcodebuild` is not used.

```sh
pnpm --filter @ivy/mac-ocr run build:swift   # swift build -c release --package-path swift
pnpm --filter @ivy/mac-ocr run build         # tsc -> dist/
pnpm --filter @ivy/mac-ocr test              # vitest, real Vision on this Mac
pnpm --filter @ivy/mac-ocr run ocr <path...> [--thumb <dir>] [--json]
```

You do not have to build the helper yourself. The wrapper finds the binary in this order:

1. `binaryPath`, if passed to `createOcr()`.
2. The `IVY_OCR_BIN` environment variable.
3. `swift/.build/release/ivy-ocr`.

For option 3, the wrapper runs `swift build -c release` on first use if the binary is missing or older than the Swift sources.

Errors:

- No `swift` on PATH: the request fails with `OcrError` code `toolchain_missing`, which says to run `xcode-select --install`. If a stale binary exists, the wrapper uses it instead.
- Compile errors: code `build_failed`.
- Not running on macOS: code `unsupported_platform`.

## API

```ts
import { createOcr } from "@ivy/mac-ocr";

const ocr = createOcr({ concurrency: 4, timeoutMs: 60_000 });
const r = await ocr.recognize("/abs/screenshot.png", { thumb: { path: "/vault/thumbs/abc.jpg", maxEdge: 256 } });
r.text;      // lines top-to-bottom, "\n\n" between well-separated blocks
r.lines;     // [{ text, confidence, box: { x, y, w, h } }]: normalized, top-left origin, oriented image
r.width; r.height; r.orientation; r.format; r.pages /* PDF */; r.thumb; r.thumbError; r.ms; r.ocrMs
await ocr.thumbnail("/abs/photo.heic", "/vault/thumbs/def.jpg", 256); // -> { path, width, height }, no OCR
await ocr.close();
```

### `createOcr(options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `concurrency` | 4 | Maximum requests in flight in the helper, which runs this many Vision workers. Extra requests wait in a FIFO queue. |
| `timeoutMs` | 60000 | Timeout for each request, counted from when it is sent to the helper. When a request times out, it is rejected with `timeout`, the helper is killed and restarted, and the other in-flight requests are sent again. |
| `maxAttempts` | 2 | How many times a request can be in flight when the helper crashes before it fails with `process_crashed`. After a crash, requests that were in flight are re-sent one at a time. This way a file that crashes the helper only uses up its own attempts. |
| `autoBuild` | true | Build the Swift helper if it is missing or stale. |
| `binaryPath`, `env`, `onLog` | | Override the binary, add environment variables for the helper, and receive the helper's stderr and lifecycle log lines. |

### Behavior

- The helper starts on the first request.
- If the helper dies, the wrapper restarts it on the next request.
- After 5 crashes in a row with no successful reply, all queued requests fail with `crash_loop`.
- An idle helper does not keep the Node event loop alive.
- `close()` lets in-flight requests finish, rejects queued ones with `closed`, and ends the helper.

### Errors

Errors are `OcrError` with `code` and `path`. Codes reported by the helper are `not_found`, `unreadable`, `bad_request`, `ocr_failed`, `thumb_failed` and `internal`. Any of these fails only that one request.

If only the thumbnail fails, `recognize()` still resolves with the OCR result and sets `thumbError`. `thumbnail()` rejects with `thumb_failed`.

## Wire protocol (`ivy-ocr --workers N`)

Each request is one JSON object per stdin line:

```json
{"id": "r1", "path": "/abs/file.heic", "ocr": true, "languages": ["en-US"], "thumb": {"path": "/abs/t.jpg", "maxEdge": 256, "quality": 0.8}}
{"id": "p", "op": "ping"}
```

Each response is one JSON object per stdout line. With more than one worker, responses can come back out of order, so match them by `id`:

```json
{"id": "r1", "ok": true, "path": "...", "format": "heic", "width": 3024, "height": 4032, "orientation": 6,
 "text": "...", "lines": [{"text": "...", "confidence": 1, "box": {"x": 0.03, "y": 0.08, "w": 0.29, "h": 0.07}}],
 "confidence": 0.98, "thumb": {"path": "/abs/t.jpg", "width": 192, "height": 256}, "ms": 412.3, "ocrMs": 390.1}
{"id": "r2", "error": "file not found: /x.png", "code": "not_found"}
```

- A line that is not valid JSON gets `{"id": null, "code": "bad_request"}`.
- When stdin closes, the helper finishes in-flight work and exits with status 0.
- When `IVY_OCR_DEBUG=1` is set, two extra ops are accepted for tests: `sleep` (`ms`) and `exit`.

### Vision settings

- Recognition level is `accurate` and language correction is on.
- `automaticallyDetectsLanguage` is on unless you pass `languages`.
- EXIF orientation is passed to Vision, so boxes refer to the image as it is displayed.
- Reading order: lines are grouped into rows by vertical overlap, sorted top to bottom, and sorted left to right within a row. Items on the same row are joined with a space. A blank line is inserted when the vertical gap between rows is larger than the median line height.

## Supported formats

| Format | Notes |
| --- | --- |
| PNG, JPEG, HEIC/HEIF, TIFF, WebP | Decoded by ImageIO. Any other ImageIO type also works, for example GIF, BMP, AVIF and camera RAW. `ping` returns the list as `readTypes`. EXIF orientation is applied to OCR, to the reported size and to thumbnails. Multi-image files use the primary image. |
| PDF | Detected by its `%PDF-` header or its extension. Only page 1 is rendered and OCR'd. It is rendered on white at 2x, with the long edge capped at 8000 px, using the CropBox and `/Rotate`. `pages` reports the total page count. Encrypted PDFs fail with `unreadable` unless they open with an empty password. |

Thumbnails are always JPEG at quality 0.8 by default. Transparency is flattened onto white. The long edge is at most `maxEdge` (8 to 8192), and images are never upscaled. The pixels are rotated to display orientation (EXIF 1). Files are written atomically (temp file, then rename) and parent directories are created.

## Measured performance

Measured on Apple Silicon with the warm helper. The numbers come from the test suite and the CLI:

| Input | Time |
| --- | --- |
| 1200x600 PNG or HEIC, 3 lines | about 70 ms each |
| PDF page 1 (1224x1584 render) | about 87 ms |
| 600x900 rotated JPEG | about 40 ms |
| 3024x4032 PNG, 40 lines | about 700 ms |
| First request, including starting the helper | about 250 ms |
| 20 requests at concurrency 4 | about 80 ms per image |

Running requests concurrently does not increase throughput, apparently because Vision serializes the work internally. Concurrency mainly keeps a slow image from blocking the queue.

## Limits and known gaps

- Only page 1 of a PDF is OCR'd. A PDF's embedded text layer is not used.
- The whole image is decoded at full resolution for OCR. Very large images, for example 100 MP or more, use a lot of memory. They are not downscaled first.
- Reading order is a geometric heuristic. Multi-column layouts on the same rows are merged left to right, and there is no column detection.
- Vertical CJK text and handwriting depend entirely on what Vision supports.
- The tests cannot create a WebP fixture with ImageIO, which decodes WebP but cannot encode it. They use `cwebp` when it is installed and skip the WebP test otherwise.
