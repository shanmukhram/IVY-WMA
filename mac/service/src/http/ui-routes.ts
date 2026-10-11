/**
 * Read-only listing routes the dashboard UI needs beyond search / timeline /
 * coverage (added with @ivy/mac-ui). Registered from server.ts, so they sit
 * behind the same guards: bearer/cookie token, loopback Host, same-site Origin,
 * and 423 while the vault is locked.
 *
 *   GET /api/conversations?platform=&page=&pageSize=      conversation list with coverage badge and its sources (C9, WX1)
 *   GET /api/attachments?message=<id,id,...>              attachments for messages, with status (C4)
 *   GET /api/notifications/apps                           per-app counts (N2)
 *   GET /api/notifications?app=&page=&pageSize=           newest first; every item is a partial record (N4)
 *   GET /api/media?kind=screenshot|photo&page=&pageSize=  grid listing with OCR text (M1-M3)
 *   GET /api/media/:id/origin                             evidenced vs inferred origin links (M6)
 *   GET /api/facets                                       values for the search filter rail (Q3)
 *   GET /api/ui-settings, PUT /api/ui-settings {key: value}   UI-owned settings (ai.cloudEnabled)
 */
import type { FastifyInstance } from "fastify";
import type { Service } from "../service.ts";
import { enrich, itemView, type BaseItem } from "../query/details.ts";
import { TYPE_DEFS, selectList } from "../query/types.ts";
import { getSetting, setSetting } from "../db/index.ts";
import { coverageView } from "../query/sources.ts";
import { attachmentStatusSql } from "./view-routes.ts";

const int = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), min), max) : dflt;
};

/** UI-owned settings: key -> type. Values live in the vault `settings` table under `ui.<key>`. */
const UI_SETTINGS: Record<string, "boolean" | "string"> = {
  "ai.cloudEnabled": "boolean",
};

function readUiSettings(svc: Service): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(UI_SETTINGS)) {
    const v = getSetting(svc.ctx.db, `ui.${k}`);
    out[k] = t === "boolean" ? v === "true" : (v ?? null);
  }
  return out;
}

