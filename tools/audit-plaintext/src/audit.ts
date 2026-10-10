import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomInt } from "node:crypto";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { scanBuffer, type Hit, type ScanOptions } from "./scan.ts";

export interface S3Config { endpoint: string; accessKeyId: string; secretAccessKey: string; region?: string }

export interface AuditOptions {
  buckets?: string[];
  s3?: S3Config;
  /** Only objects under this key prefix (default: the whole bucket). */
  prefix?: string;
  /**
   * An object deleted between the listing and the read (a live ingest removes what it
   * committed) is dropped and counted in `vanished` instead of being an unreadable item.
   */
  skipVanished?: boolean;
  sqliteFiles?: string[];
  dirs?: string[];
  markers?: string[];
  /** Objects <= this are always downloaded in full. Default 8 MiB. */
  sizeThreshold?: number;
  /** How many objects above the threshold to sample. Default 3. */
  largeSample?: number;
  /** Random windows per sampled large object (plus the first window). Default 2. */
  windowsPerLarge?: number;
  windowSize?: number;
  minPrintableRun?: number;
  headerAllowance?: number;
}

export interface ScannedItem {
  source: "s3" | "sqlite" | "dir";
  name: string;
  size: number;
  scannedBytes: number;
  sampled: boolean;
  hits: Hit[];
  error?: string;
}

export interface AuditReport {
  generatedAt: string;
  pass: boolean;
  totalHits: number;
  /** All items, full and sampled. */
  itemsScanned: number;
  /** Bytes actually read, full and sampled. */
  bytesScanned: number;
  /** Items read in full. */
  fullItems: number;
  fullBytes: number;
  /** Objects above sampling.sizeThreshold, read as ranges only. */
  sampledItems: number;
  sampledBytes: number;
  sampling: { sizeThreshold: number; windowsPerSample: number; windowSize: number };
  items: ScannedItem[];
  errors: string[];
  /** Objects listed but gone before they could be read (only with skipVanished). */
  vanished?: number;
}

const MiB = 1024 * 1024;

export async function runAudit(o: AuditOptions): Promise<AuditReport> {
  const items: ScannedItem[] = [];
  const errors: string[] = [];
  const gone = { n: 0 };
  const base: ScanOptions = { markers: o.markers, minPrintableRun: o.minPrintableRun, headerAllowance: o.headerAllowance };

  if (o.buckets?.length) {
    if (!o.s3) throw new Error("S3 configuration required to audit buckets");
    const s3 = new S3Client({
      endpoint: o.s3.endpoint, region: o.s3.region ?? "auto", forcePathStyle: true,
      credentials: { accessKeyId: o.s3.accessKeyId, secretAccessKey: o.s3.secretAccessKey },
    });
    for (const bucket of o.buckets) {
      try { items.push(...(await auditBucket(s3, bucket, o, base, gone))); }
      catch (e) { errors.push(`bucket ${bucket}: ${(e as Error).message}`); }
    }
  }
  for (const f of o.sqliteFiles ?? []) {
    try { items.push(...auditSqlite(f, base)); } catch (e) { errors.push(`sqlite ${f}: ${(e as Error).message}`); }
  }
  for (const d of o.dirs ?? []) {
    try { items.push(...auditDir(d, base)); } catch (e) { errors.push(`dir ${d}: ${(e as Error).message}`); }
  }

  const totalHits = items.reduce((n, i) => n + i.hits.length, 0);
  const full = items.filter((i) => !i.sampled);
  const sampled = items.filter((i) => i.sampled);
  const sumBytes = (xs: ScannedItem[]) => xs.reduce((n, i) => n + i.scannedBytes, 0);
  return {
    generatedAt: new Date().toISOString(),
    // an unreadable source is a failure: we cannot claim zero plaintext about what we could not read
    pass: totalHits === 0 && errors.length === 0 && items.every((i) => !i.error),
    totalHits,
    itemsScanned: items.length,
    bytesScanned: items.reduce((n, i) => n + i.scannedBytes, 0),
    fullItems: full.length,
    fullBytes: sumBytes(full),
    sampledItems: sampled.length,
    sampledBytes: sumBytes(sampled),
    // windows per sampled object = the first window plus windowsPerLarge random ones (see auditBucket)
    sampling: { sizeThreshold: o.sizeThreshold ?? 8 * MiB, windowsPerSample: (o.windowsPerLarge ?? 2) + 1, windowSize: o.windowSize ?? MiB },
    items,
    errors,
    ...(o.skipVanished ? { vanished: gone.n } : {}),
  };
}

async function getBytes(s3: S3Client, bucket: string, key: string, range?: string): Promise<Buffer> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

