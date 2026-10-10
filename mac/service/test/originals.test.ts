/**
 * Mac acceptance of the Windows media policy (PLAN decision 8): file_meta.originalBlobOid
 * links a file to an original the device uploaded on its own. `photo` blobs become media
 * rows (OCR'd like screenshots); `document` blobs are the file's local copy, with text
 * extracted for txt/md/csv (directly) and pdf (pdftotext, else left pending).
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { iso, PNG_1x1, type SimDevice } from "./helpers/device.ts";
import { decodeText, findPdftotext } from "../src/ingest/documents.ts";
import { purge } from "../src/bin/recovery.ts";
import type { OcrProvider } from "../src/context.ts";
import { slash } from "./helpers/paths.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
const enc = (s: string) => new TextEncoder().encode(s);
const PDFTOTEXT = findPdftotext();

/** A one-page PDF with a line of text in Helvetica (xref offsets computed). */
function pdfWithText(text: string): Uint8Array {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}

const ocrCalls: string[] = [];
const fakeOcr: OcrProvider = { async recognize(p) { ocrCalls.push(p); return { text: "Quokka lighthouse 7731" }; } };

let st: Stack | undefined;
afterEach(async () => { await st?.cleanup(); st = undefined; });

async function setup(opts: { pdftotext?: string | null } = {}) {
  st = await fullStack({}, { ocr: fakeOcr, pdftotext: opts.pdftotext === undefined ? null : opts.pdftotext });
  const dev = await pairNew(st.svc, "windows");
  return { st, dev };
}

function fileRow(s: Stack, path: string) {
  return s.svc.ctx.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as {
    id: string; status: string; local_path: string | null; original_blob_oid: string | null; content_text: string | null; extract_status: string | null;
  };
}

async function meta(dev: SimDevice, path: string, size: number, quickHash: string, originalBlobOid?: string, mtime = iso()) {
  const name = path.split("\\").pop()!;
  await dev.put("file_meta", { path, name, ext: name.split(".").pop()!, size, mtime, quickHash, ...(originalBlobOid ? { originalBlobOid } : {}) });
}

const search = async (s: Stack, q: string, type?: string) =>
  (await api(s.svc, "GET", `/api/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ""}`)).json.items as Array<{ id: string; type: string }>;

