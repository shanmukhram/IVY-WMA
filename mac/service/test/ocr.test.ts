/**
 * Real OCR (Apple Vision through @ivy/mac-ocr) wired into ingest (PRD M1/M3):
 * a screenshot with known text is ingested, OCR'd and thumbnailed in one pass,
 * and its text is then found through the search API. Also: the backlog of
 * OCR-pending media is processed on startup and when the helper becomes
 * available, with `sips`-style fallback thumbnails meanwhile.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fullStack, pairNew, tempDir, rm, api } from "./helpers/harness.ts";
import { iso, type SimDevice } from "./helpers/device.ts";
import { visionOcr } from "../src/ingest/media.ts";
import type { OcrProvider, Thumbnailer } from "../src/context.ts";

const TEXT = "Ocelot quartz harbor 4729\nMarigold telescope invoice";
// Apple Vision exists only on macOS: @ivy/mac-ocr is loaded lazily and the whole suite is skipped elsewhere.
let fixtureBinaryPath: string;
let fixtures: string;
let png: string;

function makeImage(name: string, text: string): string {
  const p = join(fixtures, name);
  execFileSync(fixtureBinaryPath, ["image", p, "--format", "png", "--text", text, "--size", "1200x600", "--font", "44"]);
  return p;
}

async function shot(st: Awaited<ReturnType<typeof fullStack>>, dev: SimDevice, path: string, source: string) {
  const bytes = new Uint8Array(readFileSync(path));
  const b = dev.blob(bytes, "screenshot", 64 * 1024);
  await dev.putBlob(b);
  await dev.put("screenshot", { sourcePath: source, sha256: "s", blobOid: b.oid, takenAt: iso() });
  await st.svc.ingester.poll();
  return (st.svc.ctx.db.prepare("SELECT id FROM media WHERE blob_oid = ?").get(b.oid) as { id: string }).id;
}

const mediaRow = (st: Awaited<ReturnType<typeof fullStack>>, id: string) =>
  st.svc.ctx.db.prepare("SELECT ocr_status, ocr_text, thumb_path FROM media WHERE id = ?").get(id) as { ocr_status: string; ocr_text: string | null; thumb_path: string | null };

describe.skipIf(process.platform !== "darwin")("Vision OCR on media ingest", () => {
  beforeAll(async () => {
    const ocr = await import("@ivy/mac-ocr");
    fixtureBinaryPath = ocr.fixtureBinaryPath;
    await ocr.ensureBinary(); // builds the Swift helper + fixture generator if needed
    fixtures = tempDir("ivy-ocr-fx-");
    png = makeImage("shot.png", TEXT);
  }, 600_000);
  afterAll(() => { if (fixtures) rm(fixtures); });

  it("OCRs and thumbnails a screenshot in one pass; its text is searchable via /api/search", async () => {
    const sipsCalls: string[] = [];
    const fallback: Thumbnailer = { async make(src) { sipsCalls.push(src); return false; } };
    const st = await fullStack({}, { ocr: visionOcr(), thumbnailer: fallback });
    try {
      const dev = await pairNew(st.svc, "windows");
      const id = await shot(st, dev, png, "C:\\Users\\bunny\\Pictures\\Screenshots\\harbor.png");
      await st.svc.idle();
      const m = mediaRow(st, id);
      expect(m.ocr_status).toBe("done");
      expect(m.ocr_text).toMatch(/Ocelot/);
      expect(m.ocr_text).toMatch(/4729/);
      expect(m.thumb_path).toMatch(/thumbs\/media-.*\.jpg$/);
      expect(existsSync(m.thumb_path!)).toBe(true);
      expect(sipsCalls).toEqual([]); // the helper made the thumbnail in the same pass
      const r = await api(st.svc, "GET", "/api/search?q=telescope&type=screenshot");
      expect(r.status).toBe(200);
      expect(r.json.items.map((i: { id: string }) => i.id)).toContain(id);
      expect(r.json.items.find((i: { id: string }) => i.id === id)).toMatchObject({ type: "screenshot", match: "exact" });
      expect((await api(st.svc, "GET", "/api/search?q=quartz")).json.items.map((i: { id: string }) => i.id)).toContain(id);
      expect(st.svc.ctx.events.recent({ types: ["media.ocr"] })[0]!.data).toMatchObject({ mediaId: id, status: "done" });
      dev.close();
    } finally { await st.cleanup(); }
  });

  it("while the helper is unavailable media stays pending with a fallback thumbnail; the backlog runs when it comes back and on startup", async () => {
    const real = visionOcr();
    let up = false;
    const flaky: OcrProvider = {
      recognize: (p, o) => (up ? real.recognize(p, o) : Promise.reject(Object.assign(new Error("no swift"), { code: "toolchain_missing" }))),
      available: async () => up && (await real.available!()),
      isUnavailableError: real.isUnavailableError,
      close: () => real.close!(),
    };
    const sipsCalls: string[] = [];
    const fallback: Thumbnailer = { async make(src, dest) { sipsCalls.push(src); execFileSync("/bin/cp", [src, dest]); return true; } };
    const st = await fullStack({}, { ocr: flaky, thumbnailer: fallback });
    try {
      const dev = await pairNew(st.svc, "windows");
      await st.svc.media.start(); // probe: unavailable
      expect(st.svc.media.stats().ocrAvailable).toBe(false);
      const a = await shot(st, dev, png, "C:\\a.png");
      await st.svc.idle();
      expect(mediaRow(st, a)).toMatchObject({ ocr_status: "pending", ocr_text: null });
      expect(mediaRow(st, a).thumb_path).toBeTruthy();
      expect(sipsCalls).toHaveLength(1);
      expect((await api(st.svc, "GET", "/api/search?q=telescope")).json.total).toBe(0);

      // the helper becomes available: the re-probe queues the backlog
      up = true;
      await st.svc.media.probe();
      await st.svc.idle();
      expect(mediaRow(st, a)).toMatchObject({ ocr_status: "done" });
      expect((await api(st.svc, "GET", "/api/search?q=telescope")).json.items.map((i: { id: string }) => i.id)).toContain(a);

      // a second image ingested while unavailable, then a restart with a working helper: processed on startup
      up = false;
      await st.svc.media.probe();
      const other = makeImage("other.png", "Zebra lantern backlog");
      const b = await shot(st, dev, other, "C:\\b.png");
      await st.svc.idle();
      expect(mediaRow(st, b).ocr_status).toBe("pending");
      const svc2 = await st.restart({}, { ocr: visionOcr() });
      await svc2.media.start();
      await svc2.idle();
      expect(mediaRow(st, b)).toMatchObject({ ocr_status: "done" });
      expect((await api(svc2, "GET", "/api/search?q=lantern")).json.items.map((i: { id: string }) => i.id)).toContain(b);
      dev.close();
    } finally { await st.cleanup(); await real.close!(); }
  });

  it("a file Vision cannot read is marked failed (not retried forever)", async () => {
    const st = await fullStack({}, { ocr: visionOcr() });
    try {
      const dev = await pairNew(st.svc, "windows");
      const bad = join(fixtures, "bad.png");
      execFileSync("/bin/sh", ["-c", `printf '\\211PNG\\r\\n\\032\\nthis is not really a png' > '${bad}'`]);
      const id = await shot(st, dev, bad, "C:\\bad.png");
      await st.svc.idle();
      expect(mediaRow(st, id).ocr_status).toBe("failed");
      dev.close();
    } finally { await st.cleanup(); }
  });
});
