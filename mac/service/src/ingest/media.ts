/**
 * Post-processing once a media original is in place (PRD M1/M3): OCR and a
 * thumbnail, in ONE decode when the Vision helper (@ivy/mac-ocr) is available.
 *
 * - The text goes to media.ocr_text (the FTS5 triggers index it, so search finds
 *   screenshots by their text) and ocr_status becomes done / failed.
 * - When the helper is unavailable (no Swift toolchain, build failure, not macOS,
 *   crash loop) the item stays `pending`, the thumbnail comes from macOS `sips`
 *   instead, and the processor re-probes the helper periodically. When the helper
 *   becomes available, the pending backlog is processed.
 * - The backlog (pending OCR or missing thumbnails) is also queued on startup and
 *   after unlock. Work runs off the ingest path with bounded concurrency.
 * - IVY_OCR_COMMAND (`<cmd> <imagePath>`, text on stdout) is still accepted as an
 *   alternative provider.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Ctx, OcrProvider, Thumbnailer } from "../context.ts";
import { dirs } from "../config.ts";
import { ensureDir } from "../util/fsx.ts";

const run = promisify(execFile);

export const THUMB_MAX_EDGE = 360;

export const sipsThumbnailer: Thumbnailer = {
  async make(src, dest) {
    try {
      await run("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", String(THUMB_MAX_EDGE), src, "--out", dest], { timeout: 30_000 });
      return existsSync(dest);
    } catch { return false; }
  },
};

export function commandOcr(cmd: string): OcrProvider {
  return {
    async recognize(path) {
      const { stdout } = await run(cmd, [path], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      return { text: stdout.trim() };
    },
  };
}

/** Error codes from @ivy/mac-ocr that mean "the helper cannot run", not "this file is bad". */
const UNAVAILABLE_CODES = new Set(["toolchain_missing", "build_failed", "binary_missing", "unsupported_platform", "crash_loop", "closed"]);

type OcrClientLike = import("@ivy/mac-ocr").OcrClient;

/**
 * The default provider: Apple Vision through @ivy/mac-ocr's warm helper. Loaded
 * lazily so the service still starts (without OCR) where the package cannot load.
 */
export function visionOcr(opts: { concurrency?: number; timeoutMs?: number; binaryPath?: string; onLog?: (l: string) => void } = {}): OcrProvider {
  let client: Promise<OcrClientLike> | null = null;
  const get = () => {
    client ??= import("@ivy/mac-ocr").then((m) => m.createOcr({
      concurrency: opts.concurrency ?? 2, timeoutMs: opts.timeoutMs ?? 120_000, binaryPath: opts.binaryPath, onLog: opts.onLog,
    })).catch((e) => { client = null; throw Object.assign(new Error(`@ivy/mac-ocr could not load: ${(e as Error).message}`), { code: "unsupported_platform" }); });
    return client;
  };
  return {
    async recognize(path, o) {
      const c = await get();
      const r = await c.recognize(path, o?.thumb ? { thumb: { path: o.thumb.path, maxEdge: o.thumb.maxEdge } } : {});
      return { text: r.text, thumbPath: r.thumb?.path ?? null };
    },
    async available() {
      try { await (await get()).ping(); return true; } catch { return false; }
    },
    isUnavailableError(e) {
      return UNAVAILABLE_CODES.has(String((e as { code?: unknown })?.code ?? ""));
    },
    async close() {
      const c = client;
      client = null;
      if (c) await (await c.catch(() => null))?.close();
    },
  };
}

export interface MediaStats { queued: number; running: number; ocrAvailable: boolean | null; done: number; failed: number }

export class MediaProcessor {
  private readonly ctx: Ctx;
  private readonly concurrency: number;
  private readonly queue: Array<{ id: string; path: string }> = [];
  private readonly queuedIds = new Set<string>();
  private running = 0;
  private idleWaiters: Array<() => void> = [];
  /** null = not probed yet */
  private ocrAvailable: boolean | null = null;
  private probeTimer: NodeJS.Timeout | undefined;
  private probing: Promise<boolean> | null = null;
  private closed = false;
  private done = 0;
  private failed = 0;
  /** how often an unavailable helper is probed again */
  reprobeMs = 5 * 60_000;

  constructor(ctx: Ctx, opts: { concurrency?: number } = {}) {
    this.ctx = ctx;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
  }

  /** Probe the OCR helper and queue the backlog. Called on service start. */
  async start(): Promise<void> {
    await this.probe();
    this.resumePending();
  }

