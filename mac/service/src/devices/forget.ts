/**
 * Forget a device (Devices page, "Forget this device"): remove one of the owner's own old devices and
 * everything it contributed from the Mac's archive, so the vault holds only what the remaining devices
 * captured. It is a local operation on data/vault.db and the local cache, with one exception: before anything
 * is removed, the device is told to reset by an `unpair` command written to its cmd-bucket (when R2 is
 * reachable). That command is the only R2 write; the up-buckets are never read, listed or changed by a forget,
 * and the command object is deleted later, when the device's command_status for it arrives.
 *
 * What goes:
 * - the revoke steps (the device's key, its collector state, its open commands; the unpair command row stays, so
 *   the device's answer to it can still be matched);
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
 *
 * Devices no longer paired ("orphaned" ids): records can outlive their device row, for example after an
 * earlier revoke (which keeps the archive) or a pairing that was replaced. Such an id has rows in a
 * device-keyed table but no `devices` row and no `forgotten_devices` row. GET /api/devices lists them
 * (listOrphaned), and the footprint and the forget work for them too. A forget of an orphaned id skips the
 * steps that need a live device (no unpair command, so no R2 write at all) and is confirmed with the
 * fingerprint when one is on record (revoked_devices), otherwise with the first 8 characters of the id.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Ctx } from "../context.ts";
import type { DB } from "../db/index.ts";
import { dirs } from "../config.ts";
import { getDevice, TOKEN_WARNING, type DeviceRow } from "../pairing/pairing.ts";
import { sendUnpair, type UnpairOutcome } from "../commands/commands.ts";
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
  /** "windows" | "android", or "unknown" for an orphaned id whose role is on no record */
  role: string;
  /** null for an orphaned id whose fingerprint is on no record */
  fingerprint: string | null;
  name: string | null;
  /** false for an orphaned id (records left by a device that is no longer paired) */
  paired: boolean;
  /** what DELETE /api/devices/:id?wipe=1 must carry as `confirm`: the fingerprint, or the first 8 characters of the id */
  confirmWith: "fingerprint" | "shortId";
  counts: ForgetCounts;
  /** records another device also has: they stay, losing only this device's provenance */
  shared: { messagesKept: number; conversationsKept: number };
  /** of counts.files, the catalogue-only entries (a path and size, no content on the Mac) */
  catalogFiles: number;
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

/** Extra condition per device table: the unpair command sent by this forget (or an earlier revoke) is kept. */
const KEEP: Partial<Record<string, string>> = { commands: " AND type <> 'unpair'" };

const BIN_TABLES = ["notifications", "media", "files", "calls", "usage_events"];

/** Every table with a device_id column (each has an index led by device_id). Scanned for orphaned ids. */
export const DEVICE_ID_TABLES = [
  "messages", "message_sources", "conversations", "notifications", "media", "files", "calls", "usage_events", "commands",
  "quarantine", "collector_state", "collector_history", "pairings", "sync_objects", "media_archive", "blobs",
];

/** What a footprint or a forget acts on: a paired device, or an orphaned id. */
interface Target {
  id: string;
  role: string;
  fingerprint: string | null;
  name: string | null;
  /** the devices row, when the device is paired */
  device: DeviceRow | null;
}

const UNKNOWN_ROLE = "unknown";
const SHORT_ID_LEN = 8;
export const NOT_PAIRED_REASON = "Device was not paired, so it was not told to reset.";

/** True when any device-keyed table has a row for `id`. Indexed lookups only. */
function hasRows(db: DB, id: string): boolean {
  return DEVICE_ID_TABLES.some((t) => !!db.prepare(`SELECT 1 FROM ${t} WHERE device_id = ? LIMIT 1`).get(id));
}

/** Role, fingerprint and name of an id with no devices row, from what the Mac still has on record. */
function orphanTarget(db: DB, id: string): Target {
  const rev = db.prepare("SELECT role, fingerprint, name FROM revoked_devices WHERE id = ?").get(id) as { role: string; fingerprint: string; name: string | null } | undefined;
  const pairingRole = (db.prepare("SELECT role FROM pairings WHERE device_id = ? ORDER BY consumed_at DESC LIMIT 1").get(id) as { role: string } | undefined)?.role;
  // a blob or quarantine row records the role of the bucket its object came from
  const bucketRole = (db.prepare("SELECT role FROM blobs WHERE device_id = ? AND role IS NOT NULL LIMIT 1").get(id) as { role: string } | undefined)?.role
    ?? (db.prepare("SELECT role FROM quarantine WHERE device_id = ? LIMIT 1").get(id) as { role: string } | undefined)?.role;
  return {
    id,
    role: rev?.role ?? pairingRole ?? bucketRole ?? UNKNOWN_ROLE,
    fingerprint: rev?.fingerprint || null,
    name: rev?.name ?? null,
    device: null,
  };
}