describe("file_meta.originalBlobOid (PLAN decision 8)", () => {
  it("a photo original (record first, blob later) caches the file and becomes an OCR'd, searchable media row", async () => {
    const { st: s, dev } = await setup();
    const blob = dev.blob(PNG_1x1, "photo", 64);
    const path = "C:\\Users\\bunny\\Pictures\\Trips\\beach.png";
    await meta(dev, path, PNG_1x1.length, "qh-beach", blob.oid);
    await s.svc.ingester.poll();
    expect(fileRow(s, path)).toMatchObject({ status: "reference", original_blob_oid: blob.oid, local_path: null });

    await dev.putBlob(blob);
    await s.svc.ingester.poll();
    await s.svc.idle();
    const f = fileRow(s, path);
    expect(f.status).toBe("cached");
    expect(slash(f.local_path!)).toMatch(/media\/.*\.png$/);
    expect(new Uint8Array(readFileSync(f.local_path!))).toEqual(PNG_1x1);
    expect(f.extract_status).toBeNull();
    const m = s.svc.ctx.db.prepare("SELECT * FROM media WHERE blob_oid = ?").get(blob.oid) as { id: string; kind: string; source_path: string; local_path: string; ocr_status: string; ocr_text: string };
    expect(m).toMatchObject({ kind: "photo", source_path: path, local_path: f.local_path, ocr_status: "done", ocr_text: "Quokka lighthouse 7731" });
    expect(ocrCalls).toContain(f.local_path);
    const hits = await search(s, "lighthouse", "photo");
    expect(hits.map((h) => h.id)).toContain(m.id);
    expect(s.svc.ctx.events.recent({ types: ["file.cached"] }).some((e) => e.data.fileId === f.id)).toBe(true);
    dev.close();
  });

  it("a document original (blob first, record later) becomes the file's local copy and its text is searchable", async () => {
    const { st: s, dev } = await setup();
    const body = "Minutes of the pelican committee\nbudget: 4410 euros\n";
    const blob = dev.blob(enc(body), "document", 16);
    await dev.putBlob(blob);
    await s.svc.ingester.poll();
    // complete but waiting for the record that names it (no quarantine for the new payload kind)
    expect(s.svc.ctx.db.prepare("SELECT status, payload_kind FROM blobs WHERE oid = ?").get(blob.oid)).toEqual({ status: "complete", payload_kind: "document" });
    expect((s.svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM quarantine").get() as { n: number }).n).toBe(0);

    const path = "D:\\Notes\\committee.txt";
    await meta(dev, path, body.length, "qh-notes", blob.oid);
    await s.svc.ingester.poll();
    await s.svc.idle();
    const f = fileRow(s, path);
    expect(f).toMatchObject({ status: "cached", extract_status: "done" });
    expect(slash(f.local_path!)).toMatch(/files\/.+\/committee\.txt$/);
    expect(readFileSync(f.local_path!, "utf8")).toBe(body);
    expect(f.content_text).toContain("pelican committee");
    expect((await search(s, "pelican", "file")).map((h) => h.id)).toContain(f.id);
    expect((await search(s, "4410")).map((h) => h.id)).toContain(f.id);
    expect(s.svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM media").get()).toEqual({ n: 0 }); // documents are not media

    // a copy on the PC names the same blob: cached too, sharing the copy and the text
    const copy = "D:\\Backup\\committee (copy).txt";
    await meta(dev, copy, body.length, "qh-notes", blob.oid);
    await s.svc.ingester.poll();
    await s.svc.idle();
    expect(fileRow(s, copy)).toMatchObject({ status: "cached", local_path: f.local_path, extract_status: "done" });
    expect(fileRow(s, copy).content_text).toContain("pelican");

    // purging one copy from the recovery bin keeps the shared original for the other
    s.svc.ctx.db.prepare("UPDATE files SET deleted_at = ? WHERE path = ?").run(iso(), copy);
    purge(s.svc.ctx, "file", fileRow(s, copy).id);
    expect(existsSync(f.local_path!)).toBe(true);
    dev.close();
  });

  it("a modified file is a reference until its new original lands; md and csv are read directly", async () => {
    const { st: s, dev } = await setup();
    const v1 = dev.blob(enc("# Plan\nfirst draft walrus"), "document");
    const path = "C:\\docs\\plan.md";
    await dev.putBlob(v1);
    await meta(dev, path, 25, "h1", v1.oid, "2026-10-01T00:00:00.000Z");
    await s.svc.ingester.poll();
    await s.svc.idle();
    expect(fileRow(s, path)).toMatchObject({ status: "cached", original_blob_oid: v1.oid });

    const v2 = dev.blob(enc("# Plan\nsecond draft narwhal"), "document");
    await meta(dev, path, 26, "h2", v2.oid, "2026-10-02T00:00:00.000Z");
    await s.svc.ingester.poll();
    expect(fileRow(s, path)).toMatchObject({ status: "reference", original_blob_oid: v2.oid });
    await dev.putBlob(v2);
    await s.svc.ingester.poll();
    await s.svc.idle();
    const f = fileRow(s, path);
    expect(f).toMatchObject({ status: "cached", extract_status: "done" });
    expect(f.local_path).toContain(v2.oid);
    expect(f.content_text).toContain("narwhal");
    expect((await search(s, "narwhal", "file")).map((h) => h.id)).toContain(f.id);
    expect((await search(s, "walrus", "file")).map((h) => h.id)).not.toContain(f.id);

    // a later record without originalBlobOid for the same content keeps the link
    await meta(dev, path, 26, "h2", undefined, "2026-10-03T00:00:00.000Z");
    await s.svc.ingester.poll();
    expect(fileRow(s, path)).toMatchObject({ status: "cached", original_blob_oid: v2.oid });

    const csvBlob = dev.blob(enc("city,count\nReykjavik,3\n"), "document");
    await dev.putBlob(csvBlob);
    await meta(dev, "C:\\data\\cities.csv", 23, "hc", csvBlob.oid);
    await s.svc.ingester.poll();
    await s.svc.idle();
    expect(fileRow(s, "C:\\data\\cities.csv").content_text).toContain("Reykjavik");
    dev.close();
  });

  it("docx is kept as the local copy without text; a pdf waits (pending) without pdftotext", async () => {
    const { st: s, dev } = await setup({ pdftotext: null });
    const docx = dev.blob(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]), "document");
    const pdf = dev.blob(pdfWithText("Capybara invoice 9031"), "document", 128);
    await dev.putBlob(docx);
    await dev.putBlob(pdf);
    await meta(dev, "C:\\w\\letter.docx", 7, "hd", docx.oid);
    await meta(dev, "C:\\w\\invoice.pdf", 500, "hp", pdf.oid);
    await s.svc.ingester.poll();
    await s.svc.idle();
    expect(fileRow(s, "C:\\w\\letter.docx")).toMatchObject({ status: "cached", extract_status: "unsupported", content_text: null });
    expect(existsSync(fileRow(s, "C:\\w\\letter.docx").local_path!)).toBe(true);
    const p = fileRow(s, "C:\\w\\invoice.pdf");
    expect(p).toMatchObject({ status: "cached", extract_status: "pending", content_text: null });
    expect(s.svc.ctx.events.recent({ types: ["file.extracted"] }).some((e) => e.data.status === "pending" && e.data.detail === "pdftotext not installed")).toBe(true);

    if (PDFTOTEXT) {
      // pdftotext installed later: the pending PDF is picked up on the next start
      const svc2 = await s.restart({}, { ocr: fakeOcr, pdftotext: PDFTOTEXT });
      expect(svc2.documents.resumePending()).toBe(1);
      await svc2.idle();
      const after = fileRow(s, "C:\\w\\invoice.pdf");
      expect(after.extract_status).toBe("done");
      expect(after.content_text).toContain("Capybara invoice 9031");
      expect((await search(s, "Capybara", "file")).map((h) => h.id)).toContain(after.id);
    }
    dev.close();
  });

  it.skipIf(!PDFTOTEXT)("extracts pdf text with pdftotext when it is installed", async () => {
    const { st: s, dev } = await setup({ pdftotext: PDFTOTEXT });
    const pdf = dev.blob(pdfWithText("Axolotl ledger 2207"), "document", 100);
    await meta(dev, "C:\\scan\\ledger.pdf", 600, "hx", pdf.oid);
    await dev.putBlob(pdf);
    await s.svc.ingester.poll();
    await s.svc.idle();
    const f = fileRow(s, "C:\\scan\\ledger.pdf");
    expect(f).toMatchObject({ status: "cached", extract_status: "done" });
    expect(f.content_text).toContain("Axolotl ledger 2207");
    dev.close();
  });
});

describe("decodeText", () => {
  it("reads UTF-8 (with or without BOM), UTF-16 with BOM, and falls back to Windows-1252", () => {
    expect(decodeText(Buffer.from("héllo", "utf8"))).toBe("héllo");
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom", "utf8")]))).toBe("bom");
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("notepad", "utf16le")]))).toBe("notepad");
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("big", "utf16le").swap16()]))).toBe("big");
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
  });
});
