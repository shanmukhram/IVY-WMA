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
  AndroidNotificationRecordT, CallRecordT, CommandStatusRecordT, DeviceReportRecordT, FileCatalogRecordT, FileMetaRecordT,
  LineAccountRecordT, MessageBatchRecordT, ScreenshotRecordT, UsageEventRecordT, WindowsNotificationRecordT,
} from "@ivy/protocol";
import type { DB } from "../db/index.ts";
import { msOf, normTs, nowIso } from "../util/time.ts";
import { bestCoverage, effectiveClaim, isNotificationSource, parseCoverageBySource, stableJson, type Coverage } from "../query/sources.ts";
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
  const existing = db.prepare("SELECT id, event_time, status, catalog, local_path FROM files WHERE device_id = ? AND path = ?").get(r.deviceId, r.path) as
    { id: string; event_time: string; status: string; catalog: number; local_path: string | null } | undefined;
  // out-of-order protection: an older observation never overwrites a newer one
  if (existing && existing.event_time > ev) return { summary: { fileId: existing.id, applied: false, reason: "older than stored state" } };
  const name = r.name || baseName(r.path);
  const ext = r.ext ? r.ext.replace(/^\./, "").toLowerCase() : extOf(r.path) ?? null;
  if (r.deleted) {
    if (existing) {
      // a browse-only catalog entry (never fetched) has no collected content to keep: a deletion
      // removes the row outright, and the files_fts trigger drops its index entries. A fetched file
      // (status 'cached') or an indexed file is marked deleted at source, keeping its local copy.
      if ((r.catalogOnly || existing.catalog) && existing.status === "catalog") {
        db.prepare("DELETE FROM files WHERE id = ?").run(existing.id);
        return { summary: { fileId: existing.id, catalogDeleted: true } };
      }
      db.prepare(`UPDATE files SET source_status = 'deleted_at_source', source_deleted_at = ?, event_time = ?, captured_at = ?, updated_at = ? WHERE id = ?`)
        .run(ev, ev, normTs(r.captureTime), now, existing.id);
      return { summary: { fileId: existing.id, deletedAtSource: true } };
    }
    // a catalog deletion of a file we never saw has nothing to record (browse-only metadata); other
    // deletions are kept as a record of the file (never dropped)
    if (r.catalogOnly) return { summary: { applied: false, reason: "catalog deletion of unknown file" } };
    const id = randomUUID();
    db.prepare(`INSERT INTO files(id, device_id, path, name, ext, size, mtime, quick_hash, source_status, source_deleted_at, event_time, captured_at, first_seen_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deleted_at_source', ?, ?, ?, ?, ?)`)
      .run(id, r.deviceId, r.path, name, ext, r.size ?? null, normTs(r.mtime), r.quickHash ?? null, ev, ev, normTs(r.captureTime), now, now);
    return { summary: { fileId: id, deletedAtSource: true } };
  }
  // a catalog entry is metadata only: no quick hash, no thumbnail, no original. It is stored with
  // status 'catalog' (browse-only) and catalog = 1, kept out of the normal views until it is fetched.
  // A fetched copy (status 'cached') is never downgraded back to a catalog entry.
  if (r.catalogOnly) {
    let id: string;
    if (existing) {
      id = existing.id;
      db.prepare(`UPDATE files SET name = ?, ext = ?, size = ?, mtime = ?, source_status = 'live', source_deleted_at = NULL,
                    event_time = ?, captured_at = ?, updated_at = ?,
                    status = CASE WHEN status = 'cached' THEN 'cached' ELSE 'catalog' END,
                    catalog = CASE WHEN status = 'cached' THEN catalog ELSE 1 END
                  WHERE id = ?`)
        .run(name, ext, r.size ?? null, normTs(r.mtime), ev, normTs(r.captureTime), now, id);
    } else {
      id = randomUUID();
      db.prepare(`INSERT INTO files(id, device_id, path, name, ext, size, mtime, status, catalog, event_time, captured_at, first_seen_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'catalog', 1, ?, ?, ?, ?)`)
        .run(id, r.deviceId, r.path, name, ext, r.size ?? null, normTs(r.mtime), ev, normTs(r.captureTime), now, now);
    }
    return { summary: { fileId: id, catalog: true } };
  }
  const thumb = r.thumbBlobOid ?? null;
  // PLAN decision 8: an original the device uploaded on its own (payloadKind photo / document). The blob may
  // land before or after this record; placeAndLink (called for every returned oid) marks the file cached.
  const original = r.originalBlobOid ?? null;
  let id: string;
  if (existing) {
    id = existing.id;
    db.prepare(`UPDATE files SET name = ?, ext = ?, size = ?, mtime = ?, quick_hash = ?, source_status = 'live', source_deleted_at = NULL, catalog = 0,
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

/**
 * A batch of catalog entries (and deletions), so a full-PC file listing is a few hundred records instead of
 * one per file. Each entry and deletion is applied through the catalog path of commitFileMeta, so it stores
 * and tombstones exactly as a single catalogOnly file_meta would. The whole batch runs in the ingester's
 * per-record transaction.
 */
export function commitFileCatalog(db: DB, r: FileCatalogRecordT): CommitResult {
  let entries = 0, deletions = 0;
  for (const e of r.entries) {
    commitFileMeta(db, {
      v: 1, kind: "file_meta", deviceId: r.deviceId, eventTime: e.mtime, captureTime: r.captureTime,
      path: e.path, name: e.name, ext: e.ext, size: e.size, mtime: e.mtime, catalogOnly: true,
    } as FileMetaRecordT);
    entries++;
  }
  for (const p of r.deletions) {
    commitFileMeta(db, {
      v: 1, kind: "file_meta", deviceId: r.deviceId, eventTime: r.eventTime, captureTime: r.captureTime,
      path: p, name: baseName(p), ext: extOf(p) ?? "", catalogOnly: true, deleted: true,
    } as FileMetaRecordT);
    deletions++;
  }
  return { summary: { catalog: true, entries, deletions } };
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
  const link = linkNotification(db, id); // N3: the message may already be archived
  return { summary: { notificationId: id, app: n.app, ...(link ? { linkedMessageId: link.messageId, linkConfidence: link.confidence } : {}) } };
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

interface StoredMsg {
  id: string; text: string; sender: string; edited_at: string | null; text_source: string | null; text_quality: "full" | "preview";
}

type TextDecision = "same" | "keep" | "upgrade" | "edit";

/**
 * Non-destructive merge of one copy of a message into the stored record (WX1, C8, PROTOCOL §6):
 * a notification preview never overwrites full text; a full copy (or a longer preview) replaces a
 * preview and that is not an edit; between full copies a later edit wins, a stale copy (older
 * editedAt) is ignored, the same source re-sending changed text is an edit, and of two copies from
 * different sources with the same edit stamp the richer (longer) text wins. Replaced full text always
 * goes to message_edits, so nothing is lost.
 */
function decideText(ex: StoredMsg, inc: { text: string; editedAt: string | null; preview: boolean; source: string }): TextDecision {
  if (inc.preview && ex.text_quality === "full") return "keep";
  if (!inc.preview && ex.text_quality === "preview") return "upgrade";
  if (inc.text === ex.text) return "same";
  if (inc.preview) return inc.text.length > ex.text.length ? "upgrade" : "keep"; // two previews: keep the fuller one
  const a = inc.editedAt ?? "", b = ex.edited_at ?? "";
  if (a > b) return "edit";
  if (a < b) return "keep";
  if (ex.text_source === null || ex.text_source === inc.source) return "edit";
  return inc.text.length > ex.text.length ? "edit" : "keep";
}

function upsertSource(db: DB, s: { messageId: string; deviceId: string | null; source: string; capturedAt: string; deletedAt: string | null }) {
  db.prepare(`INSERT INTO message_sources(message_id, device_id, source_session, captured_at, last_seen_at, source_deleted_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(message_id, source_session) DO UPDATE SET device_id = COALESCE(excluded.device_id, device_id),
                captured_at = MIN(captured_at, excluded.captured_at), last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
                source_deleted_at = COALESCE(source_deleted_at, excluded.source_deleted_at)`)
    .run(s.messageId, s.deviceId, s.source, s.capturedAt, s.capturedAt, s.deletedAt);
}

/** Record a source's coverage claim for a conversation; conversations.coverage is the best claim. */
function claimCoverage(db: DB, conversationId: string, source: string, claim: Coverage, opts: { onlyIfAbsent?: boolean } = {}) {
  const row = db.prepare("SELECT coverage_by_source FROM conversations WHERE id = ?").get(conversationId) as { coverage_by_source: string } | undefined;
  if (!row) return;
  const by = parseCoverageBySource(row.coverage_by_source);
  if (opts.onlyIfAbsent && by[source]) return;
  by[source] = claim;
  db.prepare("UPDATE conversations SET coverage_by_source = ?, coverage = ? WHERE id = ?").run(stableJson(by), bestCoverage(by), conversationId);
}

// ---- notification previews -> archived messages (N3, C8)

/** Notification app (Android package or Windows app name) -> message platform. */
const NOTIF_APP_PLATFORM: Record<string, string> = {
  "jp.naver.line.android": "line",
  "org.telegram.messenger": "telegram", "org.telegram.messenger.web": "telegram", "org.thunderdog.challegram": "telegram",
  "com.whatsapp": "whatsapp", "com.whatsapp.w4b": "whatsapp",
  "com.google.android.apps.messaging": "sms", "com.samsung.android.messaging": "sms", "com.android.mms": "sms",
  "com.instagram.android": "instagram", "com.snapchat.android": "snapchat",
};

export function platformOfNotificationApp(app: string): string | null {
  const a = app.trim().toLowerCase();
  if (NOTIF_APP_PLATFORM[a]) return NOTIF_APP_PLATFORM[a]!;
  if (a.includes("telegram")) return "telegram";
  if (a === "line" || a.startsWith("line ")) return "line";
  if (a.includes("whatsapp")) return "whatsapp";
  if (a.includes("instagram")) return "instagram";
  if (a.includes("snapchat")) return "snapchat";
  return null;
}

const LINK_WINDOW_MS = 2 * 60_000;
const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** A preview matches a message when it is the text or a (possibly ellipsised) prefix of it. */
function previewMatches(preview: string, text: string): boolean {
  const p = squash(preview).replace(/(…|\.\.\.)$/, "").trim();
  const t = squash(text);
  return p.length > 0 && (t === p || t.startsWith(p));
}

/**
 * Link one notification to the archived message it previews, when a match can be established:
 * same platform, sent within two minutes of the notification, preview equal to (or a prefix of) the
 * text. The link is "high" confidence when exactly one message matches and the notification's sender
 * or title names its sender or chat; otherwise it is labeled "uncertain" (N3). A link adds the
 * notification as a provenance row of the message (C8).
 */
function linkNotification(db: DB, notificationId: string): { messageId: string; confidence: string } | null {
  const n = db.prepare(`SELECT id, device_id, source, app, title, sender, preview, posted_at, captured_at, linked_message_id FROM notifications
                        WHERE id = ? AND deleted_at IS NULL`).get(notificationId) as {
    id: string; device_id: string; source: string; app: string; title: string | null; sender: string | null; preview: string | null;
    posted_at: string; captured_at: string; linked_message_id: string | null;
  } | undefined;
  if (!n || n.linked_message_id || !n.preview) return null;
  const platform = platformOfNotificationApp(n.app);
  const at = msOf(n.posted_at);
  if (!platform || at === null) return null;
  const cands = (db.prepare(`SELECT m.id, m.sender, m.text, m.sent_at, m.conversation_id, c.peer, c.chat_title FROM messages m JOIN conversations c ON c.id = m.conversation_id
                             WHERE c.platform = ? AND m.sent_at BETWEEN ? AND ? AND m.deleted_at IS NULL AND c.deleted_at IS NULL`)
    .all(platform, new Date(at - LINK_WINDOW_MS).toISOString(), new Date(at + LINK_WINDOW_MS).toISOString()) as Array<{
      id: string; sender: string; text: string; sent_at: string; conversation_id: string; peer: string | null; chat_title: string | null;
    }>).filter((m) => previewMatches(n.preview!, m.text));
  if (!cands.length) return null;
  cands.sort((x, y) => Math.abs(msOf(x.sent_at)! - at) - Math.abs(msOf(y.sent_at)! - at));
  const best = cands[0]!;
  const who = [n.sender, n.title].filter((s): s is string => !!s).map(squash);
  const names = [best.sender, best.peer, best.chat_title].filter((s): s is string => !!s).map(squash);
  const confidence = cands.length === 1 && who.some((w) => names.includes(w)) ? "high" : "uncertain";
  db.prepare("UPDATE notifications SET linked_message_id = ?, link_confidence = ? WHERE id = ?").run(best.id, confidence, n.id);
  const source = `${n.source}:notification`;
  upsertSource(db, { messageId: best.id, deviceId: n.device_id, source, capturedAt: n.captured_at, deletedAt: null });
  claimCoverage(db, best.conversation_id, source, "notification_only", { onlyIfAbsent: true });
  return { messageId: best.id, confidence };
}

/** Try to link the unlinked notifications posted around a newly archived message. */
function linkNotificationsAround(db: DB, sentAt: string): number {
  const at = msOf(sentAt);
  if (at === null) return 0;
  const ids = db.prepare(`SELECT id FROM notifications WHERE linked_message_id IS NULL AND deleted_at IS NULL AND preview IS NOT NULL AND posted_at BETWEEN ? AND ?`)
    .all(new Date(at - LINK_WINDOW_MS).toISOString(), new Date(at + LINK_WINDOW_MS).toISOString()) as Array<{ id: string }>;
  let n = 0;
  for (const { id } of ids) if (linkNotification(db, id)) n++;
  return n;
}

export function commitMessageBatch(db: DB, r: MessageBatchRecordT): CommitResult {
  const now = nowIso();
  const source = r.sourceSession;
  const preview = isNotificationSource(source);
  const claim = effectiveClaim(source, r.platform, r.coverage);
  const meta = r.chatMeta ?? {};
  let conv = db.prepare("SELECT id, coverage_by_source FROM conversations WHERE platform = ? AND account = ? AND conv_key = ?").get(r.platform, r.account, r.convKey) as
    { id: string; coverage_by_source: string } | undefined;
  const by = parseCoverageBySource(conv?.coverage_by_source);
  by[source] = claim; // the latest claim of each source stands
  if (conv) {
    db.prepare(`UPDATE conversations SET peer = COALESCE(?, peer), kind = ?, coverage = ?, coverage_by_source = ?, cursor = ?, device_id = COALESCE(device_id, ?),
                  chat_title = COALESCE(?, chat_title), participant_count = COALESCE(?, participant_count), chat_type = COALESCE(?, chat_type),
                  avatar_blob_oid = COALESCE(?, avatar_blob_oid), updated_at = ? WHERE id = ?`)
      .run(r.peer ?? null, r.convKind, bestCoverage(by), stableJson(by), r.cursor, r.deviceId, meta.title ?? null, meta.participantCount ?? null, meta.chatType ?? null, meta.avatarBlobOid ?? null, now, conv.id);
  } else {
    conv = { id: randomUUID(), coverage_by_source: "" };
    db.prepare(`INSERT INTO conversations(id, device_id, platform, account, conv_key, peer, kind, coverage, coverage_by_source, cursor, chat_title, participant_count, chat_type, avatar_blob_oid, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(conv.id, r.deviceId, r.platform, r.account, r.convKey, r.peer ?? null, r.convKind, bestCoverage(by), stableJson(by), r.cursor,
        meta.title ?? null, meta.participantCount ?? null, meta.chatType ?? null, meta.avatarBlobOid ?? null, now, now);
  }
  const captured = normTs(r.captureTime)!;
  const blobs: string[] = [];
  let inserted = 0, edited = 0, upgraded = 0, linked = 0;
  const getMsg = db.prepare("SELECT id, text, sender, edited_at, text_source, text_quality FROM messages WHERE conversation_id = ? AND msg_key = ?");
  for (const m of r.messages) {
    const ex = getMsg.get(conv.id, m.msgId) as StoredMsg | undefined;
    // from_me stays 0/1 when the source said so, null when it did not (so a later source can fill it)
    const fromMe = m.fromMe === undefined ? null : m.fromMe ? 1 : 0;
    const senderName = m.senderName ?? null;
    const editedAt = normTs(m.editedAt);
    const deletedAt = m.sourceStatus === "deleted_at_source" ? (normTs(m.deletedAtSource) ?? captured) : null;
    const replyId = m.replyTo
      ? ((db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND msg_key = ?").get(conv.id, m.replyTo) as { id: string } | undefined)?.id ?? null)
      : null;
    let msgId: string;
    let relink = false;
    if (ex) {
      msgId = ex.id;
      const d = decideText(ex, { text: m.text, editedAt, preview, source });
      if (d === "edit") {
        // C3: an observable edit updates the record and keeps the prior text; no duplicate row
        db.prepare("INSERT INTO message_edits(message_id, text, edited_at, recorded_at) VALUES (?, ?, ?, ?)").run(ex.id, ex.text, ex.edited_at, now);
        edited++;
      }
      if (d === "upgrade") upgraded++;
      if (d === "edit" || d === "upgrade") {
        // a copy from a fuller source also corrects what a preview guessed (sender, time)
        const fromPreview = ex.text_quality === "preview" && !preview;
        db.prepare(`UPDATE messages SET text = ?, text_source = ?, text_quality = ?, sender = CASE WHEN ? THEN ? ELSE sender END,
                      sent_at = CASE WHEN ? THEN ? ELSE sent_at END WHERE id = ?`)
          .run(m.text, source, preview ? "preview" : "full", fromPreview ? 1 : 0, m.sender, fromPreview ? 1 : 0, normTs(m.sentAt), ex.id);
      }
      // never removed by any source: a deletion only marks it (C6); the earliest observed deletion stands.
      // from_me and sender_name are filled from whichever source provides them and never cleared.
      db.prepare(`UPDATE messages SET edited_at = CASE WHEN edited_at IS NULL OR ? > edited_at THEN ? ELSE edited_at END,
                    source_status = CASE WHEN ? IS NOT NULL THEN 'deleted_at_source' ELSE source_status END,
                    source_deleted_at = CASE WHEN ? IS NOT NULL AND (source_deleted_at IS NULL OR ? < source_deleted_at) THEN ? ELSE source_deleted_at END,
                    forwarded_from = COALESCE(forwarded_from, ?), media_kind = COALESCE(media_kind, ?),
                    from_me = COALESCE(from_me, ?), sender_name = COALESCE(sender_name, ?),
                    reply_to = COALESCE(?, reply_to), reply_to_key = COALESCE(?, reply_to_key) WHERE id = ?`)
        .run(editedAt, editedAt, deletedAt, deletedAt, deletedAt, deletedAt, m.forwardedFrom ?? null, m.mediaKind ?? null, fromMe, senderName, replyId, m.replyTo ?? null, ex.id);
      relink = d === "upgrade";
    } else {
      msgId = randomUUID();
      db.prepare(`INSERT INTO messages(id, conversation_id, device_id, msg_key, sender, sent_at, captured_at, text, reply_to, reply_to_key, edited_at, source_status,
                    text_source, text_quality, forwarded_from, media_kind, from_me, sender_name, source_deleted_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(msgId, conv.id, r.deviceId, m.msgId, m.sender, normTs(m.sentAt), captured, m.text, replyId, m.replyTo ?? null, editedAt,
          deletedAt ? "deleted_at_source" : "live", source, preview ? "preview" : "full", m.forwardedFrom ?? null, m.mediaKind ?? null, fromMe, senderName, deletedAt);
      // resolve earlier replies that pointed at this message before it arrived
      db.prepare("UPDATE messages SET reply_to = ? WHERE conversation_id = ? AND reply_to_key = ? AND reply_to IS NULL").run(msgId, conv.id, m.msgId);
      inserted++;
      relink = true;
    }
    upsertSource(db, { messageId: msgId, deviceId: r.deviceId, source, capturedAt: captured, deletedAt });
    if (relink) linked += linkNotificationsAround(db, normTs(m.sentAt)!); // N3, after this source's own provenance row
    for (const a of m.attachments ?? []) {
      db.prepare(`INSERT INTO attachments(id, message_id, att_key, kind, filename, size, origin_hash, blob_oid, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(message_id, att_key) DO UPDATE SET filename = excluded.filename, size = excluded.size,
                    origin_hash = COALESCE(excluded.origin_hash, origin_hash), blob_oid = COALESCE(excluded.blob_oid, blob_oid)`)
        .run(randomUUID(), msgId, a.attId, a.kind, a.filename, a.size, a.originHash ?? null, a.blobOid ?? null, a.blobOid ? "indexed" : "on_demand");
      if (a.blobOid) blobs.push(a.blobOid);
    }
  }
  // the chat avatar is a blob too: return it so the ingester links it to this conversation once placed
  if (meta.avatarBlobOid) blobs.push(meta.avatarBlobOid);
  return { summary: { conversationId: conv.id, platform: r.platform, sourceSession: source, coverage: claim, inserted, edited, upgraded, linkedNotifications: linked }, blobs };
}

// ---------------------------------------------------------------- LINE account state

/**
 * One account snapshot of the user's own LINE state: the own profile, the contact list, each chat's
 * options and the app settings. The snapshot replaces the account's rows, so a contact, option or
 * setting dropped at the source disappears here too. Blocked is stored only when the record itself
 * resolved it (the incoming `blocked` field); otherwise it stays NULL (unknown) and the raw store
 * `status`/`settings` are kept as given, so the real rule can be finalized later. A contact or profile
 * picture is linked to its local copy when the named avatar blob is already in the vault; otherwise
 * picture_local_path stays null and fills in on a later snapshot once the blob has landed.
 */
export function commitLineAccount(db: DB, r: LineAccountRecordT): CommitResult {
  const now = nowIso();
  const account = r.account;
  db.prepare("DELETE FROM line_account_profile WHERE account = ?").run(account);
  db.prepare("DELETE FROM line_contacts WHERE account = ?").run(account);
  db.prepare("DELETE FROM line_chat_options WHERE account = ?").run(account);
  db.prepare("DELETE FROM line_settings WHERE account = ?").run(account);

  const getBlob = db.prepare("SELECT local_path FROM blobs WHERE oid = ? AND status = 'complete' AND local_path IS NOT NULL LIMIT 1");
  const localPicture = (picturePath?: string): string | null =>
    picturePath ? ((getBlob.get(picturePath) as { local_path: string } | undefined)?.local_path ?? null) : null;

  if (r.ownProfile) {
    const p = r.ownProfile;
    db.prepare(`INSERT INTO line_account_profile(account, mid, display_name, user_id, status_message, picture_local_path, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(account, p.mid, p.displayName ?? null, p.userId ?? null, p.statusMessage ?? null, localPicture(p.picturePath), now);
  }

  const insContact = db.prepare(`INSERT INTO line_contacts(account, mid, display_name, status, type, settings, blocked, status_message, picture_local_path, thumbnail_url, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let blocked = 0;
  for (const c of r.contacts) {
    const b = c.blocked === undefined ? null : c.blocked ? 1 : 0;
    if (b === 1) blocked++;
    insContact.run(account, c.mid, c.displayName ?? null, c.status ?? null, c.type ?? null, c.settings ?? null, b, c.statusMessage ?? null, localPicture(c.picturePath), c.thumbnailUrl ?? null, now);
  }

  const insOption = db.prepare("INSERT INTO line_chat_options(account, chat_id, hidden, notification, pinned, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  const bit = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
  let hidden = 0;
  for (const o of r.chatOptions) {
    if (o.hidden === true) hidden++;
    insOption.run(account, o.chatId, o.hidden ? 1 : 0, bit(o.notification), bit(o.pinned), now);
  }

  const insSetting = db.prepare("INSERT INTO line_settings(account, key, value, updated_at) VALUES (?, ?, ?, ?)");
  for (const s of r.settings) insSetting.run(account, s.key, s.value, now);

  return { summary: { account, contacts: r.contacts.length, chatOptions: r.chatOptions.length, settings: r.settings.length, blocked, hidden } };
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
