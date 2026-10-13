/**
 * Forget a device (Devices page, "Forget this device"): remove one of the owner's own old devices and
 * everything it contributed from the Mac's archive, so the vault holds only what the remaining devices
 * captured. It is a local operation on data/vault.db and the local cache; R2 is never read, listed or
 * changed by it.
 *
 * What goes:
 * - the revoke steps (the device's key, its collector state, its open commands);
 * - every row keyed by the device: notifications, media, files, calls, usage events, commands, collector
 *   history, quarantine entries, pairings and ingest-ledger rows, including any of them already in the
 *   recovery bin (the point is a clean slate, so the bin is not a way back);
 * - messages only this device delivered, with their attachments, prior edit versions and provenance;
 * - conversations left with no messages.
 *
 * Shared records: a message that another device also delivered (a message_sources row from a different
 * device) stays. It loses only this device's provenance rows and the attachments this device alone
 * contributed; its text is kept, labelled with a remaining source (or, when only a notification of another
 * device remains, the text that notification showed). A conversation with messages left stays, minus this
 * device's coverage claims.
 *
 * Blobs: a manifest does not name its device, so the blob rows this device's records referenced are kept as
 * `ignored` tombstones (no manifest envelope, no local paths) and their ledger rows become `ignored`. A later
 * listing of the leftover R2 objects is then settled from the ledger without a download (see the ingester).
 *
 * The device id goes into forgotten_devices. The ingester leaves any object from that id where it is: not
 * committed and not deleted from R2 (an ignored ledger row). A new pairing issues a new device id.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Ctx } from "../context.ts";
import type { DB } from "../db/index.ts";
import { dirs } from "../config.ts";
import { getDevice, TOKEN_WARNING, type DeviceRow } from "../pairing/pairing.ts";
import { bestCoverage, parseCoverageBySource, stableJson } from "../query/sources.ts";
import { removeQuietly } from "../util/fsx.ts";
import { nowIso } from "../util/time.ts";

export class ForgetError extends Error {
  readonly code: "not_found" | "bad_confirm";
  constructor(code: "not_found" | "bad_confirm", message: string) { super(message); this.code = code; }
}

/** Row counts per table, as the footprint predicts them and as the forget reports them. */
export interface ForgetCounts {
  messages: number;
  conversations: number;
  messageSources: number;
  messageEdits: number;
  attachments: number;
  notifications: number;
  media: number;
  files: number;
  calls: number;
  usageEvents: number;
  commands: number;
  quarantine: number;
  collectorState: number;
  collectorHistory: number;
  pairings: number;
  ledger: number;
  mediaArchive: number;
  blobs: number;
}

export interface Footprint {
  deviceId: string;
  role: string;
  fingerprint: string;
  /** what DELETE /api/devices/:id?wipe=1 must carry as `confirm` */
  confirmWith: "fingerprint";
  counts: ForgetCounts;
  /** records another device also has: they stay, losing only this device's provenance */
  shared: { messagesKept: number; conversationsKept: number };
  /** rows of this device already in the recovery bin; they are purged too */
  binRows: number;
  /** bytes of local cache files (media, thumbnails, originals, attachments, blob temp files, quarantine copies) */
  cacheBytes: number;
  /** media originals the Mac recorded as kept in R2 for this device; the forget leaves them there */
  leftInR2: { objects: number; bytes: number };
}

const DEVICE_TABLES: Array<[keyof ForgetCounts, string]> = [
  ["notifications", "notifications"], ["media", "media"], ["files", "files"], ["calls", "calls"], ["usageEvents", "usage_events"],
  ["commands", "commands"], ["quarantine", "quarantine"], ["collectorState", "collector_state"], ["collectorHistory", "collector_history"],
  ["pairings", "pairings"], ["ledger", "sync_objects"],
];

const BIN_TABLES = ["notifications", "media", "files", "calls", "usage_events"];

