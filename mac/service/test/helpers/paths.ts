/**
 * Platform-neutral path assertions for tests. Production code returns native
 * paths (backslashes on Windows); tests that only care about the shape of a
 * path compare through `slash()`, and tests that care about the exact value
 * build the expectation with `path.resolve` / `path.join`.
 */
import path from "node:path";

/** Same path with every separator written as "/" (a no-op on POSIX). */
export const slash = (p: string): string => p.replace(/\\/g, "/");

/** True when `actual` ends with the given path segments, whatever its separators. */
export function endsWithSegments(actual: string, ...segments: string[]): boolean {
  const a = slash(actual).split("/").filter(Boolean);
  const want = segments.flatMap((s) => slash(s).split("/")).filter(Boolean);
  if (want.length > a.length) return false;
  return want.every((s, i) => a[a.length - want.length + i] === s);
}

/** An absolute path built the way the host OS would for a POSIX-looking input. */
export const abs = (...parts: string[]): string => path.resolve(...parts);

/** The file-mode assertions are POSIX-only: Windows reports 0o666 for any writable file. */
export const posixModes = process.platform !== "win32";
