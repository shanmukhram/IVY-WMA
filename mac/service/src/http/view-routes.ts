/**
 * Read-only routes for the redesigned dashboard (PLAN decision 5): the per-source
 * conversation views, per-device source views and the media gallery. Registered
 * from server.ts with one line, so they sit behind the same guards as every other
 * content route (token, loopback Host, same-site Origin, 423 while locked).
 *
 *   GET /api/views/sources
 *       capture sources of conversations (message_sources.source_session, e.g.
 *       windows:telegram-desktop), per platform: conversations, messages, last message
 *   GET /api/views/chats?source=&role=&platform=&q=&page=&pageSize=
 *       conversations seen by a source (or by any source of a role), newest first,
 *       with the last message preview, counts, first/last message time and coverage
 *   GET /api/views/chats/:id/profile
 *       profile pane: counts, first/last message, coverage and counts per source,
 *       top senders, edited / deleted-at-source / attachment counts
 *   GET /api/views/records?type=a,b&device=<id|windows|android>&app=&page=&pageSize=
 *       newest-first listing of any record types filtered by device and app
 *       (per-device source views, media gallery with a device filter); media items
 *       carry their OCR text
 *   GET /api/views/notification-apps?device=<id|windows|android>
 *       per-app notification counts for one device or role
 *
 * Attachment status in these views (and /api/attachments) is the stored state
 * (indexed / cached / on_demand) with one read-time refinement, phone_only (see
 * attachmentStatusSql).
 */
import type { FastifyInstance } from "fastify";
import type { Service } from "../service.ts";
import { enrich, itemView, type BaseItem } from "../query/details.ts";
import { ITEM_TYPES, TYPE_DEFS, filterSql, selectList, type ItemType } from "../query/types.ts";
import { coverageView } from "../query/sources.ts";

const int = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), min), max) : dflt;
};

const SOURCE_RE = /^(windows|android):[a-z0-9][a-z0-9._-]*$/;
const ROLE_RE = /^(windows|android)$/;

/** Device filter shared by the routes: a role matches every device of that role. */
function deviceWhere(col: string, device: string | undefined): { sql: string; args: unknown[] } | null {
  if (!device) return null;
  if (ROLE_RE.test(device)) return { sql: `${col} IN (SELECT id FROM devices WHERE role = ?)`, args: [device] };
  return { sql: `${col} = ?`, args: [device] };
}

/** The source session of the LINE for Windows collector. */
export const LINE_WINDOWS_SOURCE = "windows:line-desktop";

/**
 * SQL for an attachment's shown status (`a` = the attachments row alias). It is the stored
 * status, except that an attachment with no original on its way (stored 'on_demand') whose
 * message was delivered only by LINE for Windows reads 'phone_only': LINE for Windows keeps no
 * inline media on disk (PLAN decision 12), so no PC request can fetch it; the original lives on
 * the phone and arrives when the Android adapter imports LINE. Once any other source (e.g.
 * Android) has delivered the message, or a blob is on its way (indexed / cached), the stored
 * status stands. Derived at read time rather than stored, so the stored status keeps meaning
 * only "where the bytes are in the ingest pipeline" and the attachments CHECK constraint and
 * blob placement code are unchanged.
 */
export function attachmentStatusSql(a = "a"): string {
  return `CASE WHEN ${a}.status = 'on_demand'
      AND EXISTS (SELECT 1 FROM message_sources ps WHERE ps.message_id = ${a}.message_id AND ps.source_session = '${LINE_WINDOWS_SOURCE}')
      AND NOT EXISTS (SELECT 1 FROM message_sources ps WHERE ps.message_id = ${a}.message_id AND ps.source_session <> '${LINE_WINDOWS_SOURCE}')
    THEN 'phone_only' ELSE ${a}.status END`;
}

