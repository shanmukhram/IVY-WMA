/**
 * Service configuration. Precedence: defaults < environment (IVY_*) < explicit
 * overrides (CLI flags or the object passed to createService in tests).
 *
 * Settings the user changes at runtime (auto-lock minutes, bin retention, R2)
 * live in the vault database `settings` table, not here; the values below are
 * only their first-run defaults.
 */
import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ServiceConfig {
  /** root of everything the service writes */
  dataDir: string;
  /** SQLite vault; default <dataDir>/vault.db */
  dbPath: string;
  /** Mac identity (salt, public key, sealed private key); default <dataDir>/identity.json */
  identityPath: string;
  /** local bearer token for the HTTP API; default <dataDir>/session.token */
  tokenPath: string;
  /** directory served at / (the dashboard web app) */
  staticDir: string;
  host: string;
  port: number;
  /** S1: poll both up-buckets this often (ms); 0 disables the timer */
  pollIntervalMs: number;
  /** first-run default for auto-lock (S8); 0 = never */
  autoLockMinutes: number;
  /** pairing code lifetime (PROTOCOL §7: 10 minutes) */
  pairingTtlMs: number;
  /** a device object written up to this long after exp is still accepted (clock skew) */
  pairingGraceMs: number;
  /**
   * How far back each record prefix other than `up/blob/` is listed, counted from that prefix's own
   * position (the newest oid it has settled). Devices upload out of oid order (offline queues drain late),
   * so listing strictly after the position would skip a late record. Those prefixes are deleted from R2
   * after commit, so looking back costs nothing at idle. `up/blob/` keeps media originals (PLAN decision 11)
   * and is listed from its own position without this look-back. Also: when the last successful poll is older
   * than this, the next pass lists the bucket in full (the Mac was away). Default 8 days. There is no
   * lifecycle expiry on the up-buckets (PLAN decision 6); a full listing also runs on start, after unlock,
   * hourly, and after a device comes back (deviceReturnFullMs).
   */
  listLookbackMs: number;
  /** most file-listing / large-media objects ingested per pass; small high-priority records always flow */
  ingestBulkBudget: number;
  /** a full listing of the bucket (catches unrecognised keys) at most this often */
  fullSweepEveryMs: number;
  /**
   * A device_report from a device the Mac has heard nothing from for longer than this makes the next pass
   * list that bucket in full: the device's offline queue may now upload records whose oids are older than
   * the listing positions. Default 10 minutes (Windows reports every 30 s).
   */
  deviceReturnFullMs: number;
  /** chunk parts whose manifest never arrives are quarantined after this long (7 days) */
  orphanPartMs: number;
  /** refuse to buffer a single part bigger than this (bounded memory) */
  maxPartBytes: number;
  /** quarantined ciphertext bigger than this is recorded but not kept on disk */
  maxQuarantineBytes: number;
  /** coverage: amber when a collector's last run is older than this */
  amberAfterMs: number;
  /** coverage: red when a collector's last run / last report is older than this */
  redAfterMs: number;
  /** timeline: consecutive collector runs further apart than this are a gap */
  gapThresholdMs: number;
  /** first-run default for the recovery-bin retention (days) */
  binRetentionDays: number;
  /** how many activity events to keep in the database */
  activityKeep: number;
  /**
   * OCR provider: "vision" (@ivy/mac-ocr, Apple Vision; default on macOS), "command"
   * (ocrCommand), or "off".
   */
  ocr: "vision" | "command" | "off";
  /** with ocr = "command": executable called as `<cmd> <imagePath>`, prints text on stdout */
  ocrCommand?: string;
  /** media items OCR'd / thumbnailed at once (bounded concurrency) */
  ocrConcurrency: number;
  /** thumbnail fallback with macOS `sips` when the Vision helper is unavailable (default true on darwin) */
  thumbnails: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
/** mac/service, resolved from this file (not from the working directory) */
const packageDir = resolve(here, "..");

/**
 * Default directory served at /: the built dashboard (`mac/ui/dist`) when it has
 * an index.html, else the placeholder page in `mac/service/public`. Both are
 * located relative to this package, so `pnpm --filter @ivy/mac-service start`
 * serves the UI whatever the working directory.
 */
export function defaultStaticDir(pkgDir: string = packageDir): string {
  const ui = resolve(pkgDir, "..", "ui", "dist");
  return existsSync(join(ui, "index.html")) ? ui : join(pkgDir, "public");
}
const SEC = 1_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function loadConfig(overrides: Partial<ServiceConfig> = {}, cwd: string = process.cwd()): ServiceConfig {
  // relative paths (flags or env) resolve against the working directory; @fastify/static needs an absolute root
  const abs = (p: string) => resolve(cwd, p);
  const o = stripUndefined(overrides);
  const env = (name: string) => (process.env[name] ? process.env[name] : undefined);
  const dataDir = abs(o.dataDir ?? env("IVY_DATA_DIR") ?? "./data");
  const base: ServiceConfig = {
    dataDir,
    dbPath: join(dataDir, "vault.db"),
    identityPath: join(dataDir, "identity.json"),
    tokenPath: join(dataDir, "session.token"),
    staticDir: defaultStaticDir(),
    host: process.env.IVY_HOST ?? "127.0.0.1",
    port: envInt("IVY_PORT") ?? 4777,
    pollIntervalMs: envInt("IVY_POLL_INTERVAL_MS") ?? 5 * SEC,
    autoLockMinutes: envInt("IVY_AUTO_LOCK_MINUTES") ?? 30,
    pairingTtlMs: 10 * MIN,
    pairingGraceMs: 5 * MIN,
    listLookbackMs: envInt("IVY_LIST_LOOKBACK_MS") ?? 8 * DAY,
    ingestBulkBudget: envInt("IVY_INGEST_BULK_BUDGET") ?? 3000,
    fullSweepEveryMs: 60 * MIN,
    deviceReturnFullMs: envInt("IVY_DEVICE_RETURN_FULL_MS") ?? 10 * MIN,
    orphanPartMs: 7 * DAY,
    maxPartBytes: 64 * 1024 * 1024,
    maxQuarantineBytes: 64 * 1024 * 1024,
    amberAfterMs: 15 * MIN,
    redAfterMs: 60 * MIN,
    gapThresholdMs: 15 * MIN,
    binRetentionDays: 30,
    activityKeep: 5000,
    ocr: process.env.IVY_OCR === "0" || process.env.IVY_OCR === "off" ? "off"
      : process.env.IVY_OCR_COMMAND ? "command"
      : process.platform === "darwin" ? "vision" : "off",
    ocrCommand: process.env.IVY_OCR_COMMAND || undefined,
    ocrConcurrency: envInt("IVY_OCR_CONCURRENCY") ?? 2,
    thumbnails: process.platform === "darwin" && process.env.IVY_THUMBNAILS !== "0",
  };
  const merged: ServiceConfig = { ...base, ...o, dataDir };
  // explicit override > env > derived from the (resolved) data directory
  const dbPath = o.dbPath ?? env("IVY_DB_PATH");
  if (dbPath) merged.dbPath = abs(dbPath);
  const staticDir = o.staticDir ?? env("IVY_STATIC_DIR");
  if (staticDir) merged.staticDir = abs(staticDir);
  if (o.identityPath) merged.identityPath = abs(o.identityPath);
  if (o.tokenPath) merged.tokenPath = abs(o.tokenPath);
  return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Local directories under dataDir. */
export const dirs = (c: ServiceConfig) => ({
  media: join(c.dataDir, "media"),
  thumbs: join(c.dataDir, "thumbs"),
  files: join(c.dataDir, "files"),
  attachments: join(c.dataDir, "attachments"),
  avatars: join(c.dataDir, "avatars"),
  blobsTmp: join(c.dataDir, "blobs"),
  quarantine: join(c.dataDir, "quarantine"),
});
