/**
 * Recovery bin (PRD B1-B4).
 *
 * - Deleting inside the vault sets `deleted_at` (and the same timestamp on
 *   dependent rows: a conversation's messages, a message's attachments), so a
 *   restore brings back exactly what that delete removed.
 * - Deletion at the source is a different thing (`source_status`) and is never
 *   touched here (B4).
 * - Permanent delete (explicit, only for items already in the bin, or by the
 *   retention sweep) removes the rows, the extracted text and FTS entries (via
 *   triggers, then an FTS `optimize` so no deleted tokens linger in older
 *   segments), originals, thumbnails, reassembled blobs, prior edit versions,
 *   and activity-log lines naming the item. `secure_delete` zeroes freed pages.
 */
import { randomUUID } from "node:crypto";
import type { Ctx } from "../context.ts";
import { getNumberSetting, setSetting } from "../db/index.ts";
import { removeQuietly } from "../util/fsx.ts";
import { nowIso } from "../util/time.ts";
import { rmSync, existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { dirs } from "../config.ts";

export type BinType = "message" | "conversation" | "attachment" | "notification" | "screenshot" | "photo" | "media" | "file" | "usage" | "call" | "browsing" | "ai_conversation";

const TABLE: Record<BinType, string> = {
  message: "messages", conversation: "conversations", attachment: "attachments", notification: "notifications",
  screenshot: "media", photo: "media", media: "media", file: "files", usage: "usage_events", call: "calls",
  browsing: "browsing_events", ai_conversation: "ai_conversations",
};

const FTS_FOR: Record<string, string | null> = {
  messages: "messages_fts", notifications: "notifications_fts", media: "media_fts", files: "files_fts",
  usage_events: "usage_events_fts", calls: "calls_fts", conversations: null, attachments: null,
  browsing_events: "browsing_events_fts", ai_conversations: null,
};

export class BinError extends Error {
  readonly code: string;
  constructor(code: string, m: string) { super(m); this.code = code; }
}

export function isBinType(t: string): t is BinType { return t in TABLE; }

function row(ctx: Ctx, type: BinType, id: string): { id: string; deleted_at: string | null; deleted_batch: string | null } | undefined {
  return ctx.db.prepare(`SELECT id, deleted_at, deleted_batch FROM ${TABLE[type]} WHERE id = ?`).get(id) as { id: string; deleted_at: string | null; deleted_batch: string | null } | undefined;
}

export function retentionDays(ctx: Ctx): number {
  return getNumberSetting(ctx.db, "bin.retentionDays", ctx.config.binRetentionDays);
}

export function setRetentionDays(ctx: Ctx, days: number): void {
  if (!Number.isFinite(days) || days < 1 || days > 3650) throw new BinError("bad_retention", "retentionDays must be between 1 and 3650");
  setSetting(ctx.db, "bin.retentionDays", String(Math.floor(days)));
}

export function softDelete(ctx: Ctx, type: BinType, id: string): { deletedAt: string } {
  const r = row(ctx, type, id);
  if (!r) throw new BinError("not_found", `no ${type} ${id}`);
  if (r.deleted_at) return { deletedAt: r.deleted_at };
  const at = nowIso();
  const batch = randomUUID();
  ctx.db.transaction(() => {
    ctx.db.prepare(`UPDATE ${TABLE[type]} SET deleted_at = ?, deleted_batch = ? WHERE id = ?`).run(at, batch, id);
    if (type === "conversation") {
      ctx.db.prepare("UPDATE attachments SET deleted_at = ?, deleted_batch = ? WHERE deleted_at IS NULL AND message_id IN (SELECT id FROM messages WHERE conversation_id = ? AND deleted_at IS NULL)").run(at, batch, id);
      ctx.db.prepare("UPDATE messages SET deleted_at = ?, deleted_batch = ? WHERE conversation_id = ? AND deleted_at IS NULL").run(at, batch, id);
    }
    if (type === "message") ctx.db.prepare("UPDATE attachments SET deleted_at = ?, deleted_batch = ? WHERE message_id = ? AND deleted_at IS NULL").run(at, batch, id);
  })();
  ctx.events.emit("bin.deleted", { type, id });
  return { deletedAt: at };
}

export function restore(ctx: Ctx, type: BinType, id: string): { restored: boolean } {
  const r = row(ctx, type, id);
  if (!r) throw new BinError("not_found", `no ${type} ${id}`);
  if (!r.deleted_at) return { restored: false };
  const batch = r.deleted_batch;
  ctx.db.transaction(() => {
    ctx.db.prepare(`UPDATE ${TABLE[type]} SET deleted_at = NULL, deleted_batch = NULL WHERE id = ?`).run(id);
    if (batch && (type === "conversation" || type === "message")) {
      ctx.db.prepare("UPDATE attachments SET deleted_at = NULL, deleted_batch = NULL WHERE deleted_batch = ?").run(batch);
      ctx.db.prepare("UPDATE messages SET deleted_at = NULL, deleted_batch = NULL WHERE deleted_batch = ?").run(batch);
    }
    if (type === "message") {
      // B2: restoring a message brings back its conversation relationship (the conversation row only)
      ctx.db.prepare("UPDATE conversations SET deleted_at = NULL, deleted_batch = NULL WHERE id = (SELECT conversation_id FROM messages WHERE id = ?)").run(id);
    }
    if (type === "attachment") ctx.db.prepare("UPDATE messages SET deleted_at = NULL, deleted_batch = NULL WHERE id = (SELECT message_id FROM attachments WHERE id = ?)").run(id);
  })();
  ctx.events.emit("bin.restored", { type, id });
  return { restored: true };
}

/** Permanent delete of an item that is in the bin. */
export function purge(ctx: Ctx, type: BinType, id: string, opts: { requireInBin?: boolean } = {}): { removedFiles: number } {
  const r = row(ctx, type, id);
  if (!r) throw new BinError("not_found", `no ${type} ${id}`);
  if ((opts.requireInBin ?? true) && !r.deleted_at) throw new BinError("not_in_bin", "move the item to the recovery bin first; permanent delete is only offered there");
  const paths: string[] = [];
  const blobOids: string[] = [];
  const ids: string[] = [id];
  const touched = new Set<string>();
  ctx.db.transaction(() => {
    const table = TABLE[type];
    if (table === "media") {
      const m = ctx.db.prepare("SELECT local_path, thumb_path, blob_oid FROM media WHERE id = ?").get(id) as { local_path: string | null; thumb_path: string | null; blob_oid: string | null };
      paths.push(...[m.local_path, m.thumb_path].filter((x): x is string => !!x));
      if (m.blob_oid) blobOids.push(m.blob_oid);
    } else if (table === "files") {
      const f = ctx.db.prepare("SELECT local_path, thumb_path, thumb_blob_oid FROM files WHERE id = ?").get(id) as { local_path: string | null; thumb_path: string | null; thumb_blob_oid: string | null };
      paths.push(...[f.local_path, f.thumb_path].filter((x): x is string => !!x));
      if (f.thumb_blob_oid) blobOids.push(f.thumb_blob_oid);
      for (const c of ctx.db.prepare("SELECT result_oid FROM commands WHERE file_id = ? AND result_oid IS NOT NULL").all(id) as Array<{ result_oid: string }>) blobOids.push(c.result_oid);
      ctx.db.prepare("UPDATE commands SET file_id = NULL, params = json_set(params, '$.params.path', '[deleted]') WHERE file_id = ?").run(id);
    } else if (table === "attachments") {
      const a = ctx.db.prepare("SELECT local_path, blob_oid FROM attachments WHERE id = ?").get(id) as { local_path: string | null; blob_oid: string | null };
      if (a.local_path) paths.push(a.local_path);
      if (a.blob_oid) blobOids.push(a.blob_oid);
    } else if (table === "messages" || table === "conversations") {
      const msgIds = table === "messages" ? [id]
        : (ctx.db.prepare("SELECT id FROM messages WHERE conversation_id = ?").all(id) as Array<{ id: string }>).map((m) => m.id);
      for (const mid of msgIds) {
        for (const a of ctx.db.prepare("SELECT id, local_path, blob_oid FROM attachments WHERE message_id = ?").all(mid) as Array<{ id: string; local_path: string | null; blob_oid: string | null }>) {
          if (a.local_path) paths.push(a.local_path);
          if (a.blob_oid) blobOids.push(a.blob_oid);
          ids.push(a.id);
        }
        ctx.db.prepare("DELETE FROM attachments WHERE message_id = ?").run(mid);
        ctx.db.prepare("DELETE FROM message_edits WHERE message_id = ?").run(mid);
        ctx.db.prepare("DELETE FROM message_sources WHERE message_id = ?").run(mid);
        ctx.db.prepare("UPDATE notifications SET linked_message_id = NULL, link_confidence = NULL WHERE linked_message_id = ?").run(mid);
        ctx.db.prepare("UPDATE messages SET reply_to = NULL WHERE reply_to = ?").run(mid);
        ids.push(mid);
      }
      if (table === "conversations") { ctx.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id); touched.add("messages"); }
    }
    for (const oid of blobOids) {
      for (const b of ctx.db.prepare("SELECT local_path, tmp_path FROM blobs WHERE oid = ?").all(oid) as Array<{ local_path: string | null; tmp_path: string | null }>) {
        paths.push(...[b.local_path, b.tmp_path].filter((x): x is string => !!x));
      }
      ctx.db.prepare("DELETE FROM blobs WHERE oid = ?").run(oid);
    }
    ctx.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    touched.add(table);
    // AI history quotes what its tools retrieved: a conversation that cites a purged record goes with it (B3)
    if (table !== "ai_conversations") for (const x of ids) ctx.db.prepare("DELETE FROM ai_conversations WHERE instr(transcript, ?) > 0").run(x);
    // activity lines that name the item (events carry ids, never content, but ids link back)
    for (const x of ids) ctx.db.prepare("DELETE FROM activity WHERE instr(data, ?) > 0").run(x);
  })();
  for (const t of touched) {
    const f = FTS_FOR[t];
    if (f) ctx.db.prepare(`INSERT INTO ${f}(${f}) VALUES ('optimize')`).run();
  }
  let removed = 0;
  const filesDir = dirs(ctx.config).files;
  for (const p of new Set(paths)) {
    // a media-policy original (PLAN decision 8) can be both a file's copy and a photo, or shared by copies
    if (ctx.db.prepare("SELECT 1 FROM files WHERE local_path = ? UNION ALL SELECT 1 FROM media WHERE local_path = ? LIMIT 1").get(p, p)) continue;
    if (removeQuietly(p)) removed++;
    // originals live in files/<oid>/<name>: remove the now-empty folder too
    const parent = dirname(p);
    if (dirname(parent) === filesDir && existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
  }
  ctx.events.emit("bin.purged", { type, removedFiles: removed });
  return { removedFiles: removed };
}

const LIST_SQL: Array<{ type: BinType; sql: string }> = [
  { type: "conversation", sql: "SELECT 'conversation' AS type, id, deleted_at, COALESCE(peer, conv_key) AS title, platform AS detail FROM conversations WHERE deleted_at IS NOT NULL" },
  { type: "message", sql: `SELECT 'message', m.id, m.deleted_at, m.sender, substr(m.text, 1, 160) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                           WHERE m.deleted_at IS NOT NULL AND (c.deleted_at IS NULL OR c.deleted_batch IS NOT m.deleted_batch)` },
  { type: "notification", sql: "SELECT 'notification', id, deleted_at, title, app FROM notifications WHERE deleted_at IS NOT NULL" },
  { type: "media", sql: "SELECT kind, id, deleted_at, source_path, kind FROM media WHERE deleted_at IS NOT NULL" },
  { type: "file", sql: "SELECT 'file', id, deleted_at, name, path FROM files WHERE deleted_at IS NOT NULL" },
  { type: "usage", sql: "SELECT 'usage', id, deleted_at, app, title FROM usage_events WHERE deleted_at IS NOT NULL" },
  { type: "call", sql: "SELECT 'call', id, deleted_at, contact, number FROM calls WHERE deleted_at IS NOT NULL" },
  { type: "browsing", sql: "SELECT 'browsing', id, deleted_at, title, product FROM browsing_events WHERE deleted_at IS NOT NULL" },
  { type: "ai_conversation", sql: "SELECT 'ai_conversation', id, deleted_at, title, kind FROM ai_conversations WHERE deleted_at IS NOT NULL" },
];

export function listBin(ctx: Ctx, opts: { page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 500);
  const page = Math.max(opts.page ?? 1, 1);
  const union = LIST_SQL.map((x) => x.sql).join(" UNION ALL ");
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (${union})`).get() as { n: number }).n;
  const days = retentionDays(ctx);
  const rows = ctx.db.prepare(`SELECT * FROM (${union}) ORDER BY deleted_at DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as Array<{ type: string; id: string; deleted_at: string; title: string | null; detail: string | null }>;
  return {
    retentionDays: days, total, page, pageSize,
    items: rows.map((r) => ({
      type: r.type, id: r.id, deletedAt: r.deleted_at, title: r.title, detail: r.detail,
      purgeAt: new Date(Date.parse(r.deleted_at) + days * 86400_000).toISOString(),
    })),
  };
}

/** Permanently delete everything older than the retention period. */
export function sweep(ctx: Ctx, now = Date.now()): { purged: number } {
  const cutoff = new Date(now - retentionDays(ctx) * 86400_000).toISOString();
  let purged = 0;
  const pick = (sql: string) => ctx.db.prepare(sql).all(cutoff) as Array<{ id: string; t: string }>;
  const order: Array<[BinType, string]> = [
    ["conversation", "SELECT id, 'conversation' AS t FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["message", "SELECT id, 'message' AS t FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["attachment", "SELECT id, 'attachment' AS t FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["notification", "SELECT id, 'notification' AS t FROM notifications WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["media", "SELECT id, 'media' AS t FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["file", "SELECT id, 'file' AS t FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["usage", "SELECT id, 'usage' AS t FROM usage_events WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["call", "SELECT id, 'call' AS t FROM calls WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["browsing", "SELECT id, 'browsing' AS t FROM browsing_events WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
    ["ai_conversation", "SELECT id, 'ai_conversation' AS t FROM ai_conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?"],
  ];
  for (const [type, sql] of order) {
    for (const r of pick(sql)) {
      if (!row(ctx, type, r.id)) continue; // already gone with its conversation
      purge(ctx, type, r.id);
      purged++;
    }
  }
  setSetting(ctx.db, "bin.lastSweepAt", nowIso());
  return { purged };
}