  /**
   * Check whether the OCR provider can run. On a transition to available the
   * pending backlog is queued; while unavailable a re-probe is scheduled.
   */
  probe(): Promise<boolean> {
    this.probing ??= (async () => {
      const ocr = this.ctx.ocr;
      const was = this.ocrAvailable;
      const ok = !!ocr && (ocr.available ? await ocr.available().catch(() => false) : true);
      this.ocrAvailable = ok;
      if (ok && was === false) this.resumePending();
      if (!ok && ocr) this.scheduleReprobe();
      return ok;
    })().finally(() => { this.probing = null; });
    return this.probing;
  }

  private scheduleReprobe(): void {
    if (this.closed || this.probeTimer) return;
    this.probeTimer = setTimeout(() => { this.probeTimer = undefined; void this.probe(); }, this.reprobeMs);
    this.probeTimer.unref();
  }

  enqueue(mediaId: string, path: string): void {
    if (this.closed || this.queuedIds.has(mediaId)) return;
    this.queuedIds.add(mediaId);
    this.queue.push({ id: mediaId, path });
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.process(job.id, job.path)
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.queuedIds.delete(job.id);
          this.pump();
          if (this.running === 0 && this.queue.length === 0) for (const w of this.idleWaiters.splice(0)) w();
        });
    }
  }

  idle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  queued(): number { return this.queue.length + this.running; }

  stats(): MediaStats {
    return { queued: this.queue.length, running: this.running, ocrAvailable: this.ocrAvailable, done: this.done, failed: this.failed };
  }

  /** Queue every media item still waiting for OCR or a thumbnail. */
  resumePending(): number {
    if (!this.ctx.ocr && !this.ctx.thumbnailer) return 0;
    const rows = this.ctx.db.prepare(`SELECT id, local_path FROM media WHERE local_path IS NOT NULL AND deleted_at IS NULL
                                      AND (ocr_status = 'pending' OR thumb_path IS NULL) ORDER BY rid`).all() as Array<{ id: string; local_path: string }>;
    let n = 0;
    for (const r of rows) {
      const row = this.ctx.db.prepare("SELECT ocr_status, thumb_path FROM media WHERE id = ?").get(r.id) as { ocr_status: string; thumb_path: string | null };
      // OCR-pending items wait for an available provider; thumbnails can always be made
      const needsOcr = row.ocr_status === "pending" && this.ctx.ocr && this.ocrAvailable !== false;
      const needsThumb = !row.thumb_path && !!this.ctx.thumbnailer;
      if (needsOcr || needsThumb) { this.enqueue(r.id, r.local_path); n++; }
    }
    return n;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.queue.splice(0);
    await this.idle();
    await this.ctx.ocr?.close?.();
  }

  private async process(mediaId: string, path: string): Promise<void> {
    const row = this.ctx.db.prepare("SELECT id, thumb_path, ocr_status, deleted_at FROM media WHERE id = ?").get(mediaId) as { thumb_path: string | null; ocr_status: string; deleted_at: string | null } | undefined;
    if (!row || row.deleted_at || !existsSync(path)) return;
    const thumbDest = join(ensureDir(dirs(this.ctx.config).thumbs), `media-${mediaId}.jpg`);
    let haveThumb = !!row.thumb_path;
    const ocr = this.ctx.ocr;
    if (row.ocr_status === "pending" && ocr && this.ocrAvailable !== false) {
      try {
        const r = await ocr.recognize(path, haveThumb ? undefined : { thumb: { path: thumbDest, maxEdge: THUMB_MAX_EDGE } });
        const thumb = !haveThumb && r.thumbPath && existsSync(r.thumbPath) ? r.thumbPath : null;
        this.ctx.db.prepare("UPDATE media SET ocr_text = ?, ocr_status = 'done', thumb_path = COALESCE(?, thumb_path) WHERE id = ? AND deleted_at IS NULL")
          .run(r.text || null, thumb, mediaId);
        if (thumb) haveThumb = true;
        this.ocrAvailable = true;
        this.done++;
        this.ctx.events.emit("media.ocr", { mediaId, status: "done", chars: r.text.length });
      } catch (e) {
        if (ocr.isUnavailableError?.(e)) {
          // the helper is gone, not the file: stay pending and fall back to sips for the thumbnail
          this.ocrAvailable = false;
          this.scheduleReprobe();
        } else {
          this.ctx.db.prepare("UPDATE media SET ocr_status = 'failed' WHERE id = ?").run(mediaId);
          this.failed++;
          this.ctx.events.emit("media.ocr", { mediaId, status: "failed", code: String((e as { code?: unknown }).code ?? "error") });
        }
      }
    }
    if (!haveThumb && this.ctx.thumbnailer) {
      if (await this.ctx.thumbnailer.make(path, thumbDest)) this.ctx.db.prepare("UPDATE media SET thumb_path = ? WHERE id = ?").run(thumbDest, mediaId);
    }
  }
}
