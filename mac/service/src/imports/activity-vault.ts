/**
 * Activity Vault read-only import (PRD S7).
 *
 * Activity Vault is a separate product that keeps a local archive of the user's
 * Google activity (YouTube, Search, Maps, Play, ...). IVY copies its rows into
 * `browsing_events` (type `browsing` in search and on the timeline) on a daily
 * schedule and on demand, and NEVER writes to the source.
 *
 * Sources sit behind `ActivityVaultSource`:
 *   - `LocalArchiveSource`: an on-disk archive (SQLite or JSON / JSON Lines),
 *     opened read-only (SQLite `readonly` + `query_only`; JSON is only read).
 *   - `McpActivityVaultSource`: stub for the MCP / HTTP transport (TODO below).
 *
 * Expected minimal shape of a local archive
 *   SQLite: a table (preferably named `activity`, `activities`, `items` or
 *     `events`) with at least `time`, `product`, `title`, and optionally
 *     `subtitle`, `link` (or `url`), `id`, `captured_at`. `time` is ISO-8601 or
 *     epoch seconds / ms / µs. Optionally a `capture_status` table with `date`
 *     (YYYY-MM-DD), `status` ('healthy' | 'gap' | 'unknown') and `note`: what
 *     the source itself says about each day's capture.
 *   JSON: `[row, ...]` or `{ "items": [row, ...], "captureStatus": { "healthy": bool,
 *     "reportedAt": iso, "days": [{ "date", "status", "note" }] } }`, rows as above
 *     (camelCase `capturedAt` also accepted). JSON Lines: one row object per line.
 *   A directory is searched for the first `*.sqlite|*.sqlite3|*.db`, then
 *   `*.json|*.jsonl|*.ndjson` (names containing "activity" first).
 *
 * Coverage (D3, principle 4): a day with no imported rows is a gap only when
 * the source itself reported a capture gap for that day; otherwise it is
 * "unknown". Nothing is inferred.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import Database from "better-sqlite3";
import type { Ctx } from "../context.ts";
import { getSetting, setSetting, deleteSetting } from "../db/index.ts";
import { dayBounds, localZone, msOf, nowIso } from "../util/time.ts";

export interface ActivityRow {
  id?: string | null;
  time: string;
  product: string;
  title: string;
  subtitle?: string | null;
  link?: string | null;
  capturedAt?: string | null;
}

export interface CaptureStatus {
  /** what the source says about capture overall; null when it does not say */
  healthy: boolean | null;
  reportedAt: string | null;
  days: Array<{ date: string; status: "healthy" | "gap" | "unknown"; note?: string | null }>;
}

export interface ActivityVaultSource {
  readonly adapter: "local" | "mcp";
  readonly location: string;
  /** a description of what was detected (format, table, columns) */
  describe(): Record<string, unknown>;
  rows(): AsyncIterable<ActivityRow | { invalid: string }>;
  captureStatus(): Promise<CaptureStatus | null>;
  close(): void;
}

export class ImportError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, m: string) { super(m); this.status = status; this.code = code; }
}

// ------------------------------------------------------------------ normalisation

