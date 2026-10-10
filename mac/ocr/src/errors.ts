export type OcrErrorCode =
  // Reported by the helper
  | "bad_request"
  | "not_found"
  | "unreadable"
  | "ocr_failed"
  | "thumb_failed"
  | "internal"
  // Raised by the wrapper
  | "timeout"
  | "process_crashed"
  | "crash_loop"
  | "closed"
  | "toolchain_missing"
  | "build_failed"
  | "binary_missing"
  | "unsupported_platform";

export class OcrError extends Error {
  readonly code: OcrErrorCode | string;
  readonly path: string | undefined;

  constructor(code: OcrErrorCode | string, message: string, path?: string) {
    super(message);
    this.name = "OcrError";
    this.code = code;
    this.path = path;
  }
}