/**
 * Fill the temp tables that say what a forget of `d` removes. Inside the caller's transaction, so the plan
 * and the deletes see the same rows.
 *   fx_msgs     messages this device delivered (its own row or a provenance row of it)
 *   fx_rm_msgs  of those, the ones no other device delivered (removed)
 *   fx_convs    conversations touched; removed = 1 when no message would be left
 *   fx_atts     attachments removed: of removed messages, and those this device alone contributed
 *   fx_blobs    blob oids this device's removed rows referenced and nothing remaining still uses
 */
function buildPlan(db: DB, d: DeviceRow): void {
  db.exec(`
    DROP TABLE IF EXISTS temp.fx_msgs; DROP TABLE IF EXISTS temp.fx_rm_msgs; DROP TABLE IF EXISTS temp.fx_convs;
    DROP TABLE IF EXISTS temp.fx_atts; DROP TABLE IF EXISTS temp.fx_blobs;
    CREATE TEMP TABLE fx_msgs(id TEXT PRIMARY KEY);
    CREATE TEMP TABLE fx_rm_msgs(id TEXT PRIMARY KEY);
    CREATE TEMP TABLE fx_convs(id TEXT PRIMARY KEY, removed INTEGER NOT NULL DEFAULT 0);
    CREATE TEMP TABLE fx_atts(id TEXT PRIMARY KEY);
    CREATE TEMP TABLE fx_blobs(oid TEXT PRIMARY KEY);`);
  const run = (sql: string) => bind(db, sql, { d: d.id, role: d.role });
  // another device's provenance of a message: a source row with a known device that is not this one
  const OTHER = "s.message_id = x.id AND s.device_id IS NOT NULL AND s.device_id <> @d";
  const FULL = "s.source_session NOT LIKE '%:notification'"; // a notification source never carries attachments

  run("INSERT OR IGNORE INTO fx_msgs SELECT id FROM messages WHERE device_id = @d");
  run("INSERT OR IGNORE INTO fx_msgs SELECT message_id FROM message_sources WHERE device_id = @d");
  run(`INSERT INTO fx_rm_msgs SELECT x.id FROM fx_msgs x WHERE NOT EXISTS (SELECT 1 FROM message_sources s WHERE ${OTHER})`);

  run("INSERT OR IGNORE INTO fx_convs(id) SELECT id FROM conversations WHERE device_id = @d");
  run("INSERT OR IGNORE INTO fx_convs(id) SELECT DISTINCT m.conversation_id FROM fx_msgs x JOIN messages m ON m.id = x.id");
  run(`UPDATE fx_convs SET removed = 1 WHERE NOT EXISTS (
         SELECT 1 FROM messages m WHERE m.conversation_id = fx_convs.id AND m.id NOT IN (SELECT id FROM fx_rm_msgs))`);

  run("INSERT OR IGNORE INTO fx_atts SELECT a.id FROM fx_rm_msgs x JOIN attachments a ON a.message_id = x.id");
  // On a kept message, an attachment is this device's alone when no other device delivered a full copy of
  // the message, or when its blob sits in this device's role bucket and no other device of that role
  // delivered the message. Attachments carry no source of their own, so this is the closest attribution.
  run(`INSERT OR IGNORE INTO fx_atts SELECT a.id FROM fx_msgs x JOIN attachments a ON a.message_id = x.id
       WHERE x.id NOT IN (SELECT id FROM fx_rm_msgs) AND (
         NOT EXISTS (SELECT 1 FROM message_sources s WHERE ${OTHER} AND ${FULL})
         OR (a.blob_oid IS NOT NULL AND EXISTS (SELECT 1 FROM blobs b WHERE b.oid = a.blob_oid AND b.role = @role)
             AND NOT EXISTS (SELECT 1 FROM message_sources s WHERE ${OTHER} AND ${FULL} AND s.source_session LIKE @role || ':%')))`);

  run("INSERT OR IGNORE INTO fx_blobs SELECT oid FROM blobs WHERE device_id = @d");
  run("INSERT OR IGNORE INTO fx_blobs SELECT oid FROM media_archive WHERE device_id = @d");
  run("INSERT OR IGNORE INTO fx_blobs SELECT blob_oid FROM media WHERE device_id = @d AND blob_oid IS NOT NULL");
  run("INSERT OR IGNORE INTO fx_blobs SELECT thumb_blob_oid FROM files WHERE device_id = @d AND thumb_blob_oid IS NOT NULL");
  run("INSERT OR IGNORE INTO fx_blobs SELECT original_blob_oid FROM files WHERE device_id = @d AND original_blob_oid IS NOT NULL");
  run("INSERT OR IGNORE INTO fx_blobs SELECT result_oid FROM commands WHERE device_id = @d AND result_oid IS NOT NULL");
  run("INSERT OR IGNORE INTO fx_blobs SELECT a.blob_oid FROM fx_atts x JOIN attachments a ON a.id = x.id WHERE a.blob_oid IS NOT NULL");
  run("INSERT OR IGNORE INTO fx_blobs SELECT c.avatar_blob_oid FROM fx_convs x JOIN conversations c ON c.id = x.id WHERE x.removed = 1 AND c.avatar_blob_oid IS NOT NULL");
  // a blob something that stays still uses is kept as it is
  run(`DELETE FROM fx_blobs WHERE
         EXISTS (SELECT 1 FROM media WHERE blob_oid = fx_blobs.oid AND device_id <> @d)
      OR EXISTS (SELECT 1 FROM files WHERE thumb_blob_oid = fx_blobs.oid AND device_id <> @d)
      OR EXISTS (SELECT 1 FROM files WHERE original_blob_oid = fx_blobs.oid AND device_id <> @d)
      OR EXISTS (SELECT 1 FROM attachments WHERE blob_oid = fx_blobs.oid AND id NOT IN (SELECT id FROM fx_atts))
      OR EXISTS (SELECT 1 FROM conversations WHERE avatar_blob_oid = fx_blobs.oid AND id NOT IN (SELECT id FROM fx_convs WHERE removed = 1))
      OR EXISTS (SELECT 1 FROM commands WHERE result_oid = fx_blobs.oid AND device_id <> @d)`);
}