/** A paired device, an orphaned id, or undefined (an id in no table, or one already forgotten). */
function resolveTarget(ctx: Ctx, id: string): Target | undefined {
  const d = getDevice(ctx, id);
  if (d) return { id: d.id, role: d.role, fingerprint: d.fingerprint, name: d.name, device: d };
  if (isForgotten(ctx.db, id) || !hasRows(ctx.db, id)) return undefined;
  return orphanTarget(ctx.db, id);
}

/** What the owner types to confirm a forget of `t`. */
function confirmValue(t: Target): { kind: Footprint["confirmWith"]; value: string } {
  return t.fingerprint ? { kind: "fingerprint", value: t.fingerprint } : { kind: "shortId", value: t.id.slice(0, SHORT_ID_LEN) };
}

/** The distinct non-null device ids in `table`, by stepping through its device_id index (one lookup per id). */
function distinctIds(db: DB, table: string): string[] {
  return (db.prepare(`WITH RECURSIVE r(d) AS (
      SELECT MIN(device_id) FROM ${table}
      UNION ALL SELECT (SELECT MIN(device_id) FROM ${table} WHERE device_id > r.d) FROM r WHERE r.d IS NOT NULL)
    SELECT d FROM r WHERE d IS NOT NULL`).all() as Array<{ d: string }>).map((r) => r.d);
}

export interface OrphanedDevice {
  id: string;
  role: string;
  fingerprint: string | null;
  name: string | null;
  /** when the Mac last ingested an object from this id (else when it paired), or null */
  lastSeen: string | null;
  confirmWith: Footprint["confirmWith"];
  counts: ForgetCounts;
  catalogFiles: number;
  cacheBytes: number;
  leftInR2: Footprint["leftInR2"];
}

/**
 * Device ids that still have records on the Mac but no devices row and no forgotten_devices row. Found by
 * walking the device_id index of every device-keyed table (a handful of ids in all), then counted with the
 * forget footprint. An id whose only rows are ones a forget keeps (its unpair command) is left out.
 */
export function listOrphaned(ctx: Ctx): OrphanedDevice[] {
  const db = ctx.db;
  const ids = new Set<string>();
  for (const t of DEVICE_ID_TABLES) for (const id of distinctIds(db, t)) ids.add(id);
  const known = db.prepare("SELECT 1 FROM devices WHERE id = ? UNION ALL SELECT 1 FROM forgotten_devices WHERE id = ?");
  const out: OrphanedDevice[] = [];
  for (const id of [...ids].sort()) {
    if (known.get(id, id)) continue;
    const f = footprintOf(ctx, orphanTarget(db, id));
    if (Object.values(f.counts).every((v) => v === 0)) continue;
    const seen = db.prepare("SELECT MAX(ingested_at) AS at FROM sync_objects WHERE device_id = ?").get(id) as { at: string | null };
    const paired = db.prepare("SELECT MAX(consumed_at) AS at FROM pairings WHERE device_id = ?").get(id) as { at: string | null };
    out.push({
      id, role: f.role, fingerprint: f.fingerprint, name: f.name, lastSeen: seen.at ?? paired.at ?? null,
      confirmWith: f.confirmWith, counts: f.counts, catalogFiles: f.catalogFiles, cacheBytes: f.cacheBytes, leftInR2: f.leftInR2,
    });
  }
  return out;
}

/**
 * Fill the temp tables that say what a forget of `d` removes. Inside the caller's transaction, so the plan
 * and the deletes see the same rows.
 *   fx_msgs     messages this device delivered (its own row or a provenance row of it)
 *   fx_rm_msgs  of those, the ones no other device delivered (removed)
 *   fx_convs    conversations touched; removed = 1 when no message would be left
 *   fx_atts     attachments removed: of removed messages, and those this device alone contributed
 *   fx_blobs    blob oids this device's removed rows referenced and nothing remaining still uses
 */
