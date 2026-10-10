/**
 * Per content-type query definitions shared by search, timeline and the
 * recovery bin. `x` is always the base table alias.
 */
export type ItemType = "message" | "notification" | "screenshot" | "photo" | "file" | "usage" | "call";
export const ITEM_TYPES: ItemType[] = ["message", "notification", "screenshot", "photo", "file", "usage", "call"];

export interface TypeDef {
  type: ItemType;
  table: string;
  fts: string;
  from: string;
  where?: string;
  device: string;
  app: string | null;
  time: string;
  timeField: string;
  title: string;
  body: string;
  person: string | null;
  conversation: string | null;
  account: string | null;
  /** columns searched (LIKE fallback for 1-2 character terms, typo check) */
  text: string[];
}

export const TYPE_DEFS: Record<ItemType, TypeDef> = {
  message: {
    type: "message", table: "messages", fts: "messages_fts",
    from: "messages x JOIN conversations c ON c.id = x.conversation_id",
    device: "COALESCE(x.device_id, c.device_id)", app: "c.platform", time: "x.sent_at", timeField: "'sent_at'",
    title: "COALESCE(c.peer, c.conv_key)", body: "x.text", person: "x.sender", conversation: "x.conversation_id", account: "c.account",
    text: ["x.text"],
  },
  notification: {
    type: "notification", table: "notifications", fts: "notifications_fts", from: "notifications x",
    device: "x.device_id", app: "x.app", time: "x.posted_at", timeField: "'posted_at'",
    title: "x.title", body: "x.preview", person: "x.sender", conversation: null, account: null,
    text: ["x.title", "x.sender", "x.preview"],
  },
  screenshot: {
    type: "screenshot", table: "media", fts: "media_fts", from: "media x", where: "x.kind = 'screenshot'",
    device: "x.device_id", app: null, time: "COALESCE(x.taken_at, x.saved_at, x.captured_at)",
    timeField: "CASE WHEN x.taken_at IS NOT NULL THEN 'taken_at' WHEN x.saved_at IS NOT NULL THEN 'saved_at' ELSE 'captured_at' END",
    title: "x.source_path", body: "x.ocr_text", person: null, conversation: null, account: null,
    text: ["x.ocr_text", "x.source_path"],
  },
  photo: {
    type: "photo", table: "media", fts: "media_fts", from: "media x", where: "x.kind = 'photo'",
    device: "x.device_id", app: null, time: "COALESCE(x.taken_at, x.saved_at, x.captured_at)",
    timeField: "CASE WHEN x.taken_at IS NOT NULL THEN 'taken_at' WHEN x.saved_at IS NOT NULL THEN 'saved_at' ELSE 'captured_at' END",
    title: "x.source_path", body: "x.ocr_text", person: null, conversation: null, account: null,
    text: ["x.ocr_text", "x.source_path"],
  },
  file: {
    type: "file", table: "files", fts: "files_fts", from: "files x",
    device: "x.device_id", app: null, time: "COALESCE(x.mtime, x.event_time)",
    timeField: "CASE WHEN x.mtime IS NOT NULL THEN 'mtime' ELSE 'event_time' END",
    title: "x.name", body: "x.path", person: null, conversation: null, account: null,
    text: ["x.name", "x.path"],
  },
  usage: {
    type: "usage", table: "usage_events", fts: "usage_events_fts", from: "usage_events x",
    device: "x.device_id", app: "x.app", time: "x.started_at", timeField: "'started_at'",
    title: "x.app", body: "x.title", person: null, conversation: null, account: null,
    text: ["x.title", "x.app"],
  },
  call: {
    type: "call", table: "calls", fts: "calls_fts", from: "calls x",
    device: "x.device_id", app: null, time: "x.started_at", timeField: "'started_at'",
    title: "x.contact", body: "x.number", person: "x.contact", conversation: null, account: null,
    text: ["x.contact", "x.number"],
  },
};

/** Normalised select list (same column order for every type, so results can be UNIONed). */
export function selectList(d: TypeDef): string {
  return `'${d.type}' AS type, x.rid AS rid, x.id AS id, ${d.device} AS device_id, ${d.app ?? "NULL"} AS app,
          ${d.time} AS event_time, ${d.timeField} AS time_field, x.captured_at AS captured_at,
          ${d.title} AS title, substr(COALESCE(${d.body}, ''), 1, 400) AS body, ${d.person ?? "NULL"} AS person`;
}

export interface Filters {
  device?: string;        // device id or role
  app?: string;
  from?: string;
  to?: string;
  person?: string;
  conversation?: string;
  account?: string;
}

/** WHERE fragments for the common filters; types that lack a column are excluded by a false predicate. */
export function filterSql(d: TypeDef, f: Filters): { sql: string[]; args: unknown[] } {
  const sql: string[] = ["x.deleted_at IS NULL"];
  const args: unknown[] = [];
  if (d.where) sql.push(d.where);
  if (f.device) {
    if (f.device === "windows" || f.device === "android") {
      sql.push(`${d.device} IN (SELECT id FROM devices WHERE role = ?)`);
    } else sql.push(`${d.device} = ?`);
    args.push(f.device);
  }
  if (f.app) {
    if (!d.app) sql.push("0");
    else { sql.push(`lower(${d.app}) = lower(?)`); args.push(f.app); }
  }
  if (f.from) { sql.push(`${d.time} >= ?`); args.push(f.from); }
  if (f.to) { sql.push(`${d.time} < ?`); args.push(f.to); }
  if (f.person) {
    if (!d.person) sql.push("0");
    else { sql.push(`instr(lower(COALESCE(${d.person}, '')), lower(?)) > 0`); args.push(f.person); }
  }
  if (f.conversation) {
    if (!d.conversation) sql.push("0");
    else { sql.push(`${d.conversation} = ?`); args.push(f.conversation); }
  }
  if (f.account) {
    if (!d.account) sql.push("0");
    else { sql.push(`${d.account} = ?`); args.push(f.account); }
  }
  return { sql, args };
}
