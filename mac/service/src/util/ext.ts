import { win32 } from "node:path";
import { openSync, readSync, closeSync } from "node:fs";

/** Extension (lowercase, no dot) of a device path; Windows and POSIX separators both work. */
export function extOf(p: string | undefined | null): string | undefined {
  if (!p) return undefined;
  const e = win32.extname(p).replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(e) ? e : undefined;
}

/** Base name of a device path (either separator). */
export function baseName(p: string): string {
  return win32.basename(p);
}

/** Sniff a file type from magic bytes; undefined when unknown. */
export function sniffExt(head: Uint8Array): string | undefined {
  const b = head;
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  if (at(0, 0x42, 0x4d)) return "bmp";
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return "pdf";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "heic";
    if (/^(avif)$/.test(brand)) return "avif";
    return "mp4";
  }
  return undefined;
}

export function sniffFile(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return sniffExt(buf.subarray(0, n));
  } finally { closeSync(fd); }
}

export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "avif", "tif", "tiff"]);