export function registerViewRoutes(app: FastifyInstance, svc: Service): void {
  const db = () => svc.ctx.db;

  app.get("/api/views/sources", async () => {
    const rows = db().prepare(`
      SELECT ms.source_session AS source, c.platform AS platform,
             COUNT(DISTINCT c.id) AS conversations, COUNT(DISTINCT m.id) AS messages, MAX(m.sent_at) AS lastMessageAt,
             MAX(ms.device_id) AS deviceId
      FROM message_sources ms
      JOIN messages m ON m.id = ms.message_id AND m.deleted_at IS NULL
      JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
      GROUP BY ms.source_session, c.platform
      ORDER BY ms.source_session, c.platform`).all() as Array<{ source: string; platform: string; conversations: number; messages: number; lastMessageAt: string | null; deviceId: string | null }>;
    // a source that claimed coverage for a conversation but delivered no message yet still counts
    const claimed = db().prepare(`SELECT platform, coverage_by_source FROM conversations WHERE deleted_at IS NULL`).all() as Array<{ platform: string; coverage_by_source: string }>;
    const seen = new Set(rows.map((r) => `${r.source}|${r.platform}`));
    const extra = new Map<string, { source: string; platform: string; conversations: number }>();
    for (const c of claimed) {
      for (const s of Object.keys(coverageView(c.coverage_by_source).coverageBySource)) {
        const k = `${s}|${c.platform}`;
        if (seen.has(k)) continue;
        const e = extra.get(k) ?? { source: s, platform: c.platform, conversations: 0 };
        e.conversations++;
        extra.set(k, e);
      }
    }
    const all = [...rows, ...[...extra.values()].map((e) => ({ ...e, messages: 0, lastMessageAt: null, deviceId: null }))];
    return {
      sources: all.map((r) => {
        const [role, collector] = r.source.split(":") as [string, string];
        return { ...r, role, collector };
      }).sort((a, b) => a.role.localeCompare(b.role) || a.platform.localeCompare(b.platform) || a.source.localeCompare(b.source)),
    };
  });

  app.get("/api/views/chats", async (req, reply) => {
    const q = req.query as { source?: string; role?: string; platform?: string; q?: string; page?: string; pageSize?: string };
    const pageSize = int(q.pageSize, 200, 1, 500), page = int(q.page, 1, 1, 1e9);
    const where = ["c.deleted_at IS NULL"]; const args: unknown[] = [];
    if (q.source) {
      if (!SOURCE_RE.test(q.source)) return reply.status(400).send({ error: "bad_source", message: "source must be <role>:<collector>" });
      where.push(`(json_type(c.coverage_by_source, ?) IS NOT NULL OR EXISTS (SELECT 1 FROM message_sources ms JOIN messages m ON m.id = ms.message_id
                   WHERE m.conversation_id = c.id AND ms.source_session = ?))`);
      args.push(`$."${q.source}"`, q.source);
    }
    if (q.role) {
      if (!ROLE_RE.test(q.role)) return reply.status(400).send({ error: "bad_role", message: "role must be windows or android" });
      where.push(`EXISTS (SELECT 1 FROM message_sources ms JOIN messages m ON m.id = ms.message_id
                   WHERE m.conversation_id = c.id AND ms.source_session LIKE ? || ':%')`);
      args.push(q.role);
    }
    if (q.platform) { where.push("lower(c.platform) = lower(?)"); args.push(q.platform); }
    if (q.q?.trim()) {
      where.push("(instr(lower(COALESCE(c.peer, '')), lower(?)) > 0 OR instr(lower(COALESCE(c.chat_title, '')), lower(?)) > 0 OR instr(lower(c.conv_key), lower(?)) > 0)");
      args.push(q.q.trim(), q.q.trim(), q.q.trim());
    }
    const w = where.join(" AND ");
    const total = (db().prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE ${w}`).get(...args) as { n: number }).n;
    const rows = db().prepare(`
      SELECT c.id, c.device_id AS deviceId, c.platform, c.account, c.conv_key AS convKey, c.peer, c.kind, c.coverage, c.coverage_by_source,
             c.chat_title AS chatTitle, c.participant_count AS participantCount, c.chat_type AS chatType, c.avatar_local_path AS avatarLocalPath,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS messageCount,
             (SELECT MIN(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS firstMessageAt,
             (SELECT MAX(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS lastMessageAt
      FROM conversations c WHERE ${w}
      ORDER BY lastMessageAt IS NULL, lastMessageAt DESC, c.rid DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown> & { id: string; coverage_by_source: string; avatarLocalPath: string | null }>;
    const last = db().prepare(`SELECT id, sender, sent_at AS sentAt, substr(text, 1, 200) AS text, media_kind AS mediaKind, source_status AS sourceStatus
                               FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY sent_at DESC, rid DESC LIMIT 1`);
    const items = rows.map(({ coverage_by_source, avatarLocalPath, ...c }) => {
      const cov = coverageView(coverage_by_source);
      const lastMessage = (last.get(c.id) as { text: string; sentAt: string } | undefined) ?? null;
      return {
        ...c, ...cov, lastMessage,
        // the resolved display name (chatMeta title), then the peer, then the raw conversation key
        title: (c.chatTitle as string | null) || (c.peer as string | null) || (c.convKey as string),
        avatarUrl: avatarLocalPath ? `/api/views/chats/${c.id}/avatar` : null,
        lastText: lastMessage?.text ?? null,
        lastAt: lastMessage?.sentAt ?? null,
        source: cov.coverageSources[0]?.source ?? null,
      };
    });
    return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), items };
  });

  app.get("/api/views/chats/:id/profile", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const c = db().prepare(`SELECT id, device_id AS deviceId, platform, account, conv_key AS convKey, peer, kind, coverage, coverage_by_source,
                                   chat_title AS chatTitle, participant_count AS participantCount, chat_type AS chatType, created_at AS createdAt,
                                   avatar_local_path AS avatarLocalPath
                            FROM conversations WHERE id = ? AND deleted_at IS NULL`).get(id) as (Record<string, unknown> & { coverage_by_source: string; avatarLocalPath: string | null; kind: string }) | undefined;
    if (!c) return reply.status(404).send({ error: "not_found", message: "no such conversation" });
    const { coverage_by_source, avatarLocalPath, ...conv } = c;
    const stats = db().prepare(`SELECT COUNT(*) AS messages, MIN(sent_at) AS firstMessageAt, MAX(sent_at) AS lastMessageAt,
                                       SUM(edited_at IS NOT NULL) AS edited, SUM(source_status = 'deleted_at_source') AS deletedAtSource,
                                       SUM(text_quality = 'preview') AS previewOnly
                                FROM messages WHERE conversation_id = ? AND deleted_at IS NULL`).get(id) as Record<string, number | string | null>;
    const attachments = db().prepare(`SELECT ${attachmentStatusSql("a")} AS status, COUNT(*) AS n FROM attachments a JOIN messages m ON m.id = a.message_id
                                      WHERE m.conversation_id = ? AND a.deleted_at IS NULL AND m.deleted_at IS NULL GROUP BY 1`).all(id) as Array<{ status: string; n: number }>;
    const perSource = db().prepare(`SELECT ms.source_session AS source, COUNT(*) AS messages, MIN(m.sent_at) AS firstMessageAt, MAX(m.sent_at) AS lastMessageAt,
                                           SUM(ms.source_deleted_at IS NOT NULL) AS deletedThere, MAX(ms.last_seen_at) AS lastSeenAt
                                    FROM message_sources ms JOIN messages m ON m.id = ms.message_id
                                    WHERE m.conversation_id = ? AND m.deleted_at IS NULL GROUP BY ms.source_session ORDER BY ms.source_session`).all(id) as Array<Record<string, unknown> & { source: string }>;
    const cov = coverageView(coverage_by_source);
    const sources = [...new Set([...cov.coverageSources.map((s) => s.source), ...perSource.map((s) => s.source)])].map((source) => ({
      source, coverage: cov.coverageBySource[source] ?? null,
      messages: 0, firstMessageAt: null, lastMessageAt: null, deletedThere: 0, lastSeenAt: null,
      ...(perSource.find((p) => p.source === source) ?? {}),
    }));
    const senders = db().prepare(`SELECT sender, COUNT(*) AS n FROM messages WHERE conversation_id = ? AND deleted_at IS NULL GROUP BY sender ORDER BY n DESC LIMIT 8`).all(id);
    // for a group, a short roster of distinct senders with the display name a source resolved (when any)
    const members = conv.kind === "group"
      ? (db().prepare(`SELECT sender, MAX(sender_name) AS name FROM messages WHERE conversation_id = ? AND deleted_at IS NULL GROUP BY sender ORDER BY COUNT(*) DESC LIMIT 12`).all(id) as Array<{ sender: string; name: string | null }>)
          .map((m) => ({ name: m.name ?? m.sender }))
      : undefined;
    return {
      conversation: { ...conv, ...cov },
      title: (conv.chatTitle as string | null) || (conv.peer as string | null) || (conv.convKey as string),
      avatarUrl: avatarLocalPath ? `/api/views/chats/${id}/avatar` : null,
      platform: conv.platform, account: conv.account, coverageText: cov.coverageText,
      messageCount: stats.messages ?? 0, firstAt: stats.firstMessageAt ?? null, lastAt: stats.lastMessageAt ?? null,
      messages: stats.messages ?? 0, firstMessageAt: stats.firstMessageAt ?? null, lastMessageAt: stats.lastMessageAt ?? null,
      edited: stats.edited ?? 0, deletedAtSource: stats.deletedAtSource ?? 0, previewOnly: stats.previewOnly ?? 0,
      attachments: Object.fromEntries(attachments.map((a) => [a.status, a.n])),
      sources, senders,
      ...(members ? { members } : {}),
    };
  });

  // Thread for the conversation view: each message carries who sent it (fromMe, senderName),
  // its text and status, and its attachments with a bytes URL for cached images. A window of
  // messages around a pivot (around=<id>, else the newest) with before/after counts.
  app.get("/api/views/chats/:id/messages", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { around?: string; before?: string; after?: string };
    const c = db().prepare(`SELECT id, platform, account, conv_key AS convKey, peer, kind, coverage, coverage_by_source,
                                   chat_title AS chatTitle, participant_count AS participantCount, chat_type AS chatType, avatar_local_path AS avatarLocalPath
                            FROM conversations WHERE id = ? AND deleted_at IS NULL`).get(id) as (Record<string, unknown> & { coverage_by_source: string; avatarLocalPath: string | null }) | undefined;
    if (!c) return reply.status(404).send({ error: "not_found", message: "no such conversation" });
    const { coverage_by_source, avatarLocalPath, ...convCols } = c;
    const conversation = {
      ...convCols, ...coverageView(coverage_by_source),
      title: (convCols.chatTitle as string | null) || (convCols.peer as string | null) || (convCols.convKey as string),
      avatarUrl: avatarLocalPath ? `/api/views/chats/${id}/avatar` : null,
    };
    const before = int(q.before, 40, 0, 200), after = int(q.after, 40, 0, 200);
    let pivot = q.around ? (db().prepare("SELECT sent_at, rid FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL").get(q.around, id) as { sent_at: string; rid: number } | undefined) : undefined;
    pivot ??= db().prepare("SELECT sent_at, rid FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY sent_at DESC, rid DESC LIMIT 1").get(id) as { sent_at: string; rid: number } | undefined;
    const cols = "id, sender, from_me, sender_name, sent_at, text, text_quality, reply_to, edited_at, source_deleted_at, forwarded_from";
    const older = pivot ? db().prepare(`SELECT ${cols} FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND (sent_at < ? OR (sent_at = ? AND rid < ?)) ORDER BY sent_at DESC, rid DESC LIMIT ?`).all(id, pivot.sent_at, pivot.sent_at, pivot.rid, before).reverse() : [];
    const newer = pivot ? db().prepare(`SELECT ${cols} FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND (sent_at > ? OR (sent_at = ? AND rid >= ?)) ORDER BY sent_at ASC, rid ASC LIMIT ?`).all(id, pivot.sent_at, pivot.sent_at, pivot.rid, after + 1) : [];
    const rows = [...older, ...newer] as Array<Record<string, unknown> & {
      id: string; sender: string; from_me: number | null; sender_name: string | null; sent_at: string; text: string;
      text_quality: string; reply_to: string | null; edited_at: string | null; source_deleted_at: string | null; forwarded_from: string | null;
    }>;
    const attByMsg = new Map<string, Array<Record<string, unknown>>>();
    if (rows.length) {
      const atts = db().prepare(`SELECT a.id, a.message_id AS messageId, a.kind, a.filename, ${attachmentStatusSql("a")} AS status, a.local_path AS localPath
                                 FROM attachments a WHERE a.deleted_at IS NULL AND a.message_id IN (${rows.map(() => "?").join(",")}) ORDER BY a.rid`)
        .all(...rows.map((m) => m.id)) as Array<{ id: string; messageId: string; kind: string; filename: string; status: string; localPath: string | null }>;
      for (const a of atts) {
        const l = attByMsg.get(a.messageId) ?? [];
        // a cached image original serves its bytes; everything else has no URL yet
        l.push({ id: a.id, kind: a.kind, filename: a.filename, status: a.status, imageUrl: a.kind === "image" && a.localPath ? `/api/attachments/${a.id}/content` : null });
        attByMsg.set(a.messageId, l);
      }
    }
    const messages = rows.map((m) => ({
      id: m.id, fromMe: m.from_me === 1, sender: m.sender, senderName: m.sender_name ?? null, sentAt: m.sent_at,
      text: m.text, editedAt: m.edited_at ?? null, deletedAtSource: m.source_deleted_at ?? null, forwardedFrom: m.forwarded_from ?? null,
      previewOnly: m.text_quality === "preview", replyTo: m.reply_to ?? null, attachments: attByMsg.get(m.id) ?? [],
    }));
    return { conversation, around: q.around ?? null, messages };
  });

  app.get("/api/views/records", async (req, reply) => {
    const q = req.query as { type?: string; device?: string; app?: string; from?: string; to?: string; page?: string; pageSize?: string };
    const types = (q.type ? q.type.split(",").map((t) => t.trim()) : ITEM_TYPES).filter((t): t is ItemType => ITEM_TYPES.includes(t as ItemType));
    if (!types.length) return reply.status(400).send({ error: "bad_type", message: "unknown type" });
    const pageSize = int(q.pageSize, 60, 1, 500), page = int(q.page, 1, 1, 1e9);
    const parts = types.map((t) => {
      const d = TYPE_DEFS[t];
      const f = filterSql(d, { device: q.device, app: q.app, from: q.from, to: q.to });
      return { sql: `SELECT ${selectList(d)} FROM ${d.from} WHERE ${f.sql.join(" AND ")}`, args: f.args };
    });
    const union = parts.map((p) => `SELECT * FROM (${p.sql})`).join(" UNION ALL ");
    const args = parts.flatMap((p) => p.args);
    const total = (db().prepare(`SELECT COUNT(*) AS n FROM (${union})`).get(...args) as { n: number }).n;
    const rows = db().prepare(`SELECT * FROM (${union}) ORDER BY event_time DESC, rid DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as BaseItem[];
    const mediaIds = rows.filter((r) => r.type === "screenshot" || r.type === "photo").map((r) => r.id);
    const ocr = new Map<string, string | null>();
    if (mediaIds.length) {
      for (const r of db().prepare(`SELECT id, substr(ocr_text, 1, 4000) AS t FROM media WHERE id IN (${mediaIds.map(() => "?").join(",")})`).all(...mediaIds) as Array<{ id: string; t: string | null }>) ocr.set(r.id, r.t);
    }
    const items = enrich(svc.ctx, rows).map(itemView).map((it) => (ocr.has(it.id) ? { ...it, ocrText: ocr.get(it.id) ?? null } : it));
    return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), items };
  });

  app.get("/api/views/notification-apps", async (req) => {
    const dw = deviceWhere("device_id", (req.query as { device?: string }).device);
    const rows = db().prepare(`SELECT app, source, COUNT(*) AS count, MAX(posted_at) AS latest FROM notifications
                               WHERE deleted_at IS NULL${dw ? ` AND ${dw.sql}` : ""} GROUP BY app, source ORDER BY latest DESC`).all(...(dw?.args ?? []));
    return { apps: rows };
  });
}
