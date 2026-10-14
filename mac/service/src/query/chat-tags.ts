/**
 * Chat tags: what the owner's own app says about a chat, shown on the chat itself.
 *
 * Two sources carry them:
 *   - conversations.listing, from each message batch's chatMeta: normal, archived (Telegram's
 *     Archive folder) or hidden. LINE for Windows sends normal for every chat (PLAN decision 16).
 *   - line_chat_options, from the LINE account snapshot: hidden, notification (off = muted) and
 *     pinned, read from LINE's own _chatOption table (commit 2021cf1).
 *
 * A chat's shown listing is hidden when either source says hidden, else the stored listing.
 * Muted and pinned come only from LINE's options; null means no source has said.
 *
 * A LINE chat can also appear only in the options: LINE knows it, but no message of it was
 * captured on the PC, so no conversation row exists. Those are returned as placeholder chats
 * (see optionOnlyChats), so every chat LINE lists is visible. A placeholder is shown only for an
 * account that has captured conversations, so an old or signed-out LINE account's leftover
 * options do not turn into chats.
 */
import type { DB } from "../db/index.ts";

/** LEFT JOIN of LINE's per-chat options onto conversation alias `c` (options alias `lo`). */
export const lineOptionsJoin = (c = "c") =>
  `LEFT JOIN line_chat_options lo ON ${c}.platform = 'line' AND lo.account = ${c}.account AND lo.chat_id = ${c}.conv_key`;

/** The shown listing of conversation `c` (needs lineOptionsJoin). */
export const listingSql = (c = "c") =>
  `CASE WHEN ${c}.listing = 'hidden' OR lo.hidden = 1 THEN 'hidden' ELSE ${c}.listing END`;

/** Columns to select for the tags of conversation `c` (needs lineOptionsJoin); read back with tagView. */
export const tagColumns = (c = "c") =>
  `${listingSql(c)} AS listing, lo.notification AS line_notification, lo.pinned AS line_pinned`;

/** A WHERE fragment for a listing filter on conversation `c`; null for "all". */
export function listingFilterSql(listing: string, c = "c"): { sql: string; args: unknown[] } | null {
  const l = listingSql(c);
  if (listing === "all") return null;
  // a conversation no source has given a listing for is shown as normal
  if (listing === "normal") return { sql: `(${l} IS NULL OR ${l} = 'normal')`, args: [] };
  return { sql: `${l} = ?`, args: [listing] };
}

const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) !== 0);

/** Turn the raw tag columns into { muted, pinned } and drop them from the row. */
export function tagView<T extends Record<string, unknown>>(row: T): T & { muted: boolean | null; pinned: boolean | null } {
  const { line_notification, line_pinned, ...rest } = row;
  const notify = bool(line_notification);
  return { ...(rest as T), muted: notify === null ? null : !notify, pinned: bool(line_pinned) };
}

/** The id the API gives a placeholder chat. */
export const placeholderId = (account: string, chatId: string) => `lineopt:${account}:${chatId}`;

export interface OptionOnlyFilter {
  /** Predicates on a conversation alias of the same account (scope, source, role), as for real chats. */
  accountConv?: (alias: string) => { sql: string[]; args: unknown[] };
  listing: string;
  q?: string;
}

/**
 * LINE chats that exist only in the options: no conversation row (live or in the recovery bin)
 * for that account and chat id, on an account with at least one captured conversation that
 * passes the same scope/source/role predicates as the real chats.
 */
function optionOnlyWhere(f: OptionOnlyFilter): { sql: string; args: unknown[] } {
  const acct = f.accountConv?.("c2") ?? { sql: [], args: [] };
  const where = [
    "NOT EXISTS (SELECT 1 FROM conversations c0 WHERE c0.platform = 'line' AND c0.account = lo.account AND c0.conv_key = lo.chat_id)",
    `EXISTS (SELECT 1 FROM conversations c2 WHERE c2.platform = 'line' AND c2.account = lo.account AND c2.deleted_at IS NULL${acct.sql.map((s) => ` AND ${s}`).join("")})`,
  ];
  const args: unknown[] = [...acct.args];
  if (f.listing === "hidden") where.push("lo.hidden = 1");
  else if (f.listing === "normal") where.push("COALESCE(lo.hidden, 0) = 0");
  else if (f.listing === "archived") where.push("0"); // LINE has no archive
  const text = f.q?.trim();
  if (text) {
    where.push(`(instr(lower(lo.chat_id), lower(?)) > 0 OR instr(lower(COALESCE((SELECT lc.display_name FROM line_contacts lc
                 WHERE lc.account = lo.account AND lc.mid = lo.chat_id), '')), lower(?)) > 0)`);
    args.push(text, text);
  }
  return { sql: where.join(" AND "), args };
}

export function countOptionOnlyChats(db: DB, f: OptionOnlyFilter): number {
  const w = optionOnlyWhere(f);
  return (db.prepare(`SELECT COUNT(*) AS n FROM line_chat_options lo WHERE ${w.sql}`).get(...w.args) as { n: number }).n;
}

/** One page of placeholder chats, in a stable order (account, then chat id). */
export function optionOnlyChats(db: DB, f: OptionOnlyFilter, limit: number, offset: number) {
  if (limit <= 0) return [];
  const w = optionOnlyWhere(f);
  const rows = db.prepare(`
    SELECT lo.account, lo.chat_id AS chatId, lo.hidden, lo.notification, lo.pinned,
           (SELECT lc.display_name FROM line_contacts lc WHERE lc.account = lo.account AND lc.mid = lo.chat_id) AS contactName,
           (SELECT c3.device_id FROM conversations c3 WHERE c3.platform = 'line' AND c3.account = lo.account AND c3.deleted_at IS NULL
              AND c3.device_id IS NOT NULL ORDER BY c3.rid LIMIT 1) AS deviceId
    FROM line_chat_options lo WHERE ${w.sql}
    ORDER BY lo.account, lo.chat_id LIMIT ? OFFSET ?`).all(...w.args, limit, offset) as Array<{
    account: string; chatId: string; hidden: number | null; notification: number | null; pinned: number | null; contactName: string | null; deviceId: string | null;
  }>;
  return rows.map((r) => {
    const notify = bool(r.notification);
    return {
      id: placeholderId(r.account, r.chatId),
      placeholder: true as const,
      deviceId: r.deviceId, platform: "line", account: r.account, convKey: r.chatId, peer: null,
      kind: null, coverage: null, coverageSources: [], coverageBySource: {},
      coverageText: "LINE lists this chat, but no message of it was captured on this PC.",
      chatTitle: null, participantCount: null, chatType: null,
      listing: r.hidden === 1 ? "hidden" : "normal",
      muted: notify === null ? null : !notify, pinned: bool(r.pinned),
      messageCount: 0, firstMessageAt: null, lastMessageAt: null, lastMessage: null,
      title: r.contactName?.trim() || r.chatId,
      avatarUrl: null, lastText: null, lastAt: null, source: null,
    };
  });
}
