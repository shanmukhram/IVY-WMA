import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSwift, createOcr, OcrError, type OcrClient, type OcrResult } from "../src/index.js";
import { makeFixtures, PDF_PAGE2, probe, TEXT_WORDS, type Fixtures } from "./fixtures.js";

let fx: Fixtures;
let ocr: OcrClient;

beforeAll(() => {
  fx = makeFixtures();
  ocr = createOcr();
});
afterAll(async () => {
  await ocr?.close();
  fx?.cleanup();
});

function expectWords(r: OcrResult, words = TEXT_WORDS): void {
  const text = r.text.toLowerCase();
  for (const w of words) expect(text, `missing "${w}" in:\n${r.text}`).toContain(w.toLowerCase());
}

describe("recognize", () => {
  it("OCRs a PNG with known text, lines in reading order, normalized boxes", async () => {
    const r = await ocr.recognize(fx.png);
    expectWords(r);
    expect(r.format).toBe("png");
    expect([r.width, r.height]).toEqual([1200, 600]);
    expect(r.orientation).toBe(1);
    // reading order: top-to-bottom
    const iIvy = r.text.indexOf("IVY");
    const iOcelot = r.text.indexOf("Ocelot");
    const iZebra = r.text.indexOf("zebra");
    expect(iIvy).toBeLessThan(iOcelot);
    expect(iOcelot).toBeLessThan(iZebra);
    // the blank line in the source separates blocks
    expect(r.text).toMatch(/4729\n\nSecond/);
    expect(r.lines.length).toBeGreaterThanOrEqual(3);
    let prevY = -1;
    for (const l of r.lines) {
      expect(l.confidence).toBeGreaterThan(0);
      expect(l.confidence).toBeLessThanOrEqual(1);
      for (const v of [l.box.x, l.box.y, l.box.w, l.box.h]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(l.box.y).toBeGreaterThanOrEqual(prevY); // top-left origin, y increases downward
      prevY = l.box.y;
    }
    expect(r.lines[0]!.box.y).toBeLessThan(0.2); // first line is near the top
    expect(r.ms).toBeGreaterThan(0);
  });

  it.each([
    ["jpeg", () => fx.jpeg],
    ["heic", () => fx.heic],
    ["tiff", () => fx.tiff],
  ])("OCRs %s", async (format, file) => {
    const r = await ocr.recognize(file());
    expect(r.format.replace("jpg", "jpeg").replace("tif", "tiff").replace("tifff", "tiff")).toBe(format);
    expectWords(r);
  });

  it("OCRs WebP (fixture encoded with cwebp)", async (ctx) => {
    if (!fx.webp) ctx.skip(); // ImageIO decodes WebP but cannot encode it; cwebp not installed
    const r = await ocr.recognize(fx.webp!);
    expect(r.format).toBe("webp");
    expectWords(r);
  });

  it("OCRs the first page of a PDF only (rendered at 2x)", async () => {
    const r = await ocr.recognize(fx.pdf);
    expect(r.format).toBe("pdf");
    expect(r.pages).toBe(2);
    expect([r.width, r.height]).toEqual([1224, 1584]); // US Letter at 2x
    expectWords(r, ["marigold", "telescope", "58213"]);
    expect(r.text.toLowerCase()).not.toContain(PDF_PAGE2.split(" ").at(-1)!);
  });

  it("respects explicit languages", async () => {
    const r = await ocr.recognize(fx.png, { languages: ["en-US"] });
    expectWords(r);
  });
});

describe("thumbnails", () => {
  it("rotated-EXIF JPEG: OCR and thumbnail both honor orientation 6", async () => {
    const out = join(fx.dir, "thumbs", "rotated.jpg");
    const r = await ocr.recognize(fx.rotated, { thumb: { path: out, maxEdge: 256 } });
    expect(r.orientation).toBe(6);
    expect([r.width, r.height]).toEqual([600, 900]); // display size, not stored 900x600
    expect(r.text).toContain("ROTATED");
    expect(r.thumb).toEqual({ path: out, width: 171, height: 256 });

    const stored = probe(fx.rotated);
    expect([stored.width, stored.height, stored.orientation]).toEqual([900, 600, 6]);
    expect(stored.left[0]).toBeGreaterThan(200); // red band is stored on the left

    const t = probe(out);
    expect(t.orientation).toBe(1); // pixels are baked upright
    expect(t.height).toBeGreaterThan(t.width);
    const isRed = (c: number[]) => c[0]! > 200 && c[1]! < 80 && c[2]! < 80;
    const isBlue = (c: number[]) => c[2]! > 200 && c[0]! < 80;
    expect(isRed(t.top), `top=${t.top}`).toBe(true);
    expect(isBlue(t.bottom), `bottom=${t.bottom}`).toBe(true);
  });

  it("thumbnail() writes a JPEG capped at maxEdge, without OCR", async () => {
    const out = join(fx.dir, "thumbs", "nested", "png.jpg");
    const t = await ocr.thumbnail(fx.png, out, 128);
    expect(t).toEqual({ path: out, width: 128, height: 64 });
    expect(existsSync(out)).toBe(true);
    expect(probe(out).width).toBe(128);
  });

  it("never upscales and handles PDFs", async () => {
    const big = await ocr.thumbnail(fx.png, join(fx.dir, "thumbs", "big.jpg"), 4000);
    expect([big.width, big.height]).toEqual([1200, 600]);
    const pdf = await ocr.thumbnail(fx.pdf, join(fx.dir, "thumbs", "pdf.jpg"), 256);
    expect([pdf.width, pdf.height]).toEqual([198, 256]);
  });

  it("a thumbnail failure still returns the OCR result", async () => {
    const r = await ocr.recognize(fx.png, { thumb: { path: "/dev/null/cannot/write.jpg" } });
    expect(r.thumb).toBeUndefined();
    expect(r.thumbError).toMatch(/directory|write|move/i);
    expectWords(r);
  });
});

describe("errors", () => {
  it("unreadable / empty / missing files are error replies and the helper keeps serving", async () => {
    await ocr.ping();
    const pid = ocr.pid;
    await expect(ocr.recognize(fx.garbage)).rejects.toMatchObject({ name: "OcrError", code: "unreadable", path: fx.garbage });
    await expect(ocr.recognize(fx.empty)).rejects.toMatchObject({ code: "unreadable" });
    await expect(ocr.recognize(fx.missing)).rejects.toMatchObject({ code: "not_found" });
    await expect(ocr.recognize(fx.dir)).rejects.toMatchObject({ code: "unreadable" });
    await expect(ocr.raw({ op: "bogus" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(ocr.thumbnail(fx.garbage, join(fx.dir, "x.jpg"))).rejects.toBeInstanceOf(OcrError);
    const r = await ocr.recognize(fx.png);
    expectWords(r);
    expect(ocr.pid).toBe(pid);
    expect(ocr.stats().restarts).toBe(0);
  });

  it("a missing Swift toolchain gives a clear error", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(buildSwift()).rejects.toMatchObject({ code: "toolchain_missing", message: expect.stringMatching(/xcode-select --install/) });
    } finally {
      process.env.PATH = saved;
    }
  });

  it("a missing explicit binary gives a clear error", async () => {
    const bad = createOcr({ binaryPath: join(fx.dir, "no-such-ivy-ocr") });
    await expect(bad.recognize(fx.png)).rejects.toMatchObject({ code: "binary_missing" });
    await bad.close();
  });

  it("debug ops are refused unless IVY_OCR_DEBUG=1", async () => {
    await expect(ocr.raw({ op: "sleep", ms: 10 })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("latency", () => {
  it("measures warm per-image latency", async () => {
    await ocr.recognize(fx.png); // warm
    const samples: Record<string, number[]> = {};
    const files: Array<[string, string]> = [["png 1200x600", fx.png], ["heic 1200x600", fx.heic], ["pdf p1 1224x1584", fx.pdf], ["jpeg rotated 600x900", fx.rotated]];
    for (const [label, f] of files) {
      samples[label] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const r = await ocr.recognize(f);
        samples[label]!.push(performance.now() - t0);
        expect(r.text.length).toBeGreaterThan(0);
      }
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    const report = Object.entries(samples).map(([k, v]) => `${k}: median ${median(v).toFixed(0)} ms (min ${Math.min(...v).toFixed(0)}, max ${Math.max(...v).toFixed(0)})`);
    console.log(`[mac-ocr latency, sequential, warm]\n  ${report.join("\n  ")}`);
  });
});
