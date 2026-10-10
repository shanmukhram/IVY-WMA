/**
 * One committer per record kind. Each runs INSIDE the ingest transaction for
 * its object (together with the ledger row), so a record is either fully in the
 * vault or not at all. Committers are idempotent on their own natural keys as
 * well, so a duplicate record that arrives under a different object key does
 * not create a second row.
 *
 * They return blob oids the record references; the ingester links those after
 * the commit (file moves happen outside the transaction).
 */
import { randomUUID, createHash } from "node:crypto";
import type {
  AndroidNotificationRecordT, CallRecordT, CommandStatusRecordT, DeviceReportRecordT, FileMetaRecordT,
  MessageBatchRecordT, ScreenshotRecordT, UsageEventRecordT, WindowsNotificationRecordT,
} from "@ivy/protocol";
import type { DB } from "../db/index.ts";
import { normTs, nowIso } from "../util/time.ts";
import { extOf, baseName } from "../util/ext.ts";

export interface CommitResult {
  summary: Record<string, unknown>;
  /** blob oids to link once committed */
  blobs?: string[];
  /** command keys to delete from the cmd-bucket after commit (PLAN decision 4) */
  deleteCommands?: Array<{ commandId: string; objectKey: string; deviceId: string }>;
  coverageChanged?: boolean;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- files

export function commitFileMeta(db: DB, r: FileMetaRecordT): CommitResult {
  const now = nowIso();
  const ev = normTs(r.eventTime)!;
  const existing = db.prepare("SELECT id, event_time FROM files WHERE device_id = ? AND path = ?").get(r.deviceId, r.path) as { id: string; event_time: string } | undefined;
  // out-of-order protection: an older observation never overwrites a newer one
  if (existing && existing.event_time > ev) return { summary: { fileId: existing.id, applied: false, reason: "older than stored state" } };
  const name = r.name || baseName(r.path);
  const ext = r.ext ? r.ext.replace(/^\./, "").toLowerCase() : extOf(r.path) ?? null;
  if (r.deleted) {
    if (existing) {
      db.prepare(`UPDATE files SET source_status = 'deleted_at_source', source_deleted_at = ?, event_time = ?, captured_at = ?, updated_at = ? WHERE id = ?`)
        .run(ev, ev, normTs(r.captureTime), now, existing.id);
      return { summary: { fileId: existing.id, deletedAtSource: true } };
    }
    // a deletion of a file we never saw is still kept as a record of it (never dropped)
    const id = randomUUID();
    db.prepare(`INSERT INTO files(id, device_id, path, name, ext, size, mtime, quick_hash, source_status, source_deleted_at, event_time, captured_at, first_seen_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deleted_at_source', ?, ?, ?, ?, ?)`)
      .run(id, r.deviceId, r.path, name, ext, r.size ?? null, normTs(r.mtime), r.quickHash ?? null, ev, ev, normTs(r.captureTime), now, now);
    return { summary: { fileId: id, deletedAtSource: true } };
  }
  const thumb = r.thumbBlobOid ?? null;
  // PLAN decision 8: an original the device uploaded on its own (payloadKind photo / document). The blob may
  // land before or after this record; placeAndLink (called for every returned oid) marks the file cached.
  const original = r.originalBlobOid ?? null;
  let id: string;
  if (existing) {
    id = existing.id;
    db.prepare(`UPDATE files SET name = ?, ext = ?, size = ?, mtime = ?, quick_hash = ?, source_status = 'live', source_deleted_at = NULL,
                  thumb_blob_oid = COALESCE(?, thumb_blob_oid), event_time = ?, captured_at = ?, updated_at = ?,
                  original_blob_oid = CASE WHEN quick_hash IS NOT ? THEN ? ELSE COALESCE(?, original_blob_oid) END,
                  extract_status = CASE WHEN ? IS NOT NULL AND original_blob_oid IS NOT ? THEN NULL ELSE extract_status END,
                  status = CASE WHEN quick_hash IS NOT ? OR (? IS NOT NULL AND original_blob_oid IS NOT ?) THEN 'reference' ELSE status END
                WHERE id = ?`)
      // a changed file keeps its older local copy (local_path) but is no longer "cached": the copy is stale.
      // A new original (other content) also waits for its blob before the file is "cached" again.
      .run(name, ext, r.size, normTs(r.mtime), r.quickHash, thumb, ev, normTs(r.captureTime), now,
        r.quickHash, original, original, original, original, r.quickHash, original, original, id);
  } else {
    id = randomUUID();
    db.prepare(`INSERT INTO files(id, device_id, path, name, ext, size, mtime, quick_hash, thumb_blob_oid, original_blob_oid, event_time, captured_at, first_seen_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, r.deviceId, r.path, name, ext, r.size, normTs(r.mtime), r.quickHash, thumb, original, ev, normTs(r.captureTime), now, now);
  }
  return { summary: { fileId: id, ...(original ? { originalBlobOid: original } : {}) }, blobs: [thumb, original].filter((x): x is string => !!x) };
}

// ---------------------------------------------------------------- media

export function commitScreenshot(db: DB, r: ScreenshotRecordT): CommitResult {
  const existing = db.prepare("SELECT id FROM media WHERE blob_oid = ?").get(r.blobOid) as { id: string } | undefined;
  if (existing) return { summary: { mediaId: existing.id, duplicate: true }, blobs: [r.blobOid] };
  const id = randomUUID();
  db.prepare(`INSERT INTO media(id, device_id, kind, source_path, sha256, width, height, blob_oid, taken_at, saved_at, captured_at, imported_at)
              VALUES (?, ?, 'screenshot', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, r.deviceId, r.sourcePath, r.sha256, r.width ?? null, r.height ?? null, r.blobOid,
      normTs(r.takenAt), normTs(r.savedAt), normTs(r.captureTime), nowIso());
  db.prepare("UPDATE blobs SET device_id = ? WHERE oid = ? AND device_id IS NULL").run(r.deviceId, r.blobOid);
  return { summary: { mediaId: id, blobOid: r.blobOid }, blobs: [r.blobOid] };
}

// ---------------------------------------------------------------- usage

export function commitUsage(db: DB, r: UsageEventRecordT): CommitResult {
  const titleState = r.title === undefined ? "not_captured" : r.title === null ? "excluded" : "captured";
  const started = normTs(r.startedAt)!;
  const ended = normTs(r.endedAt)!;
  const ex = db.prepare("SELECT id, ended_at FROM usage_events WHERE device_id = ? AND app = ? AND started_at = ?").get(r.deviceId, r.app, started) as { id: string; ended_at: string } | undefined;
  if (ex) {
    // the same session reported again (extended): keep the latest end and title
    db.prepare(`UPDATE usage_events SET ended_at = MAX(ended_at, ?), title = COALESCE(?, title),
                  title_state = CASE WHEN ? = 'captured' THEN 'captured' ELSE title_state END, exe = COALESCE(?, exe) WHERE id = ?`)
      .run(ended, r.title ?? null, titleState, r.exe ?? null, ex.id);
    return { summary: { usageId: ex.id, extended: true } };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO usage_events(id, device_id, app, exe, title, title_state, started_at, ended_at, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, r.deviceId, r.app, r.exe ?? null, r.title ?? null, titleState, started, ended, normTs(r.captureTime));
  return { summary: { usageId: id, app: r.app } };
}

// ---------------------------------------------------------------- notifications

function insertNotification(db: DB, n: {
  deviceId: string; source: "windows" | "android"; app: string; title: string | null; sender: string | null; preview: string | null;
  notifKey: string | null; postedAt: string; capturedAt: string;
}): CommitResult {
  const dedupe = sha([n.deviceId, n.app, n.postedAt, n.notifKey ?? "", n.title ?? "", n.preview ?? ""].join("\u0000"));
  const ex = db.prepare("SELECT id FROM notifications WHERE dedupe_key = ?").get(dedupe) as { id: string } | undefined;
  if (ex) return { summary: { notificationId: ex.id, duplicate: true } };
  const id = randomUUID();
  db.prepare(`INSERT INTO notifications(id, device_id, source, app, title, sender, preview, notif_key, posted_at, captured_at, ingested_at, dedupe_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, n.deviceId, n.source, n.app, n.title, n.sender, n.preview, n.notifKey, n.postedAt, n.capturedAt, nowIso(), dedupe);
  return { summary: { notificationId: id, app: n.app } };
}

export function commitWindowsNotification(db: DB, r: WindowsNotificationRecordT): CommitResult {
  return insertNotification(db, {
    deviceId: r.deviceId, source: "windows", app: r.app, title: r.title, sender: r.sender ?? null, preview: r.text,
    notifKey: null, postedAt: normTs(r.postedAt)!, capturedAt: normTs(r.captureTime)!,
  });
}

export function commitAndroidNotification(db: DB, r: AndroidNotificationRecordT): CommitResult {
  return insertNotification(db, {
    deviceId: r.deviceId, source: "android", app: r.app, title: r.title, sender: r.sender ?? null, preview: r.preview,
    notifKey: r.notifKey ?? null, postedAt: normTs(r.postedAt)!, capturedAt: normTs(r.captureTime)!,
  });
}

// ---------------------------------------------------------------- calls

export function commitCall(db: DB, r: CallRecordT): CommitResult {
  const started = normTs(r.startedAt)!;
  const ex = db.prepare("SELECT id FROM calls WHERE device_id = ? AND number = ? AND started_at = ? AND direction = ?").get(r.deviceId, r.number, started, r.direction) as { id: string } | undefined;
  if (ex) {
    db.prepare("UPDATE calls SET duration_s = MAX(duration_s, ?), contact = COALESCE(?, contact) WHERE id = ?").run(r.durationS, r.contact ?? null, ex.id);
    return { summary: { callId: ex.id, duplicate: true } };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO calls(id, device_id, direction, contact, number, started_at, duration_s, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, r.deviceId, r.direction, r.contact ?? null, r.number, started, r.durationS, normTs(r.captureTime));
  return { summary: { callId: id } };
}

// ---------------------------------------------------------------- conversations

export function commitMessageBatch(db: DB, r: MessageBatchRecordT): CommitResult {
  const now = nowIso();
  let conv = db.prepare("SELECT id FROM conversations WHERE platform = ? AND account = ? AND conv_key = ?").get(r.platform, r.account, r.convKey) as { id: string } | undefined;
  if (conv) {
    db.prepare(`UPDATE conversations SET peer = COALESCE(?, peer), kind = ?, coverage = ?, cursor = ?, device_id = COALESCE(device_id, ?), updated_at = ? WHERE id = ?`)
      .run(r.peer ?? null, r.convKind, r.coverage, r.cursor, r.deviceId, now, conv.id);
  } else {
    conv = { id: randomUUID() };
    db.prepare(`INSERT INTO conversations(id, device_id, platform, account, conv_key, peer, kind, coverage, cursor, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(conv.id, r.deviceId, r.platform, r.account, r.convKey, r.peer ?? null, r.convKind, r.coverage, r.cursor, now, now);
  }
  const captured = normTs(r.captureTime)!;
  const blobs: string[] = [];
  let inserted = 0, edited = 0;
  const getMsg = db.prepare("SELECT id, text, edited_at FROM messages WHERE conversation_id = ? AND msg_key = ?");
  for (const m of r.messages) {
    const ex = getMsg.get(conv.id, m.msgId) as { id: string; text: string; edited_at: string | null } | undefined;
    const replyId = m.replyTo
      ? ((db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND msg_key = ?").get(conv.id, m.replyTo) as { id: string } | undefined)?.id ?? null)
      : null;
    let msgId: string;
    if (ex) {
      msgId = ex.id;
      if (ex.text !== m.text) {
        // C3: an observable edit updates the record and keeps the prior text; no duplicate row
        db.prepare("INSERT INTO message_edits(message_id, text, edited_at, recorded_at) VALUES (?, ?, ?, ?)").run(ex.id, ex.text, ex.edited_at, now);
        edited++;
      }
      db.prepare(`UPDATE messages SET text = ?, edited_at = COALESCE(?, edited_at), source_status = ?, sender = ?,
                    reply_to = COALESCE(?, reply_to), reply_to_key = COALESCE(?, reply_to_key) WHERE id = ?`)
        .run(m.text, normTs(m.editedAt), m.sourceStatus, m.sender, replyId, m.replyTo ?? null, ex.id);
    } else {
      msgId = randomUUID();
      db.prepare(`INSERT INTO messages(id, conversation_id, device_id, msg_key, sender, sent_at, captured_at, text, reply_to, reply_to_key, edited_at, source_status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(msgId, conv.id, r.deviceId, m.msgId, m.sender, normTs(m.sentAt), captured, m.text, replyId, m.replyTo ?? null, normTs(m.editedAt), m.sourceStatus);
      // resolve earlier replies that pointed at this message before it arrived
      db.prepare("UPDATE messages SET reply_to = ? WHERE conversation_id = ? AND reply_to_key = ? AND reply_to IS NULL").run(msgId, conv.id, m.msgId);
      inserted++;
    }
    for (const a of m.attachments ?? []) {
      db.prepare(`INSERT INTO attachments(id, message_id, att_key, kind, filename, size, origin_hash, blob_oid, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(message_id, att_key) DO UPDATE SET filename = excluded.filename, size = excluded.size,
                    origin_hash = COALESCE(excluded.origin_hash, origin_hash), blob_oid = COALESCE(excluded.blob_oid, blob_oid)`)
        .run(randomUUID(), msgId, a.attId, a.kind, a.filename, a.size, a.originHash ?? null, a.blobOid ?? null, a.blobOid ? "indexed" : "on_demand");
      if (a.blobOid) blobs.push(a.blobOid);
    }
  }
  return { summary: { conversationId: conv.id, platform: r.platform, inserted, edited }, blobs };
}

// ---------------------------------------------------------------- device report

export function commitDeviceReport(db: DB, r: DeviceReportRecordT): CommitResult {
  const reported = normTs(r.reportedAt)!;
  const dev = db.prepare("SELECT last_report_at FROM devices WHERE id = ?").get(r.deviceId) as { last_report_at: string | null } | undefined;
  const newest = !dev?.last_report_at || dev.last_report_at <= reported;
  if (newest) {
    db.prepare("UPDATE devices SET last_report_at = ?, app_version = COALESCE(?, app_version), queue_depth_total = ? WHERE id = ?")
      .run(reported, r.appVersion ?? null, r.queueDepthTotal, r.deviceId);
  }
  const getState = db.prepare("SELECT reported_at, last_run_at, enabled FROM collector_state WHERE device_id = ? AND name = ?");
  const lastHist = db.prepare("SELECT last_run_at, enabled FROM collector_history WHERE device_id = ? AND name = ? ORDER BY reported_at DESC, rid DESC LIMIT 1");
  for (const c of r.collectors) {
    const lastRun = normTs(c.lastRunAt);
    const prev = getState.get(r.deviceId, c.name) as { reported_at: string } | undefined;
    if (!prev) {
      db.prepare(`INSERT INTO collector_state(device_id, name, enabled, last_run_at, cursor, queue_depth, reported_at, first_reported_at, import_total, import_done, phase)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.deviceId, c.name, c.enabled ? 1 : 0, lastRun, c.cursor ?? null, c.queueDepth, reported, reported, c.importTotal ?? null, c.importDone ?? null, c.phase ?? null);
    } else if (prev.reported_at <= reported) {
      // import progress is a snapshot: what the newest report says (absent = not reported)
      db.prepare(`UPDATE collector_state SET enabled = ?, last_run_at = COALESCE(?, last_run_at), cursor = COALESCE(?, cursor), queue_depth = ?, reported_at = ?,
                    import_total = ?, import_done = ?, phase = ? WHERE device_id = ? AND name = ?`)
        .run(c.enabled ? 1 : 0, lastRun, c.cursor ?? null, c.queueDepth, reported, c.importTotal ?? null, c.importDone ?? null, c.phase ?? null, r.deviceId, c.name);
    }
    // history only when something that matters for gaps changed
    const h = lastHist.get(r.deviceId, c.name) as { last_run_at: string | null; enabled: number } | undefined;
    if (!h || h.last_run_at !== lastRun || h.enabled !== (c.enabled ? 1 : 0)) {
      db.prepare("INSERT INTO collector_history(device_id, name, reported_at, last_run_at, enabled, queue_depth) VALUES (?, ?, ?, ?, ?, ?)")
        .run(r.deviceId, c.name, reported, lastRun, c.enabled ? 1 : 0, c.queueDepth);
    }
  }
  return { summary: { collectors: r.collectors.length, queueDepthTotal: r.queueDepthTotal, reportedAt: reported }, coverageChanged: true };
}

// ---------------------------------------------------------------- command status

const TERMINAL = new Set(["done", "not_found", "access_denied", "too_large", "error", "cancelled", "expired"]);

export function commitCommandStatus(db: DB, r: CommandStatusRecordT): CommitResult {
  const c = db.prepare("SELECT id, device_id, object_key, type, status, cmd_deleted FROM commands WHERE id = ?").get(r.commandId) as
    { id: string; device_id: string; object_key: string; type: string; status: string; cmd_deleted: number } | undefined;
  if (!c) return { summary: { commandId: r.commandId, status: r.status, unknownCommand: true } };
  if (c.device_id !== r.deviceId) return { summary: { commandId: r.commandId, status: r.status, ignored: "status from a different device" } };
  const at = normTs(r.reportedAt);
  // a later "uploaded" never downgrades a command that already completed locally
  if (!(TERMINAL.has(c.status) && r.status === "uploaded")) {
    db.prepare(`UPDATE commands SET status = ?, detail = ?, result_oid = COALESCE(?, result_oid), status_at = ?,
                  completed_at = CASE WHEN ? IN ('done','not_found','access_denied','too_large','error') THEN ? ELSE completed_at END WHERE id = ?`)
      .run(r.status, r.detail ?? null, r.resultOid ?? null, at, r.status, at, c.id);
  }
  return {
    summary: { commandId: c.id, status: r.status, resultOid: r.resultOid ?? null },
    blobs: r.resultOid ? [r.resultOid] : [],
    deleteCommands: c.cmd_deleted ? [] : [{ commandId: c.id, objectKey: c.object_key, deviceId: c.device_id }],
  };
}
