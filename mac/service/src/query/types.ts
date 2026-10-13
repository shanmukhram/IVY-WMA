/**
 * Per content-type query definitions shared by search, timeline and the
 * recovery bin. `x` is always the base table alias.
 */
export type ItemType = "message" | "notification" | "screenshot" | "photo" | "file" | "usage" | "call" | "browsing";
export const ITEM_TYPES: ItemType[] = ["message", "notification", "screenshot", "photo", "file", "usage", "call", "browsing"];

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
    // catalog entries (browse-only, not yet fetched) are excluded from search/timeline/record views;
    // a fetched one has local_path set and appears normally (see migration v9)
    type: "file", table: "files", fts: "files_fts", from: "files x", where: "(x.catalog = 0 OR x.local_path IS NOT NULL)",
    device: "x.device_id", app: null, time: "COALESCE(x.mtime, x.event_time)",
    timeField: "CASE WHEN x.mtime IS NOT NULL THEN 'mtime' ELSE 'event_time' END",
    title: "x.name", body: "x.path", person: null, conversation: null, account: null,
    text: ["x.name", "x.path", "x.content_text"],
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
  // S7: Google activity imported read-only from Activity Vault; no IVY device, `app` is the Google product
  browsing: {
    type: "browsing", table: "browsing_events", fts: "browsing_events_fts", from: "browsing_events x",
    device: "NULL", app: "x.product", time: "x.time", timeField: "'time'",
    title: "x.title", body: "COALESCE(x.subtitle, x.link)", person: null, conversation: null, account: null,
    text: ["x.title", "x.subtitle", "x.link"],
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

// ------------------------------------------------------------------ device scope
//
// One meaning of `device=<id|windows|android>` for every read API (the dashboard's global
// device scope):
//   - absent or empty: no restriction;
//   - "windows" / "android": every paired device of that role (a role with no paired device
//     matches nothing, so the view is honestly empty rather than unfiltered);
//   - anything else: a device id, matched exactly (an unknown id matches nothing).
// A message is in scope when its own device (messages.device_id, else the conversation's) is,
// or when any source that delivered it (message_sources.device_id) is. A conversation is in
// scope when at least one of its live messages is. Records with no device (Activity Vault
// browsing) are never in a device scope.

export const DEVICE_ROLES = ["windows", "android"] as const;
export const isDeviceRole = (v: string): v is (typeof DEVICE_ROLES)[number] => (DEVICE_ROLES as readonly string[]).includes(v);

export interface Scoped { sql: string; args: unknown[] }

/** The device scope as a predicate on a SQL expression that yields a device id; null when unscoped. */
export function deviceScope(col: string, device: string | undefined | null): Scoped | null {
  if (!device) return null;
  if (isDeviceRole(device)) return { sql: `${col} IN (SELECT id FROM devices WHERE role = ?)`, args: [device] };
  return { sql: `${col} = ?`, args: [device] };
}

/** Message `m` (in conversation `c`) is in scope: its own device or any source's device. */
export function messageScope(m: string, c: string, device: string | undefined | null): Scoped | null {
  const own = deviceScope(`COALESCE(${m}.device_id, ${c}.device_id)`, device);
  const src = deviceScope("dss.device_id", device);
  if (!own || !src) return null;
  return {
    sql: `(${own.sql} OR EXISTS (SELECT 1 FROM message_sources dss WHERE dss.message_id = ${m}.id AND ${src.sql}))`,
    args: [...own.args, ...src.args],
  };
}

/** Conversation `c` is in scope: at least one of its live messages is. */
export function conversationScope(c: string, device: string | undefined | null): Scoped | null {
  const ms = messageScope("dsm", c, device);
  if (!ms) return null;
  return { sql: `EXISTS (SELECT 1 FROM messages dsm WHERE dsm.conversation_id = ${c}.id AND dsm.deleted_at IS NULL AND ${ms.sql})`, args: ms.args };
}

/** The device scope for one record type (`x` = its base alias; messages use `c` for the conversation). */
export function typeScope(d: TypeDef, device: string | undefined | null): Scoped | null {
  return d.type === "message" ? messageScope("x", "c", device) : deviceScope(d.device, device);
}

/** WHERE fragments for the common filters; types that lack a column are excluded by a false predicate. */
export function filterSql(d: TypeDef, f: Filters): { sql: string[]; args: unknown[] } {
  const sql: string[] = ["x.deleted_at IS NULL"];
  const args: unknown[] = [];
  if (d.where) sql.push(d.where);
  const scope = typeScope(d, f.device);
  if (scope) { sql.push(scope.sql); args.push(...scope.args); }
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
