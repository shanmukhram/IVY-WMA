/**
 * Audit markers harvested from the Mac vault, like fake-mac harvests its ledger:
 * plaintext the Mac has decrypted (file paths and names, extracted document text,
 * window titles, notification text, OCR text, messages) plus printable runs from
 * retrieved originals under data/files/. A pass means none of it appears in any
 * bucket. vault.db is opened read-only; the markers stay in memory.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const OID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Columns that hold device plaintext. Long text is cut into runs. */
const SOURCES: Array<{ table: string; cols: string[]; long?: boolean }> = [
  { table: "files", cols: ["path", "name"] },
  { table: "files", cols: ["content_text"], long: true },
  { table: "usage_events", cols: ["title"] },
  { table: "notifications", cols: ["title", "preview", "sender"] },
  { table: "media", cols: ["source_path"] },
  { table: "media", cols: ["ocr_text"], long: true },
  { table: "messages", cols: ["text"], long: true },
  { table: "calls", cols: ["contact", "number"] },
];

function usable(v: string): boolean {
  return v.length >= 6 && !OID.test(v) && !/^[0-9a-f]{32,64}$/i.test(v) && !/^\d{4}-\d\d-\d\dT/.test(v);
}

/** Printable ASCII runs (>= 16 chars) from the start of a buffer. */
export function printableRuns(s: string, max = 5): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/[\x20-\x7e]{16,}/g)) {
    const t = m[0].trim();
    if (t.length >= 16) out.push(t.slice(0, 64));
    if (out.length >= max) break;
  }
  return out;
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 3 || !existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (st.isFile()) out.push(p);
  }
}

export function harvestVaultMarkers(dataDir: string, opts: { maxPerColumn?: number; extra?: string[] } = {}): string[] {
  const set = new Set<string>();
  const limit = opts.maxPerColumn ?? 2000;
  const dbPath = join(dataDir, "vault.db");
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
      for (const s of SOURCES) {
        if (!tables.has(s.table)) continue;
        const have = new Set((db.prepare(`PRAGMA table_info("${s.table}")`).all() as Array<{ name: string }>).map((c) => c.name));
        for (const col of s.cols) {
          if (!have.has(col)) continue;
          const rows = db.prepare(`SELECT DISTINCT "${col}" AS v FROM "${s.table}" WHERE "${col}" IS NOT NULL ORDER BY rowid DESC LIMIT ?`).all(limit) as Array<{ v: unknown }>;
          for (const { v } of rows) {
            if (typeof v !== "string") continue;
            if (s.long) for (const r of printableRuns(v, 3)) set.add(r);
            else if (usable(v)) set.add(v.slice(0, 200));
          }
        }
      }
    } finally { db.close(); }
  }
  const files: string[] = [];
  walk(join(dataDir, "files"), files);
  for (const p of files) for (const r of printableRuns(readFileSync(p).subarray(0, 1 << 20).toString("latin1"))) set.add(r);
  for (const m of opts.extra ?? []) if (m && m.length >= 6) set.add(m);
  return [...set];
}