function dropPlan(db: DB): void {
  db.exec(`DROP TABLE IF EXISTS temp.fx_msgs; DROP TABLE IF EXISTS temp.fx_rm_msgs; DROP TABLE IF EXISTS temp.fx_convs;
           DROP TABLE IF EXISTS temp.fx_atts; DROP TABLE IF EXISTS temp.fx_blobs;`);
}

/** Run a statement, binding only the named parameters (@d, @role, @now) it uses. */
function bind(db: DB, sql: string, params: Record<string, string>) {
  const used = Object.fromEntries(Object.entries(params).filter(([k]) => new RegExp(`@${k}\\b`).test(sql)));
  return Object.keys(used).length ? db.prepare(sql).run(used) : db.prepare(sql).run();
}

const n = (db: DB, sql: string, ...a: unknown[]): number => (db.prepare(sql).get(...a) as { n: number }).n;

/** Counts from a built plan (before anything is deleted). */
function planCounts(db: DB, id: string): { counts: ForgetCounts; shared: Footprint["shared"]; binRows: number; leftInR2: Footprint["leftInR2"] } {
  const counts = {
    messages: n(db, "SELECT COUNT(*) AS n FROM fx_rm_msgs"),
    conversations: n(db, "SELECT COUNT(*) AS n FROM fx_convs WHERE removed = 1"),
    messageSources: n(db, "SELECT COUNT(*) AS n FROM message_sources WHERE device_id = ? OR message_id IN (SELECT id FROM fx_rm_msgs)", id),
    messageEdits: n(db, "SELECT COUNT(*) AS n FROM message_edits WHERE message_id IN (SELECT id FROM fx_rm_msgs)"),
    attachments: n(db, "SELECT COUNT(*) AS n FROM fx_atts"),
    mediaArchive: n(db, "SELECT COUNT(*) AS n FROM media_archive WHERE oid IN (SELECT oid FROM fx_blobs)"),
    blobs: n(db, "SELECT COUNT(*) AS n FROM blobs WHERE oid IN (SELECT oid FROM fx_blobs)"),
  } as ForgetCounts;
  for (const [k, t] of DEVICE_TABLES) counts[k] = n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE device_id = ?`, id);
  const shared = {
    messagesKept: n(db, "SELECT COUNT(*) AS n FROM fx_msgs") - counts.messages,
    conversationsKept: n(db, "SELECT COUNT(*) AS n FROM fx_convs WHERE removed = 0"),
  };
  let binRows = n(db, "SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NOT NULL AND id IN (SELECT id FROM fx_rm_msgs)")
    + n(db, "SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NOT NULL AND id IN (SELECT id FROM fx_convs WHERE removed = 1)")
    + n(db, "SELECT COUNT(*) AS n FROM attachments WHERE deleted_at IS NOT NULL AND id IN (SELECT id FROM fx_atts)");
  for (const t of BIN_TABLES) binRows += n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE device_id = ? AND deleted_at IS NOT NULL`, id);
  const r2 = db.prepare("SELECT COUNT(*) AS objects, COALESCE(SUM(total_size), 0) AS bytes FROM media_archive WHERE oid IN (SELECT oid FROM fx_blobs)")
    .get() as { objects: number; bytes: number };
  return { counts, shared, binRows, leftInR2: { objects: r2.objects, bytes: r2.bytes } };
}

