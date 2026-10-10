/**
 * Versioned migrations for ./data/vault.db. Append only: never edit a shipped
 * migration, add a new one.
 *
 * Conventions
 * - Every content table has an explicit `rid INTEGER PRIMARY KEY` (stable rowid
 *   for the FTS5 external-content tables; an implicit rowid can be renumbered by
 *   VACUUM) and a uuid `id` (the API identity, as in the PRD data model).
 * - Every content table has a nullable `deleted_at` (recovery bin, B1). Deletion
 *   at the source is a different column (`source_status`, B4), never deleted_at.
 * - Original event times (`sent_at`, `posted_at`, `taken_at`, `started_at`,
 *   `mtime`) and our own times (`captured_at`, `imported_at`, `ingested_at`) are
 *   always separate columns (PRD T4/M7).
 * - FTS5 tables use the trigram tokenizer: substring matches of 3+ characters,
 *   case-insensitive, diacritics folded. Triggers keep them in sync, so a
 *   permanent DELETE of a row removes its index entries (B3).
 */
export interface Migration { version: number; name: string; sql: string }

/** Build insert/delete/update triggers for an external-content FTS5 table. */
function ftsTriggers(table: string, fts: string, cols: string[]): string {
  const list = cols.join(", ");
  const nv = cols.map((c) => `new.${c}`).join(", ");
  const ov = cols.map((c) => `old.${c}`).join(", ");
  return `
CREATE TRIGGER ${table}_fts_ai AFTER INSERT ON ${table} BEGIN
  INSERT INTO ${fts}(rowid, ${list}) VALUES (new.rid, ${nv});
END;
CREATE TRIGGER ${table}_fts_ad AFTER DELETE ON ${table} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${list}) VALUES ('delete', old.rid, ${ov});
END;
CREATE TRIGGER ${table}_fts_au AFTER UPDATE OF ${list} ON ${table} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${list}) VALUES ('delete', old.rid, ${ov});
  INSERT INTO ${fts}(rowid, ${list}) VALUES (new.rid, ${nv});
END;`;
}

const TRIGRAM = "tokenize = 'trigram remove_diacritics 1'";

function fts(table: string, cols: string[]): string {
  return `
CREATE VIRTUAL TABLE ${table}_fts USING fts5(${cols.join(", ")}, content='${table}', content_rowid='rid', ${TRIGRAM});
${ftsTriggers(table, `${table}_fts`, cols)}`;
}

export const FTS_TABLES = {
  messages: ["text"],
  notifications: ["title", "sender", "preview"],
  media: ["ocr_text", "source_path"],
  files: ["name", "path"],
  usage_events: ["title", "app"],
  calls: ["contact", "number"],
} as const;

