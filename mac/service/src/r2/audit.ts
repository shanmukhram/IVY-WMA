/**
 * Zero-plaintext bucket audit run by the service itself (gate G1 (c), PRD
 * "zero-plaintext audit"): `@ivy/audit` over the four buckets with the Mac's own
 * in-memory tokens, so nobody has to keep a copy of them in a file.
 *
 * Markers are plaintext the Mac has decrypted (file paths and names, extracted
 * document text, window titles, notification text, OCR text, message text) plus
 * printable runs from retrieved originals under data/files/, like tools/fake-mac
 * harvests its ledger, plus any the caller passes. A pass means none of it, and
 * nothing else readable, is in any bucket.
 *
 * The result never carries plaintext: hits name the object key and the rule, and
 * a marker rule is reduced to the marker's length.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runAudit, type AuditReport } from "@ivy/audit";
import type { Ctx } from "../context.ts";
import { dirs } from "../config.ts";
import { parseToken } from "./client.ts";
import { ROLES, bucketName, endpointOf, macToken, type R2, type Role } from "./config.ts";

export type BucketId = "up-windows" | "up-android" | "cmd-windows" | "cmd-android";
export const BUCKET_IDS: BucketId[] = ["up-windows", "up-android", "cmd-windows", "cmd-android"];

export interface AuditRequest {
  /** extra markers (for example the test file's path and name) */
  markers?: string[];
  /** also harvest markers from the vault (default true) */
  harvest?: boolean;
  /** which buckets (default all four) */
  buckets?: BucketId[];
  /** only objects under this key prefix */
  prefix?: string;
}

export interface BucketAudit {
  bucket: string; dir: "up" | "cmd"; role: Role;
  objects: number; bytesScanned: number; sampled: number; hits: number; unreadable: number; vanished: number;
  error?: string;
}

export interface AuditResult {
  generatedAt: string;
  pass: boolean;
  markers: { fromRequest: number; harvested: number; total: number };
  totals: { objects: number; bytesScanned: number; fullObjects: number; sampledObjects: number; hits: number; unreadable: number; vanished: number; exemptedBootstrapRuns: number };
  sampling: AuditReport["sampling"];
  buckets: BucketAudit[];
  /** objects with hits: key and rules only */
  hits: Array<{ bucket: string; key: string; rules: string[]; offsets: number[] }>;
  unreadable: Array<{ bucket: string; key: string; error: string }>;
  errors: string[];
}

const OID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Columns that hold device plaintext. Long text is cut into printable runs. */
const SOURCES: Array<{ table: string; cols: string[]; long?: boolean }> = [
  { table: "files", cols: ["path", "name"] },
  { table: "files", cols: ["content_text"], long: true },
  { table: "usage_events", cols: ["title"] },
  { table: "notifications", cols: ["title", "preview", "sender"] },
  { table: "media", cols: ["source_path"] },
  { table: "media", cols: ["ocr_text"], long: true },
  { table: "messages", cols: ["text"], long: true },
  { table: "conversations", cols: ["chat_title"] },
  { table: "calls", cols: ["contact", "number"] },
];

const usable = (v: string) => v.length >= 6 && !OID.test(v) && !/^[0-9a-f]{32,64}$/i.test(v) && !/^\d{4}-\d\d-\d\dT/.test(v);

/** Printable ASCII runs (>= 16 chars). */
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

function headOf(path: string, bytes = 1 << 20): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("latin1");
  } finally { closeSync(fd); }
}