export function registerUiRoutes(app: FastifyInstance, svc: Service): void {
  const db = () => svc.ctx.db;

  app.get("/api/conversations", async (req) => {
    const q = req.query as { platform?: string; page?: string; pageSize?: string };
    const pageSize = int(q.pageSize, 100, 1, 500), page = int(q.page, 1, 1, 1e9);
    const where = ["c.deleted_at IS NULL"]; const args: unknown[] = [];
    if (q.platform) { where.push("lower(c.platform) = lower(?)"); args.push(q.platform); }
    const w = where.join(" AND ");
    const total = (db().prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE ${w}`).get(...args) as { n: number }).n;
    const rows = db().prepare(`
      SELECT c.id, c.device_id AS deviceId, c.platform, c.account, c.conv_key AS convKey, c.peer, c.kind, c.coverage, c.coverage_by_source, c.updated_at AS updatedAt,
             c.chat_title AS chatTitle, c.participant_count AS participantCount, c.chat_type AS chatType,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS messageCount,
             (SELECT MAX(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS lastMessageAt
      FROM conversations c WHERE ${w}
      ORDER BY lastMessageAt IS NULL, lastMessageAt DESC, c.rid DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown> & { coverage_by_source: string }>;
    const items = rows.map(({ coverage_by_source, ...c }) => ({ ...c, ...coverageView(coverage_by_source) }));
    const platforms = db().prepare("SELECT platform, coverage, COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL GROUP BY platform, coverage ORDER BY platform").all();
    return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), items, platforms };
  });

  app.get("/api/attachments", async (req) => {
    const ids = String((req.query as { message?: string }).message ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500);
    if (!ids.length) return { items: [] };
    const rows = db().prepare(`SELECT a.id, a.message_id AS messageId, a.kind, a.filename, a.size, ${attachmentStatusSql("a")} AS status, a.local_path IS NOT NULL AS local
                               FROM attachments a WHERE a.deleted_at IS NULL AND a.message_id IN (${ids.map(() => "?").join(",")}) ORDER BY a.rid`).all(...ids);
    return { items: rows };
  });

  app.get("/api/notifications/apps", async () => ({
    apps: db().prepare(`SELECT app, source, COUNT(*) AS count, MAX(posted_at) AS latest FROM notifications WHERE deleted_at IS NULL
                        GROUP BY app, source ORDER BY latest DESC`).all(),
  }));

  app.get("/api/notifications", async (req) => {
    const q = req.query as { app?: string; page?: string; pageSize?: string };
    const pageSize = int(q.pageSize, 50, 1, 500), page = int(q.page, 1, 1, 1e9);
    const d = TYPE_DEFS.notification;
    const where = ["x.deleted_at IS NULL"]; const args: unknown[] = [];
    if (q.app) { where.push("lower(x.app) = lower(?)"); args.push(q.app); }
    const w = where.join(" AND ");
    const total = (db().prepare(`SELECT COUNT(*) AS n FROM notifications x WHERE ${w}`).get(...args) as { n: number }).n;
    const rows = db().prepare(`SELECT ${selectList(d)} FROM ${d.from} WHERE ${w} ORDER BY x.posted_at DESC, x.rid DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize) as BaseItem[];
    return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), items: enrich(svc.ctx, rows).map(itemView) };
  });

  app.get("/api/media", async (req) => {
    const q = req.query as { kind?: string; page?: string; pageSize?: string };
    const pageSize = int(q.pageSize, 60, 1, 500), page = int(q.page, 1, 1, 1e9);
    const kinds = q.kind === "screenshot" || q.kind === "photo" ? [q.kind] : ["screenshot", "photo"];
    const parts = kinds.map((k) => { const d = TYPE_DEFS[k as "screenshot" | "photo"]; return `SELECT ${selectList(d)} FROM ${d.from} WHERE x.deleted_at IS NULL AND ${d.where}`; });
    const union = parts.map((p) => `SELECT * FROM (${p})`).join(" UNION ALL ");
    const total = (db().prepare(`SELECT COUNT(*) AS n FROM (${union})`).get() as { n: number }).n;
    const rows = db().prepare(`SELECT * FROM (${union}) ORDER BY event_time DESC, rid DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as BaseItem[];
    const ocr = new Map<string, string | null>();
    if (rows.length) {
      for (const r of db().prepare(`SELECT id, substr(ocr_text, 1, 4000) AS t FROM media WHERE id IN (${rows.map(() => "?").join(",")})`).all(...rows.map((r) => r.id)) as Array<{ id: string; t: string | null }>) ocr.set(r.id, r.t);
    }
    return {
      total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
      items: enrich(svc.ctx, rows).map(itemView).map((it) => ({ ...it, ocrText: ocr.get(it.id) ?? null })),
    };
  });

  app.get("/api/media/:id/origin", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const m = db().prepare("SELECT id, sha256, attachment_id FROM media WHERE id = ?").get(id) as { id: string; sha256: string | null; attachment_id: string | null } | undefined;
    if (!m) return reply.status(404).send({ error: "not_found", message: "no such media" });
    const att = (where: string, arg: unknown) => db().prepare(`
      SELECT a.id AS attachmentId, a.filename, a.kind, ${attachmentStatusSql("a")} AS status, m.id AS messageId, m.sender, m.sent_at AS sentAt,
             c.id AS conversationId, c.platform, c.account, c.peer
      FROM attachments a JOIN messages m ON m.id = a.message_id JOIN conversations c ON c.id = m.conversation_id
      WHERE a.deleted_at IS NULL AND ${where}`).all(arg) as Array<Record<string, unknown>>;
    const evidenced: Array<Record<string, unknown>> = [];
    if (m.attachment_id) for (const r of att("a.id = ?", m.attachment_id)) evidenced.push({ ...r, evidence: "linked attachment record" });
    if (m.sha256) {
      for (const r of att("a.origin_hash = ?", m.sha256)) {
        if (!evidenced.some((e) => e.attachmentId === r.attachmentId)) evidenced.push({ ...r, evidence: "identical content hash" });
      }
    }
    // Inferred links (time/sender proximity, visual similarity) are not computed yet; none are invented.
    return { mediaId: id, evidenced, inferred: [] as unknown[], inferenceAvailable: false };
  });

  app.get("/api/facets", async () => {
    const devices = db().prepare("SELECT id, role, fingerprint FROM devices ORDER BY paired_at").all();
    const apps = (db().prepare(`SELECT DISTINCT app FROM (
        SELECT platform AS app FROM conversations WHERE deleted_at IS NULL
        UNION SELECT app FROM notifications WHERE deleted_at IS NULL
        UNION SELECT app FROM usage_events WHERE deleted_at IS NULL) WHERE app IS NOT NULL ORDER BY lower(app) LIMIT 500`).all() as Array<{ app: string }>).map((r) => r.app);
    const accounts = (db().prepare("SELECT DISTINCT account FROM conversations WHERE deleted_at IS NULL ORDER BY account LIMIT 500").all() as Array<{ account: string }>).map((r) => r.account);
    const conversations = db().prepare("SELECT id, platform, account, COALESCE(peer, conv_key) AS name FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500").all();
    return { devices, apps, accounts, conversations };
  });

  app.get("/api/ui-settings", async () => ({ settings: readUiSettings(svc), keys: UI_SETTINGS }));
  app.put("/api/ui-settings", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(b)) {
      const t = UI_SETTINGS[k];
      if (!t) return reply.status(400).send({ error: "bad_key", message: `unknown setting ${k}` });
      if (typeof v !== t) return reply.status(400).send({ error: "bad_value", message: `${k} must be a ${t}` });
    }
    for (const [k, v] of Object.entries(b)) setSetting(svc.ctx.db, `ui.${k}`, String(v));
    return { settings: readUiSettings(svc) };
  });
}
