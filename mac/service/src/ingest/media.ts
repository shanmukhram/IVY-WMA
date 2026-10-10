/**
 * Post-processing once a media original is in place: a thumbnail (macOS `sips`)
 * and OCR. OCR is an extension point: `mac/ocr` (Vision) plugs in as an
 * OcrProvider, or any executable via IVY_OCR_COMMAND (`<cmd> <imagePath>`,
 * text on stdout). Without one, media stays `ocr_status = 'pending'` and is
 * picked up when a provider appears. Work runs off the ingest path, one item at
 * a time.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Ctx, OcrProvider, Thumbnailer } from "../context.ts";
import { dirs } from "../config.ts";
import { ensureDir } from "../util/fsx.ts";

const run = promisify(execFile);

export const sipsThumbnailer: Thumbnailer = {
  async make(src, dest) {
    try {
      await run("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", "360", src, "--out", dest], { timeout: 30_000 });
      return existsSync(dest);
    } catch { return false; }
  },
};

export function commandOcr(cmd: string): OcrProvider {
  return {
    async recognize(path) {
      const { stdout } = await run(cmd, [path], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    },
  };
}

export class MediaProcessor {
  private readonly ctx: Ctx;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(ctx: Ctx) { this.ctx = ctx; }

  enqueue(mediaId: string, path: string): void {
    this.pending++;
    this.chain = this.chain.then(() => this.process(mediaId, path)).catch(() => undefined).finally(() => { this.pending--; });
  }

  idle(): Promise<void> { return this.chain; }
  queued(): number { return this.pending; }

  /** Queue every media item still waiting for OCR (called when an OCR provider is available). */
  resumePending(): number {
    const rows = this.ctx.db.prepare("SELECT id, local_path FROM media WHERE local_path IS NOT NULL AND deleted_at IS NULL AND (ocr_status = 'pending' OR thumb_path IS NULL)").all() as Array<{ id: string; local_path: string }>;
    for (const r of rows) this.enqueue(r.id, r.local_path);
    return rows.length;
  }

  private async process(mediaId: string, path: string): Promise<void> {
    const row = this.ctx.db.prepare("SELECT id, thumb_path, ocr_status, deleted_at FROM media WHERE id = ?").get(mediaId) as { thumb_path: string | null; ocr_status: string; deleted_at: string | null } | undefined;
    if (!row || row.deleted_at || !existsSync(path)) return;
    if (!row.thumb_path && this.ctx.thumbnailer) {
      const dest = join(ensureDir(dirs(this.ctx.config).thumbs), `media-${mediaId}.jpg`);
      if (await this.ctx.thumbnailer.make(path, dest)) this.ctx.db.prepare("UPDATE media SET thumb_path = ? WHERE id = ?").run(dest, mediaId);
    }
    if (row.ocr_status === "pending" && this.ctx.ocr) {
      try {
        const text = await this.ctx.ocr.recognize(path);
        this.ctx.db.prepare("UPDATE media SET ocr_text = ?, ocr_status = 'done' WHERE id = ?").run(text || null, mediaId);
      } catch {
        this.ctx.db.prepare("UPDATE media SET ocr_status = 'failed' WHERE id = ?").run(mediaId);
      }
    }
  }
}