function buildPlan(db: DB, d: { id: string; role: string }): void {
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
  for (const [k, t] of DEVICE_TABLES) counts[k] = n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE device_id = ?${KEEP[t] ?? ""}`, id);
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
  // only rows with a local file: a catalogue-only file entry has none, and a device may have a million of them
  add("SELECT local_path, thumb_path FROM media WHERE device_id = ? AND (local_path IS NOT NULL OR thumb_path IS NOT NULL)", id);
  add("SELECT local_path, thumb_path FROM files WHERE device_id = ? AND (local_path IS NOT NULL OR thumb_path IS NOT NULL)", id);
  add("SELECT local_path FROM attachments WHERE id IN (SELECT id FROM fx_atts)");
  add("SELECT local_path, tmp_path FROM blobs WHERE oid IN (SELECT oid FROM fx_blobs)");
  add("SELECT cached_local_path FROM media_archive WHERE oid IN (SELECT oid FROM fx_blobs)");
  add("SELECT stored_path FROM quarantine WHERE device_id = ?", id);
  return [...out];
}

function sizeOf(p: string): number {
  try { const s = statSync(p); return s.isFile() ? s.size : 0; } catch { return 0; }
}

/**
 * What forgetting `id` would remove. Read-only (temp tables only). Works for a paired device and for an
 * orphaned id; undefined for an id that appears nowhere (or was already forgotten).
 */
export function forgetFootprint(ctx: Ctx, id: string): Footprint | undefined {
  const t = resolveTarget(ctx, id);
  return t && footprintOf(ctx, t);
}

function footprintOf(ctx: Ctx, t: Target): Footprint {
  const db = ctx.db;
  let out!: Footprint;
  db.transaction(() => {
    buildPlan(db, t);
    const c = planCounts(db, t.id);
    const cacheBytes = planPaths(db, t.id).reduce((sum, p) => sum + sizeOf(p), 0);
    const catalogFiles = n(db, "SELECT COUNT(*) AS n FROM files WHERE device_id = ? AND catalog = 1", t.id);
    out = { deviceId: t.id, role: t.role, fingerprint: t.fingerprint, name: t.name, paired: !!t.device, confirmWith: confirmValue(t).kind, ...c, catalogFiles, cacheBytes };
    dropPlan(db);
  })();
  return out;
}

export interface ForgetResult extends UnpairOutcome {
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
 * surrounding spaces ignored), or, for an orphaned id with no fingerprint on record, the first 8 characters of
 * the id. Throws ForgetError not_found / bad_confirm. Its only R2 call is the unpair command (sendUnpair) to a
 * paired device; when R2 cannot be reached the forget goes ahead and the result says the device was not told.
 * An orphaned id gets no unpair command (nothing is written to R2) and unpairReason says it was not paired.
 */
export async function forgetDevice(ctx: Ctx, id: string, confirm: unknown): Promise<ForgetResult> {
  const t = resolveTarget(ctx, id);
  if (!t) throw new ForgetError("not_found", "no such device");
  const want = confirmValue(t);
  if (typeof confirm !== "string" || norm(confirm) !== norm(want.value)) {
    throw new ForgetError("bad_confirm", want.kind === "fingerprint"
      ? "confirm must be the device's fingerprint, exactly as the Devices page shows it"
      : `confirm must be the first ${SHORT_ID_LEN} characters of the device id`);
  }
  const d = t.device;
  const unpair: UnpairOutcome = d ? await sendUnpair(ctx, d)
    : { unpairSent: false, unpairCommandId: null, unpairSentAt: null, unpairReason: NOT_PAIRED_REASON };
  const db = ctx.db;
  const now = nowIso();
  let counts!: ReturnType<typeof planCounts>;
  let paths: string[] = [];
  let cancelled = 0;
  db.transaction(() => {
    buildPlan(db, t);
    counts = planCounts(db, id);
    paths = planPaths(db, id);
    const run = (sql: string) => bind(db, sql, { d: id, now });

    // the revoke steps. Open commands are cancelled and then removed with the rest of the device's rows; their
    // objects in the cmd-bucket are left to its 30-day lifecycle rule. The unpair command is neither cancelled
    // nor removed: the device's answer to it is still expected
    cancelled = run("UPDATE commands SET status = 'cancelled', detail = 'device forgotten', status_at = @now WHERE device_id = @d AND type <> 'unpair' AND status IN ('queued','sent','transferring','uploaded')").changes;

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
    for (const [, t] of DEVICE_TABLES) db.prepare(`DELETE FROM ${t} WHERE device_id = ?${KEEP[t] ?? ""}`).run(id);

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
    db.prepare(`INSERT INTO forgotten_devices(id, role, fingerprint, forgotten_at, name, unpair_command_id, unpair_sent_at, unpair_detail, unpair_confirmed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(id) DO UPDATE SET forgotten_at = excluded.forgotten_at, name = excluded.name, unpair_command_id = excluded.unpair_command_id,
                  unpair_sent_at = excluded.unpair_sent_at, unpair_detail = excluded.unpair_detail, unpair_confirmed_at = NULL`)
      .run(id, t.role, t.fingerprint ?? "", now, t.name, unpair.unpairCommandId, unpair.unpairSentAt, unpair.unpairReason);
    dropPlan(db);
  })();

  // FTS: no deleted tokens left in older segments (as a bin purge does)
  for (const f of ["messages_fts", "notifications_fts", "media_fts", "files_fts", "usage_events_fts", "calls_fts"]) {
    try { db.prepare(`INSERT INTO ${f}(${f}) VALUES ('optimize')`).run(); } catch { /* the index is still consistent */ }
  }
  const { bytes, files } = removeCacheFiles(ctx, paths);

  if (d) ctx.events.emit("device.revoked", { deviceId: id, role: d.role, fingerprint: d.fingerprint, unpairSent: unpair.unpairSent });
  ctx.events.emit("device.forgotten", { deviceId: id, role: t.role, fingerprint: t.fingerprint, paired: !!d, removed: counts.counts, cacheBytesFreed: bytes });
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
    r2Note: "Nothing this device uploaded to R2 was changed. Objects it left there are ignored by ingest: never committed, never deleted.",
    tokenWarning: TOKEN_WARNING,
    ...unpair,
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
