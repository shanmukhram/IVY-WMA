import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, openSync, fsyncSync, closeSync, createReadStream } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";

export function ensureDir(d: string): string {
  mkdirSync(d, { recursive: true });
  return d;
}

/** Atomic write: tmp + fsync + rename. */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode });
  const fd = openSync(tmp, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

export function readJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function removeQuietly(p: string | null | undefined): boolean {
  if (!p) return false;
  try {
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  } catch { return false; }
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