/** Local files the plan's rows point at (deduplicated). */
function planPaths(db: DB, id: string): string[] {
  const out = new Set<string>();
  const add = (sql: string, ...a: unknown[]) => {
    for (const r of db.prepare(sql).raw().all(...a) as unknown[][]) for (const v of r) if (typeof v === "string" && v) out.add(v);
  };
  add("SELECT local_path, thumb_path FROM media WHERE device_id = ?", id);
  add("SELECT local_path, thumb_path FROM files WHERE device_id = ?", id);
  add("SELECT local_path FROM attachments WHERE id IN (SELECT id FROM fx_atts)");
  add("SELECT local_path, tmp_path FROM blobs WHERE oid IN (SELECT oid FROM fx_blobs)");
  add("SELECT cached_local_path FROM media_archive WHERE oid IN (SELECT oid FROM fx_blobs)");
  add("SELECT stored_path FROM quarantine WHERE device_id = ?", id);
  return [...out];
}

function sizeOf(p: string): number {
  try { const s = statSync(p); return s.isFile() ? s.size : 0; } catch { return 0; }
}

/** What forgetting `id` would remove. Read-only (temp tables only). Undefined for an unknown device. */
export function forgetFootprint(ctx: Ctx, id: string): Footprint | undefined {
  const d = getDevice(ctx, id);
  if (!d) return undefined;
  const db = ctx.db;
  let out!: Footprint;
  db.transaction(() => {
    buildPlan(db, d);
    const c = planCounts(db, id);
    const cacheBytes = planPaths(db, id).reduce((sum, p) => sum + sizeOf(p), 0);
    out = { deviceId: d.id, role: d.role, fingerprint: d.fingerprint, confirmWith: "fingerprint", ...c, cacheBytes };
    dropPlan(db);
  })();
  return out;
}

export interface ForgetResult {
  forgotten: true;
  deviceId: string;
  removed: ForgetCounts;
  shared: Footprint["shared"];
  cancelledCommands: number;
  binPurged: number;
  binNote: string;
  cacheBytesFreed: number;
  cacheFilesRemoved: number;
  leftInR2Bytes: number;
  leftInR2Objects: number;
  r2Note: string;
  tokenWarning: string;
}

