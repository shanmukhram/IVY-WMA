// Manual check: pnpm --filter @ivy/mac-ocr run ocr <path> [more paths] [--thumb <dir>] [--json]
import { basename, join, resolve } from "node:path";
import { createOcr } from "./client.js";
import { OcrError } from "./errors.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const thumbIdx = args.indexOf("--thumb");
const thumbDir = thumbIdx >= 0 ? args[thumbIdx + 1] : undefined;
const files = args.filter((a, i) => !a.startsWith("--") && !(thumbIdx >= 0 && i === thumbIdx + 1));
if (files.length === 0) {
  console.error("usage: pnpm --filter @ivy/mac-ocr run ocr <path...> [--thumb <dir>] [--json]");
  process.exit(2);
}
// pnpm runs scripts in the package dir; resolve relative paths against where the user ran pnpm.
const base = process.env.INIT_CWD ?? process.cwd();

const ocr = createOcr({ onLog: (l) => console.error(l) });
let exitCode = 0;
try {
  for (const f of files) {
    const path = resolve(base, f);
    const t0 = performance.now();
    try {
      const r = await ocr.recognize(path, thumbDir ? { thumb: { path: join(resolve(base, thumbDir), `${basename(path)}.jpg`) } } : {});
      const wall = performance.now() - t0;
      if (json) {
        console.log(JSON.stringify({ ...r, wallMs: Math.round(wall) }, null, 2));
      } else {
        console.log(`== ${path}`);
        console.log(`   ${r.format} ${r.width}x${r.height}${r.pages ? `, ${r.pages} pages (page 1 OCR'd)` : ""}, ${r.lines.length} lines, confidence ${r.confidence}, vision ${r.ocrMs} ms, wall ${Math.round(wall)} ms`);
        if (r.thumb) console.log(`   thumb ${r.thumb.path} (${r.thumb.width}x${r.thumb.height})`);
        if (r.thumbError) console.log(`   thumb error: ${r.thumbError}`);
        console.log(r.text || "(no text found)");
      }
    } catch (err) {
      exitCode = 1;
      const e = err as OcrError;
      console.error(`!! ${path}: [${e.code ?? "error"}] ${e.message}`);
      if (e.code === "toolchain_missing" || e.code === "build_failed" || e.code === "unsupported_platform") break;
    }
  }
} finally {
  await ocr.close();
}
process.exit(exitCode);