const v1 = `
-- ---------------------------------------------------------------- devices & protocol state
CREATE TABLE devices (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,                 -- device id (uuid chosen by the device)
  role TEXT NOT NULL CHECK (role IN ('windows','android')),
  public_key TEXT NOT NULL,                -- base64 X25519, for encrypting commands to it
  fingerprint TEXT NOT NULL,
  pairing_id TEXT,
  paired_at TEXT NOT NULL,
  last_seen TEXT,                          -- last committed object from this device
  last_report_at TEXT,                     -- reportedAt of the newest device_report
  app_version TEXT,
  queue_depth_total INTEGER
);

CREATE TABLE pairings (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,                 -- pairingId (hex)
  role TEXT NOT NULL CHECK (role IN ('windows','android')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','consumed','expired','cancelled')),
  device_id TEXT,
  consumed_at TEXT,
  bootstrap_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_objects (               -- the ingest ledger (S3)
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id TEXT,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','committed','quarantined')),
  ingested_at TEXT NOT NULL,
  size INTEGER,
  ct_sha256 TEXT,                          -- of the ciphertext: tells a replay from an overwrite
  detail TEXT,
  UNIQUE (bucket, object_key)
);
CREATE INDEX sync_objects_kind ON sync_objects(kind, ingested_at);

CREATE TABLE quarantine (                 -- S4: never stalls the queue
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  bucket TEXT NOT NULL,
  role TEXT NOT NULL,
  object_key TEXT NOT NULL,
  kind TEXT,
  device_id TEXT,
  reason TEXT NOT NULL,
  size INTEGER,
  ct_sha256 TEXT,
  stored_path TEXT,                        -- ciphertext kept under data/quarantine (it is still encrypted)
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX quarantine_open ON quarantine(resolved_at, created_at);

CREATE TABLE blobs (                      -- chunked-object assembly (S5, PROTOCOL §2.2)
  rid INTEGER PRIMARY KEY,
  oid TEXT NOT NULL,
  bucket TEXT NOT NULL,
  role TEXT NOT NULL,                      -- role of the up-bucket it arrived in
  device_id TEXT,                          -- learned from the record that references the blob
  status TEXT NOT NULL CHECK (status IN ('awaiting_manifest','assembling','complete','quarantined')),
  payload_kind TEXT,
  total_size INTEGER,
  chunk_size INTEGER,
  total_chunks INTEGER,
  manifest_env BLOB,                       -- the manifest ENVELOPE (ciphertext); the CEK never sits in the db in clear
  committed_parts TEXT NOT NULL DEFAULT '[]',
  committed_bytes INTEGER NOT NULL DEFAULT 0,
  tmp_path TEXT,
  local_path TEXT,
  ext TEXT,
  sha256 TEXT,                             -- of the reassembled plaintext
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  detail TEXT,
  UNIQUE (bucket, oid)
);
CREATE INDEX blobs_oid ON blobs(oid);

CREATE TABLE collector_state (            -- latest device_report per collector
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  last_run_at TEXT,
  cursor TEXT,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL,
  first_reported_at TEXT NOT NULL,
  PRIMARY KEY (device_id, name)
);

CREATE TABLE collector_history (          -- one row whenever last_run_at / enabled changes; feeds timeline gaps
  rid INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  last_run_at TEXT,
  enabled INTEGER NOT NULL,
  queue_depth INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX collector_history_dev ON collector_history(device_id, name, reported_at);

CREATE TABLE commands (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,                 -- commandId
  device_id TEXT NOT NULL,
  oid TEXT NOT NULL,
  object_key TEXT NOT NULL,                -- cmd/<oid> in the device's cmd-bucket
  type TEXT NOT NULL,
  params TEXT NOT NULL,                    -- JSON
  file_id TEXT,                            -- vault files.id for file_request
  status TEXT NOT NULL CHECK (status IN ('queued','sent','uploaded','done','not_found','access_denied','too_large','error','expired','cancelled')),
  detail TEXT,
  result_oid TEXT,
  issued_at TEXT NOT NULL,
  sent_at TEXT,
  status_at TEXT,
  completed_at TEXT,
  cmd_deleted INTEGER NOT NULL DEFAULT 0,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX commands_status ON commands(status, issued_at);
CREATE INDEX commands_result ON commands(result_oid);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE activity (
  rid INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);

-- ---------------------------------------------------------------- content
CREATE TABLE conversations (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id TEXT,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  conv_key TEXT NOT NULL,
  peer TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('dm','group')),
  coverage TEXT NOT NULL CHECK (coverage IN ('complete','partial','notification_only')),
  cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch TEXT,                      -- one id per delete operation (cascade restore)
  UNIQUE (platform, account, conv_key)
);

CREATE TABLE messages (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  device_id TEXT,
  msg_key TEXT NOT NULL,                   -- the platform's message id
  sender TEXT NOT NULL,
  sent_at TEXT NOT NULL,                   -- original message time (the phone's truth)
  captured_at TEXT NOT NULL,               -- when the vault learned of it
  text TEXT NOT NULL,
  reply_to TEXT,                           -- messages.id, when resolved
  reply_to_key TEXT,                       -- the platform id it replies to
  edited_at TEXT,
  source_status TEXT NOT NULL DEFAULT 'live' CHECK (source_status IN ('live','deleted_at_source')),
  deleted_at TEXT,
  deleted_batch TEXT,                      -- one id per delete operation (cascade restore)
  UNIQUE (conversation_id, msg_key)
);
CREATE INDEX messages_sent ON messages(sent_at);
CREATE INDEX messages_conv ON messages(conversation_id, sent_at);

CREATE TABLE message_edits (              -- C3: prior versions of edited messages
  rid INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  edited_at TEXT,
  recorded_at TEXT NOT NULL
);

CREATE TABLE attachments (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  att_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','audio','doc')),
  filename TEXT NOT NULL,
  size INTEGER,
  origin_hash TEXT,
  blob_oid TEXT,
  status TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('indexed','cached','on_demand')),
  local_path TEXT,
  deleted_at TEXT,
  deleted_batch TEXT,                      -- one id per delete operation (cascade restore)
  UNIQUE (message_id, att_key)
);
CREATE INDEX attachments_blob ON attachments(blob_oid);

CREATE TABLE notifications (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('windows','android')),
  app TEXT NOT NULL,
  title TEXT,
  sender TEXT,
  preview TEXT,                            -- a partial record (N4)
  notif_key TEXT,
  posted_at TEXT NOT NULL,                 -- when the device showed it
  captured_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  linked_message_id TEXT,
  link_confidence TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  deleted_at TEXT,
  deleted_batch TEXT                       -- one id per delete operation (cascade restore)
);
CREATE INDEX notifications_posted ON notifications(posted_at);

CREATE TABLE media (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot','photo')),
  source_path TEXT,                        -- original location on the device
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  blob_oid TEXT UNIQUE,
  local_path TEXT,                         -- the original, once its blob is reassembled
  taken_at TEXT,                           -- capture time
  saved_at TEXT,                           -- file-save time
  captured_at TEXT NOT NULL,               -- when the device observed it
  imported_at TEXT NOT NULL,               -- when the vault committed it
  ocr_text TEXT,
  ocr_status TEXT NOT NULL DEFAULT 'pending' CHECK (ocr_status IN ('pending','done','failed','unavailable')),
  thumb_path TEXT,
  attachment_id TEXT,
  deleted_at TEXT,
  deleted_batch TEXT                       -- one id per delete operation (cascade restore)
);
CREATE INDEX media_taken ON media(taken_at);

CREATE TABLE files (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  path TEXT NOT NULL,                      -- on the source device
  name TEXT NOT NULL,
  ext TEXT,
  size INTEGER,
  mtime TEXT,
  quick_hash TEXT,
  status TEXT NOT NULL DEFAULT 'reference' CHECK (status IN ('reference','cached')),
  source_status TEXT NOT NULL DEFAULT 'live' CHECK (source_status IN ('live','deleted_at_source')),
  source_deleted_at TEXT,
  thumb_blob_oid TEXT,
  thumb_path TEXT,
  local_path TEXT,
  event_time TEXT NOT NULL,                -- eventTime of the newest applied file_meta
  captured_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch TEXT,                      -- one id per delete operation (cascade restore)
  UNIQUE (device_id, path)
);
CREATE INDEX files_mtime ON files(mtime);
CREATE INDEX files_thumb ON files(thumb_blob_oid);

CREATE TABLE calls (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing','missed')),
  contact TEXT,
  number TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch TEXT,                      -- one id per delete operation (cascade restore)
  UNIQUE (device_id, number, started_at, direction)
);
CREATE INDEX calls_started ON calls(started_at);

CREATE TABLE usage_events (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  app TEXT NOT NULL,
  exe TEXT,
  title TEXT,                              -- nullable; Windows only, per setting
  title_state TEXT NOT NULL CHECK (title_state IN ('captured','excluded','not_captured')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch TEXT,                      -- one id per delete operation (cascade restore)
  UNIQUE (device_id, app, started_at)
);
CREATE INDEX usage_started ON usage_events(started_at);

-- ---------------------------------------------------------------- full-text search
${Object.entries(FTS_TABLES).map(([t, cols]) => fts(t, [...cols])).join("\n")}

-- One normalised row per searchable / timeline item. event_time is the item's
-- original time; time_field names which column it came from (never captured_at
-- unless the source gave no time at all, and then time_field says so).
CREATE VIEW items AS
  SELECT 'message' AS type, m.rid, m.id, COALESCE(m.device_id, c.device_id) AS device_id, c.platform AS app,
         m.sent_at AS event_time, 'sent_at' AS time_field, m.captured_at,
         COALESCE(c.peer, c.conv_key) AS title, m.text AS body, m.sender AS person,
         m.conversation_id AS conversation_id, c.account AS account, m.source_status AS source_status, m.deleted_at
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
  UNION ALL
  SELECT 'notification', n.rid, n.id, n.device_id, n.app, n.posted_at, 'posted_at', n.captured_at,
         n.title, n.preview, n.sender, NULL, NULL, 'live', n.deleted_at
    FROM notifications n
  UNION ALL
  SELECT md.kind, md.rid, md.id, md.device_id, NULL,
         COALESCE(md.taken_at, md.saved_at, md.captured_at),
         CASE WHEN md.taken_at IS NOT NULL THEN 'taken_at' WHEN md.saved_at IS NOT NULL THEN 'saved_at' ELSE 'captured_at' END,
         md.captured_at, md.source_path, md.ocr_text, NULL, NULL, NULL, 'live', md.deleted_at
    FROM media md
  UNION ALL
  SELECT 'file', f.rid, f.id, f.device_id, NULL, COALESCE(f.mtime, f.event_time),
         CASE WHEN f.mtime IS NOT NULL THEN 'mtime' ELSE 'event_time' END,
         f.captured_at, f.name, f.path, NULL, NULL, NULL, f.source_status, f.deleted_at
    FROM files f
  UNION ALL
  SELECT 'usage', u.rid, u.id, u.device_id, u.app, u.started_at, 'started_at', u.captured_at,
         u.app, u.title, NULL, NULL, NULL, 'live', u.deleted_at
    FROM usage_events u
  UNION ALL
  SELECT 'call', cl.rid, cl.id, cl.device_id, NULL, cl.started_at, 'started_at', cl.captured_at,
         cl.contact, cl.number, cl.contact, NULL, NULL, 'live', cl.deleted_at
    FROM calls cl;
`;