const norm = (s: string) => s.trim().toUpperCase();

/**
 * Forget a device. `confirm` must equal the device's fingerprint (as shown on the Devices page; case and
 * surrounding spaces ignored). Throws ForgetError not_found / bad_confirm. Makes no R2 call of any kind.
 */
export function forgetDevice(ctx: Ctx, id: string, confirm: unknown): ForgetResult {
  const d = getDevice(ctx, id);
  if (!d) throw new ForgetError("not_found", "no such device");
  if (typeof confirm !== "string" || norm(confirm) !== norm(d.fingerprint)) {
    throw new ForgetError("bad_confirm", "confirm must be the device's fingerprint, exactly as the Devices page shows it");
  }
  const db = ctx.db;
  const now = nowIso();
  let counts!: ReturnType<typeof planCounts>;
  let paths: string[] = [];
  let cancelled = 0;
  db.transaction(() => {
    buildPlan(db, d);
    counts = planCounts(db, id);
    paths = planPaths(db, id);
    const run = (sql: string) => bind(db, sql, { d: id, now });

    // the revoke steps. Open commands are cancelled and then removed with the rest of the device's rows; their
    // objects in the cmd-bucket are left to its 30-day lifecycle rule, since a forget makes no R2 call
    cancelled = run("UPDATE commands SET status = 'cancelled', detail = 'device forgotten', status_at = @now WHERE device_id = @d AND status IN ('queued','sent','transferring','uploaded')").changes;

    // this device's coverage claims per kept conversation (its source sessions there), read before its provenance goes
    const claims = db.prepare(`SELECT DISTINCT m.conversation_id AS conv, s.source_session AS session FROM message_sources s
                               JOIN messages m ON m.id = s.message_id WHERE s.device_id = ?`).all(id) as Array<{ conv: string; session: string }>;

    // messages: links into removed messages first, then the messages and what hangs off them
    run("UPDATE notifications SET linked_message_id = NULL, link_confidence = NULL WHERE linked_message_id IN (SELECT id FROM fx_rm_msgs)");
    run("UPDATE messages SET reply_to = NULL WHERE reply_to IN (SELECT id FROM fx_rm_msgs)");
    run("DELETE FROM attachments WHERE id IN (SELECT id FROM fx_atts)");
    run("DELETE FROM message_edits WHERE message_id IN (SELECT id FROM fx_rm_msgs)");
    run("DELETE FROM message_sources WHERE device_id = @d OR message_id IN (SELECT id FROM fx_rm_msgs)");
    run("DELETE FROM messages WHERE id IN (SELECT id FROM fx_rm_msgs)"); // FTS and embeddings follow by trigger

    // kept (shared) messages: attribute them to a remaining source, and show a remaining source's text
    run(`UPDATE messages SET device_id = (SELECT s.device_id FROM message_sources s WHERE s.message_id = messages.id AND s.device_id IS NOT NULL ORDER BY s.rid LIMIT 1)
         WHERE device_id = @d`);
    relabelText(db, id);

    // conversations: removed when no message is left; a kept one loses this device's coverage claims
    run("DELETE FROM conversations WHERE id IN (SELECT id FROM fx_convs WHERE removed = 1)");
    run(`UPDATE conversations SET device_id = (SELECT m.device_id FROM messages m WHERE m.conversation_id = conversations.id AND m.device_id IS NOT NULL LIMIT 1)
         WHERE device_id = @d`);
    dropClaims(db, claims);

    // rows keyed by the device (the bin's copies included)
    for (const [, t] of DEVICE_TABLES) db.prepare(`DELETE FROM ${t} WHERE device_id = ?`).run(id);

    // blobs: archive records go; the blob rows stay as ignored tombstones so a re-listed leftover is settled
    // without a download, and their ledger rows (manifest and parts) become ignored
    run("DELETE FROM media_archive WHERE oid IN (SELECT oid FROM fx_blobs)");
    const blobs = db.prepare("SELECT rid, bucket, oid FROM blobs WHERE oid IN (SELECT oid FROM fx_blobs)").all() as Array<{ rid: number; bucket: string; oid: string }>;
    const tomb = db.prepare(`UPDATE blobs SET status = 'ignored', device_id = ?, manifest_env = NULL, local_path = NULL, tmp_path = NULL, committed_parts = '[]',
                               committed_bytes = 0, sha256 = NULL, command_id = NULL, detail = 'device forgotten', updated_at = ? WHERE rid = ?`);
    const ledger = db.prepare(`UPDATE sync_objects SET status = 'ignored', device_id = ?, detail = 'device forgotten'
                               WHERE bucket = ? AND object_key >= ? AND object_key < ?`);
    for (const b of blobs) {
      tomb.run(id, now, b.rid);
      ledger.run(id, b.bucket, `up/blob/${b.oid}/`, `up/blob/${b.oid}0`); // '0' sorts right after '/'
    }

    db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    db.prepare(`INSERT INTO forgotten_devices(id, role, fingerprint, forgotten_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET forgotten_at = excluded.forgotten_at`).run(id, d.role, d.fingerprint, now);
    dropPlan(db);
  })();

  // FTS: no deleted tokens left in older segments (as a bin purge does)
  for (const f of ["messages_fts", "notifications_fts", "media_fts", "files_fts", "usage_events_fts", "calls_fts"]) {
    try { db.prepare(`INSERT INTO ${f}(${f}) VALUES ('optimize')`).run(); } catch { /* the index is still consistent */ }
  }
  const { bytes, files } = removeCacheFiles(ctx, paths);

  ctx.events.emit("device.revoked", { deviceId: id, role: d.role, fingerprint: d.fingerprint });
  ctx.events.emit("device.forgotten", { deviceId: id, role: d.role, fingerprint: d.fingerprint, removed: counts.counts, cacheBytesFreed: bytes });
  ctx.events.emit("coverage.changed", { deviceId: id });
  return {
    forgotten: true,
    deviceId: id,
    removed: counts.counts,
    shared: counts.shared,
    cancelledCommands: cancelled,
    binPurged: counts.binRows,
    binNote: "Rows of this device that were already in the recovery bin were purged with the rest; they cannot be restored.",
    cacheBytesFreed: bytes,
    cacheFilesRemoved: files,
    leftInR2Bytes: counts.leftInR2.bytes,
    leftInR2Objects: counts.leftInR2.objects,
    r2Note: "Nothing in R2 was changed. Objects this device left there are ignored by ingest: never committed, never deleted.",
    tokenWarning: TOKEN_WARNING,
  };
}

