export { createOcr } from "./client.js";
export { OcrError, type OcrErrorCode } from "./errors.js";
export { buildSwift, defaultBinaryPath, ensureBinary, fixtureBinaryPath, swiftPackageDir } from "./binary.js";
export type {
  CreateOcrOptions,
  OcrBox,
  OcrClient,
  OcrLine,
  OcrResult,
  OcrStats,
  RecognizeOptions,
  ThumbOptions,
  ThumbResult,
} from "./types.js";

/** Extensions the helper accepts (anything ImageIO decodes also works). */
export const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp", ".tif", ".tiff", ".pdf", ".gif", ".bmp"] as const;
