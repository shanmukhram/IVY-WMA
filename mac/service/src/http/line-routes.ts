/**
 * Read-only routes for the LINE settings page: the user's own LINE account state the
 * line_account snapshot captured. Registered from server.ts with one line, so they sit
 * behind the same guards as every other content route (token, loopback Host, same-site
 * Origin, 423 while locked).
 *
 *   GET /api/views/line/account?account=
 *       the own profile and the counts (contacts, hidden chats, blocked contacts, settings)
 *   GET /api/views/line/contacts?account=&filter=all|blocked
 *       the contact list; filter=blocked keeps only the contacts the record marked blocked
 *   GET /api/views/line/hidden?account=
 *       the hidden chats, joined to the conversation for a title and avatar
 *   GET /api/views/line/settings?account=
 *       the app settings, sorted by key
 *   GET /api/views/line/contacts/:mid/avatar?account=   the contact picture bytes
 *   GET /api/views/line/profile/avatar?account=         the own-profile picture bytes
 *
 * The raw store status/settings are returned as given; blocked is the record's own value
 * (1, 0 or null = unknown), never a guess (the blocked list is empty until a real value sets it).
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Service } from "../service.ts";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

function sendPicture(reply: FastifyReply, path: string | null | undefined): FastifyReply {
  if (!path || !existsSync(path)) return reply.status(404).send({ error: "not_available", message: "no local copy" });
  const st = statSync(path);
  reply.header("content-type", MIME[extname(path).toLowerCase()] ?? "application/octet-stream");
  reply.header("content-length", st.size);
  reply.header("cache-control", "private, max-age=300");
  reply.header("x-content-type-options", "nosniff");
  reply.header("content-security-policy", "sandbox");
  return reply.send(createReadStream(path));
}

export function registerLineRoutes(app: FastifyInstance, svc: Service): void {
  const db = () => svc.ctx.db;

  /** The account asked for, or the single LINE account present when none is given. */
  const resolveAccount = (asked: string | undefined): string | null => {
    if (asked) return asked;
    const rows = db().prepare(`SELECT account FROM (
        SELECT account FROM line_account_profile UNION SELECT account FROM line_contacts
        UNION SELECT account FROM line_chat_options UNION SELECT account FROM line_settings)
      ORDER BY account`).all() as Array<{ account: string }>;
    return rows.length ? rows[0]!.account : null;
  };

  const profileAvatarUrl = (account: string, hasPicture: boolean) =>
    hasPicture ? `/api/views/line/profile/avatar?account=${encodeURIComponent(account)}` : null;
  const contactAvatarUrl = (account: string, mid: string, hasPicture: boolean) =>
    hasPicture ? `/api/views/line/contacts/${encodeURIComponent(mid)}/avatar?account=${encodeURIComponent(account)}` : null;

  app.get("/api/views/line/account", async (req) => {
    const account = resolveAccount((req.query as { account?: string }).account);
    if (!account) return { account: null, profile: null, counts: { contacts: 0, hidden: 0, blocked: 0, settings: 0 } };
    const p = db().prepare(`SELECT mid, display_name AS displayName, user_id AS userId, status_message AS statusMessage, picture_local_path AS picture
                            FROM line_account_profile WHERE account = ?`).get(account) as
      { mid: string; displayName: string | null; userId: string | null; statusMessage: string | null; picture: string | null } | undefined;
    const counts = {
      contacts: (db().prepare("SELECT COUNT(*) AS n FROM line_contacts WHERE account = ?").get(account) as { n: number }).n,
      hidden: (db().prepare("SELECT COUNT(*) AS n FROM line_chat_options WHERE account = ? AND hidden = 1").get(account) as { n: number }).n,
      blocked: (db().prepare("SELECT COUNT(*) AS n FROM line_contacts WHERE account = ? AND blocked = 1").get(account) as { n: number }).n,
      settings: (db().prepare("SELECT COUNT(*) AS n FROM line_settings WHERE account = ?").get(account) as { n: number }).n,
    };
    return {
      account,
      profile: p ? { mid: p.mid, displayName: p.displayName, userId: p.userId, statusMessage: p.statusMessage, avatarUrl: profileAvatarUrl(account, !!p.picture) } : null,
      counts,
    };
  });

  app.get("/api/views/line/contacts", async (req) => {
    const q = req.query as { account?: string; filter?: string };
    const account = resolveAccount(q.account);
    if (!account) return [];
    const onlyBlocked = q.filter === "blocked";
    const rows = db().prepare(`SELECT mid, display_name AS displayName, status, type, settings, blocked, status_message AS statusMessage, picture_local_path AS picture
                               FROM line_contacts WHERE account = ?${onlyBlocked ? " AND blocked = 1" : ""}
                               ORDER BY display_name IS NULL, display_name, mid`).all(account) as Array<{
      mid: string; displayName: string | null; status: string | null; type: string | null; settings: number | null;
      blocked: number | null; statusMessage: string | null; picture: string | null;
    }>;
    return rows.map((c) => ({
      mid: c.mid, displayName: c.displayName, status: c.status, type: c.type, settings: c.settings,
      blocked: c.blocked === null ? null : c.blocked === 1, statusMessage: c.statusMessage,
      avatarUrl: contactAvatarUrl(account, c.mid, !!c.picture),
    }));
  });

  app.get("/api/views/line/hidden", async (req) => {
    const account = resolveAccount((req.query as { account?: string }).account);
    if (!account) return [];
    const rows = db().prepare(`
      SELECT o.chat_id AS chatId, c.id AS convId, c.chat_title AS chatTitle, c.peer AS peer, c.avatar_local_path AS avatarLocalPath,
             (SELECT MAX(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS lastAt
      FROM line_chat_options o
      LEFT JOIN conversations c ON c.platform = 'line' AND c.conv_key = o.chat_id AND c.deleted_at IS NULL
      WHERE o.account = ? AND o.hidden = 1
      ORDER BY lastAt IS NULL, lastAt DESC, o.chat_id`).all(account) as Array<{
      chatId: string; convId: string | null; chatTitle: string | null; peer: string | null; avatarLocalPath: string | null; lastAt: string | null;
    }>;
    return rows.map((r) => ({
      chatId: r.chatId,
      title: r.chatTitle || r.peer || r.chatId,
      avatarUrl: r.convId && r.avatarLocalPath ? `/api/views/chats/${r.convId}/avatar` : null,
      lastAt: r.lastAt,
    }));
  });

  app.get("/api/views/line/settings", async (req) => {
    const account = resolveAccount((req.query as { account?: string }).account);
    if (!account) return [];
    return db().prepare("SELECT key, value FROM line_settings WHERE account = ? ORDER BY key").all(account) as Array<{ key: string; value: string }>;
  });

  app.get("/api/views/line/profile/avatar", async (req, reply) => {
    const account = resolveAccount((req.query as { account?: string }).account);
    const row = account ? db().prepare("SELECT picture_local_path AS p FROM line_account_profile WHERE account = ?").get(account) as { p: string | null } | undefined : undefined;
    return sendPicture(reply, row?.p);
  });

  app.get("/api/views/line/contacts/:mid/avatar", async (req, reply) => {
    const account = resolveAccount((req.query as { account?: string }).account);
    const mid = (req.params as { mid: string }).mid;
    const row = account ? db().prepare("SELECT picture_local_path AS p FROM line_contacts WHERE account = ? AND mid = ?").get(account, mid) as { p: string | null } | undefined : undefined;
    return sendPicture(reply, row?.p);
  });
}