/** ISO time from ISO text or epoch s / ms / µs; null when the source gave no usable time (never invented). */
export function normTime(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  let n: number | null = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
  if (n !== null) {
    if (n > 1e17) n = n / 1e6;       // ns
    else if (n > 1e14) n = n / 1e3;  // µs
    else if (n < 1e11) n = n * 1e3;  // s
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function normRow(raw: Record<string, unknown>): ActivityRow | { invalid: string } {
  const time = normTime(raw.time ?? raw.timestamp ?? raw.ts);
  const product = str(raw.product ?? raw.header);
  const title = str(raw.title);
  if (!time) return { invalid: "no usable time" };
  if (!product || !title) return { invalid: "missing product or title" };
  return {
    id: str(raw.id ?? raw.uid ?? raw.item_id), time, product: product.slice(0, 200), title: title.slice(0, 2000),
    subtitle: str(raw.subtitle ?? raw.description)?.slice(0, 4000) ?? null,
    link: str(raw.link ?? raw.url ?? raw.title_url)?.slice(0, 4000) ?? null,
    capturedAt: normTime(raw.captured_at ?? raw.capturedAt ?? raw.capture_time),
  };
}

function normStatus(raw: unknown): CaptureStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const days = Array.isArray(r.days) ? (r.days as Array<Record<string, unknown>>).flatMap((d) => {
    const date = str(d.date);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const s = str(d.status);
    return [{ date, status: (s === "healthy" || s === "gap" ? s : "unknown") as "healthy" | "gap" | "unknown", note: str(d.note) }];
  }) : [];
  return { healthy: typeof r.healthy === "boolean" ? r.healthy : null, reportedAt: normTime(r.reportedAt ?? r.reported_at), days };
}

// ------------------------------------------------------------------ local archive

const TIME_COLS = ["time", "timestamp", "ts"];
const PRODUCT_COLS = ["product", "header"];
const PREFERRED_TABLES = ["activity", "activities", "items", "events"];

function sniff(path: string): "sqlite" | "json" | "jsonl" {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(64);
    const n = readSync(fd, b, 0, 64, 0);
    if (b.subarray(0, 16).toString("latin1") === "SQLite format 3\u0000") return "sqlite";
    const head = b.subarray(0, n).toString("utf8").trimStart();
    if (head.startsWith("[")) return "json";
    if (extname(path).toLowerCase() === ".json" && head.startsWith("{")) return "json";
    return "jsonl";
  } finally { closeSync(fd); }
}

function findArchive(dir: string): string | null {
  const entries = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const rank = (f: string) => (f.toLowerCase().includes("activity") ? 0 : 1);
  for (const exts of [[".sqlite", ".sqlite3", ".db"], [".json", ".jsonl", ".ndjson"]]) {
    const hits = entries.filter((f) => exts.includes(extname(f).toLowerCase())).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (hits.length) return join(dir, hits[0]!);
  }
  return null;
}

export class LocalArchiveSource implements ActivityVaultSource {
  readonly adapter = "local" as const;
  readonly location: string;
  readonly file: string;
  readonly format: "sqlite" | "json" | "jsonl";
  private db: Database.Database | null = null;
  private table: string | null = null;
  private cols: Record<string, string> = {};
  private json: { rows: unknown[]; status: unknown } | null = null;

  constructor(path: string) {
    this.location = path;
    if (!path || !existsSync(path)) throw new ImportError(409, "source_not_found", `no Activity Vault archive at ${path || "(no path set)"}`);
    const file = statSync(path).isDirectory() ? findArchive(path) : path;
    if (!file) throw new ImportError(409, "source_not_found", `no SQLite or JSON archive in ${path}`);
    this.file = file;
    this.format = sniff(file);
    if (this.format === "sqlite") this.openSqlite();
  }

  private openSqlite() {
    // read-only: the source is never written (no WAL checkpoint, no schema change, no pragma that writes)
    const db = new Database(this.file, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    this.db = db;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
    const ordered = [...tables].sort((a, b) => {
      const ra = PREFERRED_TABLES.indexOf(a.toLowerCase()), rb = PREFERRED_TABLES.indexOf(b.toLowerCase());
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.localeCompare(b);
    });
    for (const t of ordered) {
      const cols = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as Array<{ name: string }>).map((c) => c.name);
      const lower = new Map(cols.map((c) => [c.toLowerCase(), c]));
      const pick = (names: string[]) => names.map((n) => lower.get(n)).find(Boolean);
      const time = pick(TIME_COLS), product = pick(PRODUCT_COLS), title = pick(["title"]);
      if (!time || !product || !title) continue;
      this.table = t;
      this.cols = Object.fromEntries(Object.entries({
        time, product, title, subtitle: pick(["subtitle", "description"]), link: pick(["link", "url", "title_url"]),
        id: pick(["id", "uid", "item_id"]), captured_at: pick(["captured_at", "capture_time", "inserted_at"]),
      }).filter(([, v]) => v)) as Record<string, string>;
      return;
    }
    db.close();
    this.db = null;
    throw new ImportError(409, "source_unrecognised", `${this.file}: no table with time, product and title columns`);
  }