const isNotFound = (e: unknown) =>
  (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404 || (e as Error)?.name === "NoSuchKey";

async function auditBucket(s3: S3Client, bucket: string, o: AuditOptions, base: ScanOptions, gone: { n: number }): Promise<ScannedItem[]> {
  const threshold = o.sizeThreshold ?? 8 * MiB;
  const win = o.windowSize ?? MiB;
  const all: Array<{ key: string; size: number }> = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: o.prefix, ContinuationToken: token }));
    for (const c of r.Contents ?? []) all.push({ key: c.Key!, size: c.Size ?? 0 });
    token = r.NextContinuationToken;
  } while (token);

  const small = all.filter((x) => x.size <= threshold);
  const large = all.filter((x) => x.size > threshold);
  const sample = shuffle(large).slice(0, o.largeSample ?? 3);
  const out: ScannedItem[] = [];

  for (const obj of small) {
    const name = `${bucket}/${obj.key}`;
    try {
      const buf = await getBytes(s3, bucket, obj.key);
      out.push({ source: "s3", name, size: obj.size, scannedBytes: buf.length, sampled: false, hits: scanBuffer(buf, base) });
    } catch (e) {
      if (o.skipVanished && isNotFound(e)) { gone.n++; continue; }
      out.push({ source: "s3", name, size: obj.size, scannedBytes: 0, sampled: false, hits: [], error: (e as Error).message });
    }
  }
  for (const obj of sample) {
    const name = `${bucket}/${obj.key}`;
    try {
      const hits: Hit[] = [];
      let scanned = 0;
      const starts = [0];
      for (let i = 0; i < (o.windowsPerLarge ?? 2); i++) starts.push(randomInt(0, Math.max(1, obj.size - win)));
      for (const start of starts) {
        const end = Math.min(obj.size - 1, start + win - 1);
        const buf = await getBytes(s3, bucket, obj.key, `bytes=${start}-${end}`);
        scanned += buf.length;
        for (const h of scanBuffer(buf, { ...base, atStart: start === 0 })) hits.push({ ...h, offset: h.offset + start });
      }
      out.push({ source: "s3", name, size: obj.size, scannedBytes: scanned, sampled: true, hits });
    } catch (e) {
      if (o.skipVanished && isNotFound(e)) { gone.n++; continue; }
      out.push({ source: "s3", name, size: obj.size, scannedBytes: 0, sampled: true, hits: [], error: (e as Error).message });
    }
  }
  return out;
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [r[i], r[j]] = [r[j]!, r[i]!]; }
  return r;
}

/**
 * SQLite queue files. Two passes:
 *  1. Raw file bytes (and -wal): markers, generic JSON markers and magic bytes only. This catches plaintext left in
 *     free pages or the WAL. The printable-run rule is off because the schema and column names are legitimately text.
 *  2. Logical values: every BLOB gets the full ruleset; every TEXT value gets markers/magic but not the run rule.
 */
function auditSqlite(file: string, base: ScanOptions): ScannedItem[] {
  if (!existsSync(file)) throw new Error("file not found");
  const out: ScannedItem[] = [];
  for (const f of [file, file + "-wal", file + "-journal"]) {
    if (!existsSync(f)) continue;
    const buf = readFileSync(f);
    out.push({ source: "sqlite", name: `${f} (raw)`, size: buf.length, scannedBytes: buf.length, sampled: false,
      hits: scanBuffer(buf, { ...base, skipPrintableRun: true }) });
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const hits: Hit[] = [];
      let bytes = 0, rows = 0;
      const stmt = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
      for (const row of stmt.all() as Array<Record<string, unknown>>) {
        rows++;
        for (const [col, v] of Object.entries(row)) {
          let found: Hit[] = [];
          if (v instanceof Uint8Array) { const b = Buffer.from(v); bytes += b.length; found = scanBuffer(b, base); }
          else if (typeof v === "string") { const b = Buffer.from(v, "utf8"); bytes += b.length; found = scanBuffer(b, { ...base, skipPrintableRun: true }); }
          for (const h of found) if (hits.length < 20) hits.push({ ...h, rule: `${h.rule} [row ${rows} col ${col}]` });
        }
      }
      out.push({ source: "sqlite", name: `${file}#${name} (${rows} rows)`, size: bytes, scannedBytes: bytes, sampled: false, hits });
    }
  } finally {
    db.close();
  }
  return out;
}

function auditDir(dir: string, base: ScanOptions): ScannedItem[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error("not a directory");
  const out: ScannedItem[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = readFileSync(p);
        out.push({ source: "dir", name: join(dir, relative(dir, p)), size: buf.length, scannedBytes: buf.length, sampled: false, hits: scanBuffer(buf, base) });
      }
    }
  };
  walk(dir);
  return out;
}

const fmtBytes = (n: number) =>
  n >= MiB ? `${+(n / MiB).toFixed(1)} MiB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KiB` : `${n} bytes`;

export function formatSummary(r: AuditReport): string {
  const lines: string[] = [];
  lines.push(`IVY zero-plaintext audit  ${r.generatedAt}`);
  const sampledDetail = r.sampledItems
    ? ` (${r.sampling.windowsPerSample} x ${fmtBytes(r.sampling.windowSize)} ranges each, ${fmtBytes(r.sampledBytes)})`
    : "";
  lines.push(`Scanned ${r.fullItems} items in full (${fmtBytes(r.fullBytes)}); sampled ${r.sampledItems} objects above ${fmtBytes(r.sampling.sizeThreshold)}${sampledDetail}.`);
  for (const i of r.items) {
    if (i.hits.length || i.error) {
      lines.push(`  FAIL ${i.name}${i.sampled ? " (sampled)" : ""}${i.error ? "  ERROR " + i.error : ""}`);
      for (const h of i.hits) lines.push(`       ${h.rule} @${h.offset}: ${h.evidence}`);
    }
  }
  for (const e of r.errors) lines.push(`  ERROR ${e}`);
  if (r.itemsScanned === 0) lines.push("  WARNING: nothing was scanned.");
  lines.push(r.pass ? "RESULT: PASS (0 hits)" : `RESULT: FAIL (${r.totalHits} hit(s), ${r.errors.length} error(s))`);
  return lines.join("\n");
}