// v2: import progress from device_report (PROTOCOL §6 importTotal/importDone/phase);
// manifest commandId (§2.2): blobs remember the command they answer and commands get
// a 'transferring' status while its parts arrive (the CHECK needs a table rebuild).
const v2 = `
ALTER TABLE collector_state ADD COLUMN import_total INTEGER;
ALTER TABLE collector_state ADD COLUMN import_done INTEGER;
ALTER TABLE collector_state ADD COLUMN phase TEXT;
ALTER TABLE blobs ADD COLUMN command_id TEXT;

CREATE TABLE commands_v2 (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,                 -- commandId
  device_id TEXT NOT NULL,
  oid TEXT NOT NULL,
  object_key TEXT NOT NULL,                -- cmd/<oid> in the device's cmd-bucket
  type TEXT NOT NULL,
  params TEXT NOT NULL,                    -- JSON
  file_id TEXT,                            -- vault files.id for file_request
  status TEXT NOT NULL CHECK (status IN ('queued','sent','transferring','uploaded','done','not_found','access_denied','too_large','error','expired','cancelled')),
  detail TEXT,
  result_oid TEXT,
  issued_at TEXT NOT NULL,
  sent_at TEXT,
  status_at TEXT,
  completed_at TEXT,
  cmd_deleted INTEGER NOT NULL DEFAULT 0,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT INTO commands_v2 SELECT * FROM commands;
DROP TABLE commands;
ALTER TABLE commands_v2 RENAME TO commands;
CREATE INDEX commands_status ON commands(status, issued_at);
CREATE INDEX commands_result ON commands(result_oid);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial vault schema", sql: v1 },
  { version: 2, name: "import progress, manifest commandId, transferring commands", sql: v2 },
];