  private loadJson() {
    if (this.json) return this.json;
    const text = readFileSync(this.file, "utf8");
    if (this.format === "json") {
      const v = JSON.parse(text) as unknown;
      if (Array.isArray(v)) this.json = { rows: v, status: null };
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const rows = (o.items ?? o.activity ?? o.rows ?? []) as unknown[];
        if (!Array.isArray(rows)) throw new ImportError(409, "source_unrecognised", `${this.file}: expected an array of rows or { items: [...] }`);
        this.json = { rows, status: o.captureStatus ?? o.capture_status ?? null };
      } else throw new ImportError(409, "source_unrecognised", `${this.file}: not an Activity Vault JSON archive`);
    } else {
      const rows: unknown[] = [];
      for (const line of text.split(/\r?\n/)) { const l = line.trim(); if (!l) continue; try { rows.push(JSON.parse(l)); } catch { rows.push({ __bad: true }); } }
      this.json = { rows, status: null };
    }
    return this.json;
  }

  describe() {
    return { adapter: this.adapter, file: this.file, format: this.format, ...(this.table ? { table: this.table, columns: this.cols } : {}) };
  }

  async *rows(): AsyncIterable<ActivityRow | { invalid: string }> {
    if (this.db && this.table) {
      const sel = Object.entries(this.cols).map(([k, c]) => `"${c.replace(/"/g, '""')}" AS ${k}`).join(", ");
      for (const r of this.db.prepare(`SELECT ${sel} FROM "${this.table.replace(/"/g, '""')}"`).iterate() as Iterable<Record<string, unknown>>) yield normRow(r);
      return;
    }
    for (const r of this.loadJson().rows) {
      if (!r || typeof r !== "object" || (r as Record<string, unknown>).__bad) { yield { invalid: "not a JSON object" }; continue; }
      yield normRow(r as Record<string, unknown>);
    }
  }

  async captureStatus(): Promise<CaptureStatus | null> {
    if (this.db) {
      const has = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = 'capture_status'").get() as { name: string } | undefined;
      if (!has) return null;
      const cols = (this.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(has.name) as Array<{ name: string }>).map((c) => c.name.toLowerCase());
      if (!cols.includes("date") || !cols.includes("status")) return null;
      const days = this.db.prepare(`SELECT date, status${cols.includes("note") ? ", note" : ""} FROM "${has.name}" ORDER BY date`).all();
      return normStatus({ days, healthy: null });
    }
    return normStatus(this.loadJson().status);
  }

  close() { this.db?.close(); this.db = null; }
}

/**
 * TODO(S7 transport): Activity Vault is reachable as an MCP server with the tools
 * `search`, `timeline` and `capture_status`. The intended mapping:
 *   rows()          -> for each day since the last successful import (and the
 *                      previous 2 days, for late rows), call `timeline({date})`
 *                      and yield its items as { time, product, title, subtitle, link, id };
 *   captureStatus() -> `capture_status()`, mapped to { healthy, reportedAt, days }.
 * The transport (stdio command vs HTTP/SSE endpoint), authentication and the
 * exact response shapes are not known yet, so this adapter refuses to run.
 */
export class McpActivityVaultSource implements ActivityVaultSource {
  readonly adapter = "mcp" as const;
  readonly location: string;
  constructor(url: string) { this.location = url; }
  describe() { return { adapter: this.adapter, url: this.location, implemented: false }; }
  // eslint-disable-next-line require-yield
  async *rows(): AsyncIterable<ActivityRow> { throw new ImportError(501, "not_implemented", "the MCP/HTTP Activity Vault adapter is a stub: the transport is not known yet (TODO in src/imports/activity-vault.ts)"); }
  async captureStatus(): Promise<CaptureStatus | null> { return null; }
  close() { /* nothing open */ }
}

