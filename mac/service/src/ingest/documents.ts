/**
 * Text extraction for document originals the Windows media policy uploads on its
 * own (PLAN decision 8, payloadKind `document`, linked by file_meta.originalBlobOid).
 *
 * - txt / md / csv are read directly (UTF-8, UTF-16 with BOM, else Windows-1252).
 * - pdf goes through poppler's `pdftotext` when it is installed. When it is not, the
 *   file stays `extract_status = 'pending'` (its name, path and local copy are still
 *   in the vault) and is picked up on the next start once pdftotext is present.
 * - Everything else (docx, xlsx, pptx, doc, ...) is kept as the local copy only:
 *   `extract_status = 'unsupported'`.
 *
 * The text goes to files.content_text, which files_fts indexes with the name and
 * path. One extraction per blob updates every file row that names it (copies).
 * Work runs off the ingest path, one job at a time.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { Ctx } from "../context.ts";
import { extOf } from "../util/ext.ts";

const run = promisify(execFile);

export const TEXT_EXTS = new Set(["txt", "md", "csv"]);
export const PDF_EXTS = new Set(["pdf"]);
/** Characters of extracted text kept per document (documents are capped at upload anyway). */
export const MAX_TEXT_CHARS = 2_000_000;

/** Where pdftotext is: IVY_PDFTOTEXT, the usual Homebrew locations, else PATH. Null when absent. */
export function findPdftotext(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.IVY_PDFTOTEXT !== undefined) return env.IVY_PDFTOTEXT && existsSync(env.IVY_PDFTOTEXT) ? env.IVY_PDFTOTEXT : null;
  const candidates = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext",
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "pdftotext"))];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Decode a text file the way Windows tools write them. */
export function decodeText(buf: Buffer): string {
  let s: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) s = buf.subarray(2).toString("utf16le");
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    s = b.swap16().toString("utf16le");
  } else {
    const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
    try { s = new TextDecoder("utf-8", { fatal: true }).decode(body); }
    catch { s = new TextDecoder("windows-1252").decode(body); }
  }
  return s.replace(/\u0000/g, "").slice(0, MAX_TEXT_CHARS);
}

export type ExtractStatus = "pending" | "done" | "failed" | "unsupported";

export class DocumentProcessor {
  private readonly ctx: Ctx;
  private readonly pdftotext: string | null;
  private readonly queue: Array<{ oid: string; path: string }> = [];
  private readonly queued = new Set<string>();
  private running = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(ctx: Ctx, opts: { pdftotext?: string | null } = {}) {
    this.ctx = ctx;
    this.pdftotext = opts.pdftotext !== undefined ? opts.pdftotext : findPdftotext();
  }

  get pdfAvailable(): boolean { return !!this.pdftotext; }

  /** A document blob is in place at `path`: extract its text for every file that names it. */
  enqueue(blobOid: string, path: string): void {
    if (this.closed || this.queued.has(blobOid)) return;
    this.queued.add(blobOid);
    this.queue.push({ oid: blobOid, path });
    void this.pump();
  }

  /** Re-queue documents still pending (e.g. pdftotext installed since). Called on start. */
  resumePending(): number {
    const rows = this.ctx.db.prepare(`SELECT DISTINCT original_blob_oid AS oid, local_path FROM files
                                      WHERE extract_status = 'pending' AND original_blob_oid IS NOT NULL AND local_path IS NOT NULL AND deleted_at IS NULL`)
      .all() as Array<{ oid: string; local_path: string }>;
    for (const r of rows) this.enqueue(r.oid, r.local_path);
    return rows.length;
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.splice(0);
    await this.idle();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try { await this.process(job.oid, job.path); } catch { /* recorded as failed below when possible */ }
        this.queued.delete(job.oid);
      }
    } finally {
      this.running = false;
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private files(oid: string): Array<{ id: string; ext: string | null; path: string }> {
    return this.ctx.db.prepare("SELECT id, ext, path FROM files WHERE original_blob_oid = ? AND deleted_at IS NULL").all(oid) as Array<{ id: string; ext: string | null; path: string }>;
  }

  private set(oid: string, status: ExtractStatus, text: string | null, detail?: string): void {
    const ids = this.files(oid).map((f) => f.id);
    if (!ids.length) return;
    const upd = this.ctx.db.prepare("UPDATE files SET content_text = ?, extract_status = ? WHERE id = ?");
    this.ctx.db.transaction(() => { for (const id of ids) upd.run(text, status, id); })();
    this.ctx.events.emit("file.extracted", { blobOid: oid, fileIds: ids, status, chars: text?.length ?? 0, ...(detail ? { detail } : {}) });
  }

  private async process(oid: string, path: string): Promise<void> {
    const rows = this.files(oid);
    if (!rows.length || !existsSync(path)) return;
    const ext = rows.map((r) => (r.ext ?? extOf(r.path) ?? "").toLowerCase()).find((e) => TEXT_EXTS.has(e) || PDF_EXTS.has(e)) ?? extOf(path) ?? "";
    if (TEXT_EXTS.has(ext)) {
      try {
        if (statSync(path).size > 64 * 1024 * 1024) { this.set(oid, "failed", null, "too large to read as text"); return; }
        this.set(oid, "done", decodeText(readFileSync(path)) || null);
      } catch (e) { this.set(oid, "failed", null, (e as Error).message); }
      return;
    }
    if (PDF_EXTS.has(ext)) {
      if (!this.pdftotext) { this.set(oid, "pending", null, "pdftotext not installed"); return; }
      try {
        const { stdout } = await run(this.pdftotext, ["-enc", "UTF-8", "-q", path, "-"], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
        const text = stdout.replace(/\f/g, "\n").replace(/\u0000/g, "").trim().slice(0, MAX_TEXT_CHARS);
        this.set(oid, "done", text || null);
      } catch (e) { this.set(oid, "failed", null, (e as Error).message.slice(0, 200)); }
      return;
    }
    this.set(oid, "unsupported", null);
  }
}