/**
 * A kept message whose shown text came from a source of the forgotten device (text_source no longer among
 * its sources) is labelled with a remaining source: a full source keeps the text as stored; when only
 * notification sources remain, the text becomes what the linked notification of the other device showed.
 */
function relabelText(db: DB, id: string): void {
  const rows = db.prepare(`SELECT m.id, m.text_source FROM fx_msgs x JOIN messages m ON m.id = x.id
                           WHERE m.text_source IS NULL OR NOT EXISTS (SELECT 1 FROM message_sources s WHERE s.message_id = m.id AND s.source_session = m.text_source)`)
    .all() as Array<{ id: string; text_source: string | null }>;
  const sources = db.prepare("SELECT source_session AS session FROM message_sources WHERE message_id = ? ORDER BY rid");
  const preview = db.prepare(`SELECT preview FROM notifications WHERE linked_message_id = ? AND device_id <> ? AND preview IS NOT NULL ORDER BY posted_at LIMIT 1`);
  const setSource = db.prepare("UPDATE messages SET text_source = ? WHERE id = ?");
  const setPreview = db.prepare("UPDATE messages SET text = ?, text_source = ?, text_quality = 'preview' WHERE id = ?");
  for (const r of rows) {
    const left = (sources.all(r.id) as Array<{ session: string }>).map((s) => s.session);
    if (left.length === 0) continue;
    const full = left.find((s) => !s.endsWith(":notification"));
    if (full) { setSource.run(full, r.id); continue; }
    const pv = (preview.get(r.id, id) as { preview: string } | undefined)?.preview;
    if (pv) setPreview.run(pv, left[0]!, r.id);
    else setSource.run(left[0]!, r.id);
  }
}