// ------------------------------------------------------------------ settings

export interface AvSettings { enabled: boolean; adapter: "local" | "mcp"; path: string | null; url: string | null }

export function readAvSettings(ctx: Ctx): AvSettings {
  const a = getSetting(ctx.db, "imports.activityVault.adapter");
  return {
    enabled: getSetting(ctx.db, "imports.activityVault.enabled") === "true",
    adapter: a === "mcp" ? "mcp" : "local",
    path: getSetting(ctx.db, "imports.activityVault.path") ?? null,
    url: getSetting(ctx.db, "imports.activityVault.url") ?? null,
  };
}

export function writeAvSettings(ctx: Ctx, b: Record<string, unknown>): AvSettings {
  for (const k of Object.keys(b)) if (!["enabled", "adapter", "path", "url"].includes(k)) throw new ImportError(400, "bad_key", `unknown setting ${k}`);
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new ImportError(400, "bad_value", "enabled must be a boolean");
  if (b.adapter !== undefined && b.adapter !== "local" && b.adapter !== "mcp") throw new ImportError(400, "bad_value", 'adapter must be "local" or "mcp"');
  for (const k of ["path", "url"]) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "string") throw new ImportError(400, "bad_value", `${k} must be a string`);
  if (b.enabled !== undefined) setSetting(ctx.db, "imports.activityVault.enabled", String(b.enabled));
  if (b.adapter !== undefined) setSetting(ctx.db, "imports.activityVault.adapter", b.adapter as string);
  for (const k of ["path", "url"]) {
    if (b[k] === null || b[k] === "") deleteSetting(ctx.db, `imports.activityVault.${k}`);
    else if (typeof b[k] === "string") setSetting(ctx.db, `imports.activityVault.${k}`, (b[k] as string).trim());
  }
  return readAvSettings(ctx);
}

export function openSource(s: AvSettings): ActivityVaultSource {
  if (s.adapter === "mcp") {
    if (!s.url) throw new ImportError(409, "source_not_configured", "set the Activity Vault URL first");
    return new McpActivityVaultSource(s.url);
  }
  if (!s.path) throw new ImportError(409, "source_not_configured", "set the Activity Vault archive path first");
  return new LocalArchiveSource(s.path);
}

// ------------------------------------------------------------------ import

const running = new WeakMap<Ctx, Promise<unknown>>();

export function sourceKey(r: ActivityRow): string {
  if (r.id) return `id:${r.id}`;
  return "h:" + createHash("sha256").update([r.time, r.product, r.title, r.link ?? ""].join("\u0000")).digest("hex");
}

export interface RunView {
  id: string; adapter: string; location: string | null; trigger: string; startedAt: string; finishedAt: string | null;
  status: "running" | "ok" | "error"; rowsSeen: number; rowsAdded: number; rowsSkipped: number; error: string | null;
  captureStatus: CaptureStatus | null;
}

function runView(r: Record<string, unknown>): RunView {
  return {
    id: r.id as string, adapter: r.adapter as string, location: (r.location as string) ?? null, trigger: r.trigger as string,
    startedAt: r.started_at as string, finishedAt: (r.finished_at as string) ?? null, status: r.status as RunView["status"],
    rowsSeen: r.rows_seen as number, rowsAdded: r.rows_added as number, rowsSkipped: r.rows_skipped as number, error: (r.error as string) ?? null,
    captureStatus: r.capture_status ? JSON.parse(r.capture_status as string) : null,
  };
}