/** Plaintext the Mac has decrypted, as audit markers (in memory only). */
export function harvestMarkers(ctx: Ctx, maxPerColumn = 2000): string[] {
  const set = new Set<string>();
  const tables = new Set((ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
  for (const s of SOURCES) {
    if (!tables.has(s.table)) continue;
    const have = new Set((ctx.db.prepare(`PRAGMA table_info("${s.table}")`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const col of s.cols) {
      if (!have.has(col)) continue;
      const rows = ctx.db.prepare(`SELECT DISTINCT "${col}" AS v FROM "${s.table}" WHERE "${col}" IS NOT NULL ORDER BY rowid DESC LIMIT ?`).all(maxPerColumn) as Array<{ v: unknown }>;
      for (const { v } of rows) {
        if (typeof v !== "string") continue;
        if (s.long) for (const r of printableRuns(v, 3)) set.add(r);
        else if (usable(v)) set.add(v.slice(0, 200));
      }
    }
  }
  const files: string[] = [];
  walk(dirs(ctx.config).files, files);
  for (const p of files) {
    try { for (const r of printableRuns(headOf(p))) set.add(r); } catch { /* removed meanwhile */ }
  }
  return [...set];
}

/** Marker hits name the marker; keep only its length. */
export const redactRule = (rule: string) => {
  const m = /^(marker(?:-utf16)?):(.*)$/s.exec(rule);
  return m ? `${m[1]} (${m[2]!.length} chars)` : rule;
};

const parseId = (id: BucketId) => { const [dir, role] = id.split("-") as ["up" | "cmd", Role]; return { dir, role }; };

/** A pending pairing bootstrap `pair/<id>` is a sealed JSON container by spec (PROTOCOL §7): printable by nature. */
const isBootstrap = (key: string) => /^pair\/[0-9a-f]+$/.test(key);

export async function auditBuckets(ctx: Ctx, r2: R2, req: AuditRequest = {}): Promise<AuditResult> {
  const fromRequest = (req.markers ?? []).filter((m) => typeof m === "string" && m.length >= 6);
  const harvested = req.harvest === false ? [] : harvestMarkers(ctx);
  const markers = [...new Set([...harvested, ...fromRequest])];
  const endpoint = endpointOf(r2.config);
  const ids = req.buckets?.length ? req.buckets : BUCKET_IDS;
  const buckets: BucketAudit[] = [];
  const hits: AuditResult["hits"] = [];
  const unreadable: AuditResult["unreadable"] = [];
  const errors: string[] = [];
  let exempted = 0, fullObjects = 0, sampledObjects = 0;
  let sampling: AuditReport["sampling"] = { sizeThreshold: 0, windowsPerSample: 0, windowSize: 0 };

  for (const role of ROLES) {
    for (const dir of ["up", "cmd"] as const) {
      if (!ids.some((id) => { const p = parseId(id); return p.dir === dir && p.role === role; })) continue;
      const name = bucketName(r2.config, dir, role);
      const entry: BucketAudit = { bucket: name, dir, role, objects: 0, bytesScanned: 0, sampled: 0, hits: 0, unreadable: 0, vanished: 0 };
      buckets.push(entry);
      const tok = macToken(r2.config, dir, role);
      if (!tok) { entry.error = "no Mac token configured for this bucket"; errors.push(`${name}: ${entry.error}`); continue; }
      const rep = await runAudit({ buckets: [name], s3: { endpoint, ...parseToken(tok) }, markers, prefix: req.prefix, skipVanished: true });
      sampling = rep.sampling;
      entry.objects = rep.itemsScanned;
      entry.bytesScanned = rep.bytesScanned;
      entry.sampled = rep.sampledItems;
      entry.vanished = rep.vanished ?? 0;
      fullObjects += rep.fullItems;
      sampledObjects += rep.sampledItems;
      for (const e of rep.errors) { entry.error = e; errors.push(e); }
      for (const it of rep.items) {
        const key = it.name.slice(name.length + 1);
        let found = it.hits;
        if (isBootstrap(key)) {
          const kept = found.filter((h) => !h.rule.startsWith("printable-run"));
          exempted += found.length - kept.length;
          found = kept;
        }
        if (it.error) { entry.unreadable++; unreadable.push({ bucket: name, key, error: it.error }); }
        if (found.length) {
          entry.hits += found.length;
          hits.push({ bucket: name, key, rules: [...new Set(found.map((h) => redactRule(h.rule)))], offsets: found.map((h) => h.offset).slice(0, 20) });
        }
      }
    }
  }
  const totalHits = buckets.reduce((n, b) => n + b.hits, 0);
  const totalUnreadable = buckets.reduce((n, b) => n + b.unreadable, 0);
  return {
    generatedAt: new Date().toISOString(),
    pass: totalHits === 0 && totalUnreadable === 0 && errors.length === 0,
    markers: { fromRequest: fromRequest.length, harvested: harvested.length, total: markers.length },
    totals: {
      objects: buckets.reduce((n, b) => n + b.objects, 0), bytesScanned: buckets.reduce((n, b) => n + b.bytesScanned, 0),
      fullObjects, sampledObjects, hits: totalHits, unreadable: totalUnreadable, vanished: buckets.reduce((n, b) => n + b.vanished, 0),
      exemptedBootstrapRuns: exempted,
    },
    sampling, buckets, hits, unreadable, errors,
  };
}
