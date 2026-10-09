import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync,
} from "node:fs";
import { join } from "node:path";
import type { ObjectInfo } from "./types.ts";

interface Meta extends ObjectInfo {
  contentType: string;
  userMeta: Record<string, string>;
}

export interface PartInfo { partNumber: number; etag: string; size: number; lastModified: string }

const md5 = (b: Buffer | string) => createHash("md5").update(b).digest();
const hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Disk layout:
 *   <root>/<bucket>/objects/<sha256(key)>.bin   raw object bytes
 *   <root>/<bucket>/objects/<sha256(key)>.json  metadata (original key, etag, ...)
 *   <root>/<bucket>/uploads/<uploadId>/...      multipart state
 */
export class Store {
  private index = new Map<string, Map<string, Meta>>();
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    for (const b of readdirSync(root, { withFileTypes: true })) {
      if (!b.isDirectory()) continue;
      const m = new Map<string, Meta>();
      const dir = join(root, b.name, "objects");
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as Meta;
          m.set(meta.key, meta);
        }
      }
      this.index.set(b.name, m);
    }
  }

  hasBucket(b: string) { return this.index.has(b); }
  createBucket(b: string): boolean {
    if (this.index.has(b)) return false;
    mkdirSync(join(this.root, b, "objects"), { recursive: true });
    mkdirSync(join(this.root, b, "uploads"), { recursive: true });
    this.index.set(b, new Map());
    return true;
  }
  private objDir(b: string) { return join(this.root, b, "objects"); }
  private paths(b: string, key: string) {
    const h = hex(key);
    return { bin: join(this.objDir(b), h + ".bin"), json: join(this.objDir(b), h + ".json") };
  }

  put(b: string, key: string, data: Buffer, contentType: string, userMeta: Record<string, string>, etag?: string): Meta {
    const p = this.paths(b, key);
    const tmp = p.bin + "." + randomUUID() + ".tmp";
    writeFileSync(tmp, data);
    renameSync(tmp, p.bin);
    const meta: Meta = {
      key, size: data.length, etag: etag ?? md5(data).toString("hex"),
      lastModified: new Date().toISOString(), contentType, userMeta,
    };
    writeFileSync(p.json, JSON.stringify(meta));
    this.index.get(b)!.set(key, meta);
    return meta;
  }
  head(b: string, key: string) { return this.index.get(b)?.get(key); }
  read(b: string, key: string): Buffer { return readFileSync(this.paths(b, key).bin); }
  delete(b: string, key: string) {
    if (!this.index.get(b)?.delete(key)) return;
    const p = this.paths(b, key);
    rmSync(p.bin, { force: true });
    rmSync(p.json, { force: true });
  }
  sortedKeys(b: string): Meta[] {
    return [...(this.index.get(b)?.values() ?? [])].sort((a, c) =>
      Buffer.compare(Buffer.from(a.key), Buffer.from(c.key)));
  }

  // multipart
  private upDir(b: string, id: string) { return join(this.root, b, "uploads", id); }
  createUpload(b: string, key: string, contentType: string, userMeta: Record<string, string>): string {
    const id = randomUUID().replace(/-/g, "");
    mkdirSync(this.upDir(b, id), { recursive: true });
    writeFileSync(join(this.upDir(b, id), "meta.json"), JSON.stringify({ key, contentType, userMeta }));
    return id;
  }
  uploadMeta(b: string, id: string, key?: string): { key: string; contentType: string; userMeta: Record<string, string> } | undefined {
    const f = join(this.upDir(b, id), "meta.json");
    if (!existsSync(f)) return undefined;
    const m = JSON.parse(readFileSync(f, "utf8"));
    return key !== undefined && m.key !== key ? undefined : m;
  }
  putPart(b: string, id: string, n: number, data: Buffer): string {
    const etag = md5(data).toString("hex");
    writeFileSync(join(this.upDir(b, id), `${n}.part`), data);
    writeFileSync(join(this.upDir(b, id), `${n}.json`), JSON.stringify({ etag, size: data.length, lastModified: new Date().toISOString() }));
    return etag;
  }
  listParts(b: string, id: string): PartInfo[] {
    const dir = this.upDir(b, id);
    return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
      .map((f) => ({ partNumber: parseInt(f, 10), ...JSON.parse(readFileSync(join(dir, f), "utf8")) } as PartInfo))
      .sort((a, c) => a.partNumber - c.partNumber);
  }
  abortUpload(b: string, id: string) { rmSync(this.upDir(b, id), { recursive: true, force: true }); }
  listUploads(b: string) {
    const d = join(this.root, b, "uploads");
    return existsSync(d) ? readdirSync(d) : [];
  }
  /** Returns the final meta, or an error code. */
  completeUpload(b: string, id: string, requested: Array<{ partNumber: number; etag: string }>, minPartSize: number):
    { ok: true; meta: Meta } | { ok: false; code: string; message: string } {
    const um = this.uploadMeta(b, id)!;
    const have = new Map(this.listParts(b, id).map((p) => [p.partNumber, p]));
    if (requested.length === 0) return { ok: false, code: "MalformedXML", message: "no parts" };
    let last = 0;
    const bufs: Buffer[] = [];
    const digests: Buffer[] = [];
    for (let i = 0; i < requested.length; i++) {
      const r = requested[i]!;
      if (r.partNumber <= last) return { ok: false, code: "InvalidPartOrder", message: "The list of parts was not in ascending order." };
      last = r.partNumber;
      const p = have.get(r.partNumber);
      if (!p || p.etag !== r.etag.replace(/"/g, "").toLowerCase()) {
        return { ok: false, code: "InvalidPart", message: `Part ${r.partNumber} not found or ETag mismatch.` };
      }
      if (i < requested.length - 1 && p.size < minPartSize) {
        return { ok: false, code: "EntityTooSmall", message: "Your proposed upload is smaller than the minimum allowed size" };
      }
      bufs.push(readFileSync(join(this.upDir(b, id), `${r.partNumber}.part`)));
      digests.push(Buffer.from(p.etag, "hex"));
    }
    const etag = `${md5(Buffer.concat(digests)).toString("hex")}-${requested.length}`;
    const meta = this.put(b, um.key, Buffer.concat(bufs), um.contentType, um.userMeta, etag);
    this.abortUpload(b, id);
    return { ok: true, meta };
  }
}