export function lastRuns(ctx: Ctx, limit = 10): RunView[] {
  return (ctx.db.prepare("SELECT * FROM import_runs WHERE source = 'activity_vault' ORDER BY started_at DESC, rid DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>).map(runView);
}

export function isImportRunning(ctx: Ctx): boolean { return running.has(ctx); }

/** One import pass. Read-only on the source; idempotent on the vault (source_key dedupe, tombstones). */
export async function runActivityVaultImport(ctx: Ctx, opts: { trigger: "schedule" | "manual"; source?: ActivityVaultSource }): Promise<RunView> {
  if (running.has(ctx)) throw new ImportError(409, "already_running", "an Activity Vault import is already running");
  const settings = readAvSettings(ctx);
  const id = randomUUID();
  const started = nowIso();
  const location = opts.source?.location ?? (settings.adapter === "mcp" ? settings.url : settings.path);
  ctx.db.prepare("INSERT INTO import_runs(id, source, adapter, location, trigger, started_at, status) VALUES (?, 'activity_vault', ?, ?, ?, ?, 'running')")
    .run(id, opts.source?.adapter ?? settings.adapter, location, opts.trigger, started);
  const work = (async () => {
    let src: ActivityVaultSource | null = null;
    let seen = 0, added = 0, skipped = 0;
    try {
      src = opts.source ?? openSource(settings);
      const tomb = ctx.db.prepare("SELECT 1 FROM import_tombstones WHERE source = 'activity_vault' AND source_key = ?");
      const ins = ctx.db.prepare(`INSERT OR IGNORE INTO browsing_events(id, source, source_key, time, product, title, subtitle, link, captured_at, imported_at)
                                  VALUES (?, 'activity_vault', ?, ?, ?, ?, ?, ?, ?, ?)`);
      const at = nowIso();
      let batch: ActivityRow[] = [];
      const flush = () => {
        ctx.db.transaction(() => {
          for (const r of batch) {
            const k = sourceKey(r);
            if (tomb.get(k)) { skipped++; continue; }
            added += ins.run(randomUUID(), k, r.time, r.product, r.title, r.subtitle ?? null, r.link ?? null, r.capturedAt ?? at, at).changes;
          }
        })();
        batch = [];
      };
      for await (const r of src.rows()) {
        seen++;
        if ("invalid" in r) { skipped++; continue; }
        batch.push(r);
        if (batch.length >= 1000) flush();
      }
      flush();
      const status = await src.captureStatus();
      ctx.db.prepare("UPDATE import_runs SET finished_at = ?, status = 'ok', rows_seen = ?, rows_added = ?, rows_skipped = ?, capture_status = ? WHERE id = ?")
        .run(nowIso(), seen, added, skipped, status ? JSON.stringify(status) : null, id);
      ctx.events.emit("import.completed", { source: "activity_vault", runId: id, rowsAdded: added });
      if (added) ctx.events.emit("coverage.changed", { source: "activity_vault" });
    } catch (e) {
      ctx.db.prepare("UPDATE import_runs SET finished_at = ?, status = 'error', rows_seen = ?, rows_added = ?, rows_skipped = ?, error = ? WHERE id = ?")
        .run(nowIso(), seen, added, skipped, (e as Error).message, id);
      ctx.events.emit("import.failed", { source: "activity_vault", runId: id });
    } finally {
      src?.close();
    }
  })();
  running.set(ctx, work);
  try { await work; } finally { running.delete(ctx); }
  return runView(ctx.db.prepare("SELECT * FROM import_runs WHERE id = ?").get(id) as Record<string, unknown>);
}

/** Daily schedule: checks hourly; runs when enabled, the key is in memory, and the last successful run is over a day old. */
export function startActivityVaultSchedule(ctx: Ctx, opts: { checkEveryMs?: number; firstCheckMs?: number; everyMs?: number } = {}): () => void {
  const every = opts.everyMs ?? 24 * 3600_000;
  const check = () => {
    const s = readAvSettings(ctx);
    if (!s.enabled || !ctx.keystore.isUnlocked() || running.has(ctx)) return;
    const last = ctx.db.prepare("SELECT MAX(started_at) AS t FROM import_runs WHERE source = 'activity_vault' AND status = 'ok'").get() as { t: string | null };
    if (last.t && Date.now() - (msOf(last.t) ?? 0) < every) return;
    void runActivityVaultImport(ctx, { trigger: "schedule" }).catch(() => undefined);
  };
  const first = setTimeout(check, opts.firstCheckMs ?? 60_000);
  const timer = setInterval(check, opts.checkEveryMs ?? 3600_000);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ------------------------------------------------------------------ coverage row

const DAY_MS = 86400_000;
const p2 = (n: number) => String(n).padStart(2, "0");
const localDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

/** The coverage page's "Activity Vault import" row (D1-D3). */
export function activityVaultCoverage(ctx: Ctx, now = Date.now(), days = 14) {
  const s = readAvSettings(ctx);
  const runs = lastRuns(ctx, 1);
  const last = runs[0] ?? null;
  const lastOk = (ctx.db.prepare("SELECT * FROM import_runs WHERE source = 'activity_vault' AND status = 'ok' ORDER BY started_at DESC, rid DESC LIMIT 1").get() as Record<string, unknown> | undefined);
  const okView = lastOk ? runView(lastOk) : null;
  const total = (ctx.db.prepare("SELECT COUNT(*) AS n FROM browsing_events WHERE deleted_at IS NULL").get() as { n: number }).n;
  const first = (ctx.db.prepare("SELECT MIN(time) AS t FROM browsing_events WHERE deleted_at IS NULL").get() as { t: string | null }).t;

  let status: "green" | "amber" | "red" | "off" = "green";
  let reason = "imported";
  if (!s.enabled) { status = "off"; reason = "disabled in Settings"; }
  else if (!last) { status = "amber"; reason = "has never run"; }
  else if (last.status === "error") { status = "red"; reason = `last run failed: ${last.error}`; }
  else if (last.status === "running") { status = "green"; reason = "running now"; }
  else if (okView && now - (msOf(okView.startedAt) ?? 0) > 2 * DAY_MS) { status = "amber"; reason = "no successful import for over 2 days"; }

  // days without rows: a gap only if the source said so, otherwise unknown
  const reported = new Map((okView?.captureStatus?.days ?? []).map((d) => [d.date, d]));
  const tz = localZone();
  const gaps: Array<{ date: string; state: "gap" | "unknown"; rows: number; note: string }> = [];
  const firstDate = first ? localDate(msOf(first)!) : null;
  for (let i = days - 1; i >= 0; i--) {
    const date = localDate(now - i * DAY_MS);
    const r = reported.get(date);
    // before the archive's first row nothing is claimed either way, unless the source itself reported a gap
    if ((!firstDate || date < firstDate) && r?.status !== "gap") continue;
    const { start, end } = dayBounds(date, tz);
    const n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM browsing_events WHERE time >= ? AND time < ?").get(start, end) as { n: number }).n;
    if (r?.status === "gap") gaps.push({ date, state: "gap", rows: n, note: `the source reported a capture gap${r.note ? `: ${r.note}` : ""}` });
    else if (n === 0) gaps.push({ date, state: "unknown", rows: 0, note: r?.status === "healthy" ? "no rows; the source reported capture healthy but did not report a gap" : "no rows; the source did not report on this day" });
  }
  return {
    name: "Activity Vault import", source: "activity_vault", enabled: s.enabled, adapter: s.adapter,
    location: s.adapter === "mcp" ? s.url : s.path,
    status, statusReason: reason,
    lastRunAt: last?.startedAt ?? null, lastRunStatus: last?.status ?? null, lastError: last?.error ?? null,
    lastSuccessAt: okView?.finishedAt ?? null, lastRowsAdded: okView?.rowsAdded ?? null, rowsTotal: total, firstRowAt: first,
    captureReported: okView?.captureStatus ? { healthy: okView.captureStatus.healthy, reportedAt: okView.captureStatus.reportedAt, days: okView.captureStatus.days.length } : null,
    gaps, gapWindowDays: days,
    captures: "Google activity from the Activity Vault archive (YouTube, Search, Maps, Play, ...): time, product, title, subtitle, link. Read-only import; the archive is never modified.",
    captureKind: "metadata",
  };
}