/** Remove the forgotten device's coverage claims from conversations that stay. */
function dropClaims(db: DB, claims: Array<{ conv: string; session: string }>): void {
  const byConv = new Map<string, Set<string>>();
  for (const c of claims) { const s = byConv.get(c.conv) ?? new Set<string>(); s.add(c.session); byConv.set(c.conv, s); }
  const get = db.prepare("SELECT coverage_by_source FROM conversations WHERE id = ?");
  const still = db.prepare("SELECT 1 FROM message_sources s JOIN messages m ON m.id = s.message_id WHERE m.conversation_id = ? AND s.source_session = ? LIMIT 1");
  const set = db.prepare("UPDATE conversations SET coverage_by_source = ?, coverage = ? WHERE id = ?");
  for (const [conv, sessions] of byConv) {
    const row = get.get(conv) as { coverage_by_source: string } | undefined;
    if (!row) continue; // removed
    const by = parseCoverageBySource(row.coverage_by_source);
    let changed = false;
    for (const s of sessions) if (s in by && !still.get(conv, s)) { delete by[s]; changed = true; }
    if (changed) set.run(stableJson(by), bestCoverage(by), conv);
  }
}

/** Remove the plan's local files that no remaining row points at. Never throws on a missing file. */
function removeCacheFiles(ctx: Ctx, paths: string[]): { bytes: number; files: number } {
  if (paths.length === 0) return { bytes: 0, files: 0 };
  const db = ctx.db;
  const used = new Set<string>();
  db.exec("DROP TABLE IF EXISTS temp.fx_paths; CREATE TEMP TABLE fx_paths(p TEXT PRIMARY KEY)");
  try {
    const ins = db.prepare("INSERT OR IGNORE INTO fx_paths(p) VALUES (?)");
    db.transaction(() => { for (const p of paths) ins.run(p); })();
    const cols: Array<[string, string]> = [
      ["media", "local_path"], ["media", "thumb_path"], ["files", "local_path"], ["files", "thumb_path"], ["attachments", "local_path"],
      ["blobs", "local_path"], ["blobs", "tmp_path"], ["media_archive", "cached_local_path"], ["conversations", "avatar_local_path"],
      ["quarantine", "stored_path"], ["line_contacts", "picture_local_path"], ["line_account_profile", "picture_local_path"],
    ];
    for (const [t, c] of cols) {
      for (const r of db.prepare(`SELECT ${c} AS p FROM ${t} WHERE ${c} IN (SELECT p FROM fx_paths)`).all() as Array<{ p: string }>) used.add(r.p);
    }
  } finally { db.exec("DROP TABLE IF EXISTS temp.fx_paths"); }
  const filesDir = dirs(ctx.config).files;
  let bytes = 0, files = 0;
  for (const p of paths) {
    if (used.has(p)) continue;
    const size = sizeOf(p);
    if (removeQuietly(p)) { bytes += size; files++; }
    // originals live in files/<oid>/<name>: remove the now-empty folder too
    try {
      const parent = dirname(p);
      if (dirname(parent) === filesDir && existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
  return { bytes, files };
}

/** True when `deviceId` was forgotten: ingest leaves its objects alone. */
export function isForgotten(db: DB, deviceId: string | null | undefined): boolean {
  return !!deviceId && !!db.prepare("SELECT 1 FROM forgotten_devices WHERE id = ?").get(deviceId);
}
