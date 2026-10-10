/** Normalized box, origin top-left, y down, relative to the displayed (EXIF-oriented) image. */
export interface OcrBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine {
  text: string;
  /** 0..1, from Vision's top candidate. */
  confidence: number;
  box: OcrBox;
}

export interface ThumbResult {
  path: string;
  width: number;
  height: number;
}

export interface OcrResult {
  path: string;
  /** File extension-style format: png, jpeg, heic, webp, tiff, pdf, ... */
  format: string;
  /** Display size (EXIF orientation applied). For PDFs, the 2x render size of page 1. */
  width: number;
  height: number;
  /** EXIF orientation of the source (1..8); 1 for PDFs. */
  orientation: number;
  /** PDFs only: total page count (only page 1 is OCR'd). */
  pages?: number;
  /** Lines in reading order joined with "\n"; a blank line separates well-separated blocks. */
  text: string;
  lines: OcrLine[];
  /** Mean line confidence (0 when no text). */
  confidence: number;
  /** Helper-side total time for this request, ms. */
  ms: number;
  /** Helper-side Vision time, ms. */
  ocrMs: number;
  /** Present when a thumbnail was requested and written. */
  thumb?: ThumbResult;
  /** Present when a thumbnail was requested but failed (OCR result is still valid). */
  thumbError?: string;
}

export interface ThumbOptions {
  /** Output JPEG path (written atomically; parent dirs are created). */
  path: string;
  /** Long edge cap in pixels (never upscales). Default 256. */
  maxEdge?: number;
  /** JPEG quality 0.1..1. Default 0.8. */
  quality?: number;
}

export interface RecognizeOptions {
  /** Also write a thumbnail in the same pass (one decode). */
  thumb?: ThumbOptions;
  /** BCP-47 tags, e.g. ["en-US", "ja-JP"]. Omit for Vision's automatic language detection. */
  languages?: string[];
  /** Per-request timeout override, ms. */
  timeoutMs?: number;
}

export interface CreateOcrOptions {
  /** Path to a prebuilt ivy-ocr binary. Default: env IVY_OCR_BIN, else swift/.build/release/ivy-ocr. */
  binaryPath?: string;
  /** Build the Swift helper if it is missing or older than its sources. Default true. */
  autoBuild?: boolean;
  /** Max requests in flight in the helper (it runs that many Vision workers). Default 4. */
  concurrency?: number;
  /** Per-request timeout, ms. Default 60000. A timeout kills and restarts the helper. */
  timeoutMs?: number;
  /** Attempts per request across helper crashes. Default 2. */
  maxAttempts?: number;
  /** Extra environment for the helper process. */
  env?: NodeJS.ProcessEnv;
  /** Receives helper stderr lines and lifecycle messages. */
  onLog?: (line: string) => void;
}

export interface OcrStats {
  pid: number | undefined;
  restarts: number;
  queued: number;
  inFlight: number;
  completed: number;
  failed: number;
}

export interface OcrClient {
  recognize(path: string, opts?: RecognizeOptions): Promise<OcrResult>;
  /** Thumbnail only (no OCR). Resolves with the written thumbnail. */
  thumbnail(path: string, out: string, maxEdge?: number): Promise<ThumbResult>;
  /** Round-trip to the helper; also starts it. */
  ping(): Promise<{ version: string; pid: number; readTypes: string[] }>;
  /** Send a raw protocol request (debug / advanced). */
  raw(payload: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
  /** Lets in-flight requests finish, rejects queued ones, stops the helper. */
  close(): Promise<void>;
  readonly pid: number | undefined;
  stats(): OcrStats;
}
