import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureBinaryPath } from "../src/binary.js";

export const TEXT_LINES = ["IVY memory vault", "Ocelot quartz harbor 4729", "", "Second paragraph zebra lantern"];
export const TEXT = TEXT_LINES.join("\n");
export const TEXT_WORDS = ["IVY", "memory", "vault", "Ocelot", "quartz", "harbor", "4729", "zebra", "lantern"];
export const PDF_PAGE1 = "First page marigold telescope\nInvoice number 58213";
export const PDF_PAGE2 = "Second page only xylophone";

export interface Fixtures {
  dir: string;
  png: string;
  jpeg: string;
  heic: string;
  tiff: string;
  webp: string | undefined; // needs cwebp (ImageIO decodes WebP but cannot encode it)
  rotated: string;
  pdf: string;
  garbage: string;
  empty: string;
  missing: string;
  cleanup(): void;
}

function fixture(...args: string[]): string {
  return execFileSync(fixtureBinaryPath, args, { encoding: "utf8" });
}

export function probe(path: string): { width: number; height: number; orientation: number; top: number[]; bottom: number[]; left: number[]; right: number[] } {
  return JSON.parse(fixture("probe", path));
}

export function makeFixtures(): Fixtures {
  const dir = mkdtempSync(join(tmpdir(), "ivy-mac-ocr-"));
  const p = (n: string) => join(dir, n);
  for (const [name, format] of [["text.png", "png"], ["text.jpg", "jpeg"], ["text.heic", "heic"], ["text.tiff", "tiff"]] as const) {
    fixture("image", p(name), "--format", format, "--text", TEXT, "--size", "1200x600", "--font", "44");
  }
  fixture("rotated-jpeg", p("rotated.jpg"), "--text", "ROTATED SAMPLE");
  fixture("pdf", p("doc.pdf"), "--page", PDF_PAGE1, "--page", PDF_PAGE2);
  writeFileSync(p("garbage.png"), "this is not a png at all\n".repeat(20));
  writeFileSync(p("empty.jpg"), "");

  let webp: string | undefined;
  const cw = spawnSync("cwebp", ["-quiet", "-lossless", p("text.png"), "-o", p("text.webp")]);
  if (cw.status === 0) webp = p("text.webp");

  return {
    dir,
    png: p("text.png"),
    jpeg: p("text.jpg"),
    heic: p("text.heic"),
    tiff: p("text.tiff"),
    webp,
    rotated: p("rotated.jpg"),
    pdf: p("doc.pdf"),
    garbage: p("garbage.png"),
    empty: p("empty.jpg"),
    missing: p("does-not-exist.png"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
