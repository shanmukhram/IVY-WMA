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

// v3: Activity Vault import (S7: browsing_events + FTS, import runs, purge tombstones),
// AI layer (A1-A3: ai_conversations, soft-delete aware) and embeddings (M4/Q6).
const v3 = `
CREATE TABLE browsing_events (            -- read-only import from Activity Vault (S7)
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('activity_vault')),
  source_key TEXT NOT NULL,                -- the source's row id, else sha256(time|product|title|link)
  time TEXT NOT NULL,                      -- original activity time (as the source recorded it)
  product TEXT NOT NULL,                   -- YouTube, Search, Maps, ...
  title TEXT NOT NULL,
  subtitle TEXT,
  link TEXT,
  captured_at TEXT NOT NULL,               -- when the source captured it (its own capture time, else imported_at)
  imported_at TEXT NOT NULL,               -- when the vault imported it
  deleted_at TEXT,
  deleted_batch TEXT,
  UNIQUE (source, source_key)
);
CREATE INDEX browsing_time ON browsing_events(time);
${fts("browsing_events", ["title", "subtitle", "link"])}

-- a permanently deleted browsing row must not come back on the next import (B3);
-- only the source key (an id or a hash) is kept, never the content
CREATE TABLE import_tombstones (
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (source, source_key)
);
CREATE TRIGGER browsing_events_tombstone AFTER DELETE ON browsing_events BEGIN
  INSERT OR IGNORE INTO import_tombstones(source, source_key, deleted_at) VALUES (old.source, old.source_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TABLE import_runs (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,                    -- 'activity_vault'
  adapter TEXT NOT NULL,                   -- 'local' | 'mcp'
  location TEXT,                           -- path / URL read
  trigger TEXT NOT NULL,                   -- 'schedule' | 'manual'
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_added INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  capture_status TEXT                      -- JSON: what the source reported about its own capture, verbatim
);
CREATE INDEX import_runs_source ON import_runs(source, started_at);

CREATE TABLE ai_conversations (           -- AI history (A1/Q7); in the recovery bin like any record
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('ask','overview')),
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  context TEXT NOT NULL,                   -- JSON: the search / timeline context of the latest turn
  transcript TEXT NOT NULL,                -- JSON: chat messages (user, assistant, tool) without the system prompt
  turns TEXT NOT NULL,                     -- JSON: [{question, context, result, at}]
  seen TEXT NOT NULL,                      -- JSON: {recordId: type} of every record a tool returned
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch TEXT
);
CREATE INDEX ai_conversations_updated ON ai_conversations(updated_at);

CREATE TABLE embeddings (                 -- M4/Q6: one vector per item and model
  rid INTEGER PRIMARY KEY,
  item_type TEXT NOT NULL,                 -- message | screenshot | photo
  item_id TEXT NOT NULL,
  provider TEXT NOT NULL,                  -- 'openai' (a local model is a TODO)
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,                    -- float32 little-endian, L2-normalised
  created_at TEXT NOT NULL,
  UNIQUE (item_type, item_id, model)
);
-- a changed text invalidates its vector; a permanently deleted item takes its vector with it (B3)
CREATE TRIGGER messages_embed_au AFTER UPDATE OF text ON messages BEGIN
  DELETE FROM embeddings WHERE item_type = 'message' AND item_id = new.id;
END;
CREATE TRIGGER messages_embed_ad AFTER DELETE ON messages BEGIN
  DELETE FROM embeddings WHERE item_type = 'message' AND item_id = old.id;
END;
CREATE TRIGGER media_embed_au AFTER UPDATE OF ocr_text ON media BEGIN
  DELETE FROM embeddings WHERE item_type IN ('screenshot','photo') AND item_id = new.id;
END;
CREATE TRIGGER media_embed_ad AFTER DELETE ON media BEGIN
  DELETE FROM embeddings WHERE item_type IN ('screenshot','photo') AND item_id = old.id;
END;
`;

// v4: Windows media policy (PLAN decision 8). file_meta.originalBlobOid links a file to an
// original the device uploaded on its own (payloadKind photo / document); document text is
// extracted into content_text and searched with the name and path (files_fts is rebuilt).
const v4 = `
ALTER TABLE files ADD COLUMN original_blob_oid TEXT;
ALTER TABLE files ADD COLUMN content_text TEXT;
ALTER TABLE files ADD COLUMN extract_status TEXT CHECK (extract_status IN ('pending','done','failed','unsupported'));
CREATE INDEX files_original ON files(original_blob_oid);
DROP TRIGGER files_fts_ai;
DROP TRIGGER files_fts_ad;
DROP TRIGGER files_fts_au;
DROP TABLE files_fts;
${fts("files", ["name", "path", "content_text"])}
INSERT INTO files_fts(files_fts) VALUES ('rebuild');
`;

// v5: multi-source conversation capture (PRD WX1, C8; PLAN task 1.10). A message is one record per
// platform + account + convKey + msgId (conversations are unique on platform/account/conv_key and messages
// on (conversation_id, msg_key) since v1, which is that key); every source that delivered it gets a
// provenance row. Coverage is kept per source (coverage_by_source JSON: source -> claim) and
// conversations.coverage becomes the best any source claims. Rows from before v5 came from Android
// (the only role that could send message_batch) and are attributed to `<role>:legacy`.
const v5 = `
CREATE TABLE message_sources (
  rid INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  device_id TEXT,
  source_session TEXT NOT NULL,            -- e.g. windows:telegram-desktop, android:root-db, android:notification
  captured_at TEXT NOT NULL,               -- when this source first delivered the message
  last_seen_at TEXT NOT NULL,              -- when this source last delivered it
  source_deleted_at TEXT,                  -- this source reported it deleted at source (C6)
  UNIQUE (message_id, source_session)
);

ALTER TABLE messages ADD COLUMN text_source TEXT;            -- source_session whose text is shown
ALTER TABLE messages ADD COLUMN text_quality TEXT NOT NULL DEFAULT 'full' CHECK (text_quality IN ('full','preview'));
ALTER TABLE messages ADD COLUMN forwarded_from TEXT;
ALTER TABLE messages ADD COLUMN media_kind TEXT;
ALTER TABLE messages ADD COLUMN source_deleted_at TEXT;      -- earliest deletion any source observed

ALTER TABLE conversations ADD COLUMN coverage_by_source TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN chat_title TEXT;
ALTER TABLE conversations ADD COLUMN participant_count INTEGER;
ALTER TABLE conversations ADD COLUMN chat_type TEXT;

UPDATE conversations SET coverage_by_source = json_object(
  COALESCE((SELECT d.role FROM devices d WHERE d.id = conversations.device_id), 'android') || ':legacy', coverage);
INSERT OR IGNORE INTO message_sources(message_id, device_id, source_session, captured_at, last_seen_at)
  SELECT m.id, COALESCE(m.device_id, c.device_id),
         COALESCE((SELECT d.role FROM devices d WHERE d.id = COALESCE(m.device_id, c.device_id)), 'android') || ':legacy',
         m.captured_at, m.captured_at
    FROM messages m JOIN conversations c ON c.id = m.conversation_id;
UPDATE messages SET text_source = (SELECT s.source_session FROM message_sources s WHERE s.message_id = messages.id),
                    source_deleted_at = CASE WHEN source_status = 'deleted_at_source' THEN captured_at END;
`;

// v6: sender identity and images in conversation views. A message carries who sent it
// (from_me, the account's own user) and the sender's resolved display name (sender_name);
// both are filled from whichever source provides them and never overwritten with null. A
// conversation carries its peer/chat avatar: the blob oid the source named (avatar_blob_oid)
// and the local copy once that blob is in place (avatar_local_path).
const v6 = `
ALTER TABLE messages ADD COLUMN from_me INTEGER;
ALTER TABLE messages ADD COLUMN sender_name TEXT;
ALTER TABLE conversations ADD COLUMN avatar_blob_oid TEXT;
ALTER TABLE conversations ADD COLUMN avatar_local_path TEXT;
CREATE INDEX conversations_avatar ON conversations(avatar_blob_oid);
`;

// v7: the user's own LINE account state (line_account record), for a standalone LINE settings
// page. Four tables hold a per-account snapshot: the own profile, the contact list (with the raw
// store status/settings and a blocked flag the sender resolved, else unknown), each chat's options
// (hidden/notification/pinned), and the app settings. A snapshot replaces the account's rows, so a
// contact or option dropped at the source disappears. A contact/profile picture names a local copy
// (picture_local_path) when its blob is already in the vault; it stays null until that blob lands.
const v7 = `
CREATE TABLE line_account_profile (
  account TEXT PRIMARY KEY,
  mid TEXT NOT NULL,
  display_name TEXT,
  user_id TEXT,
  status_message TEXT,
  picture_local_path TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE line_contacts (
  account TEXT NOT NULL,
  mid TEXT NOT NULL,
  display_name TEXT,
  status TEXT,                             -- the store's own _status value, verbatim
  type TEXT,                               -- the store's own _type value, verbatim
  settings INTEGER,                        -- the per-contact _settings integer, verbatim
  blocked INTEGER,                         -- 1/0 only when the record resolved it; NULL = unknown
  status_message TEXT,
  picture_local_path TEXT,
  thumbnail_url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, mid)
);

CREATE TABLE line_chat_options (
  account TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  hidden INTEGER,
  notification INTEGER,
  pinned INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, chat_id)
);
CREATE INDEX line_chat_options_hidden ON line_chat_options(account, hidden);

CREATE TABLE line_settings (
  account TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, key)
);
`;

// v8: media originals persist in R2 (PLAN decision 6). A completed media original (payloadKind
// photo, document, attachment or media) is kept in its up-bucket instead of being deleted after
// commit, so the Mac can fetch it again at full quality on demand without the capturing device.
// One row per archived oid records the R2 keys that hold it (manifest + parts), what it is, and
// whether its full-size copy is in the local cache. cache_evicted = 1 means the local copy was
// dropped to free disk but the object is still in R2 and re-fetchable. The blob row keeps the
// manifest envelope, so the same Mac key that received it can always decrypt it again.
const v8 = `
CREATE TABLE media_archive (
  oid TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,                     -- the up-bucket name that holds the objects
  manifest_key TEXT NOT NULL,               -- up/blob/<oid>/manifest
  part_keys TEXT NOT NULL,                  -- JSON array of up/blob/<oid>/p/<index> keys
  payload_kind TEXT NOT NULL,
  plaintext_sha256 TEXT,                    -- of the reassembled original
  total_size INTEGER,
  filename TEXT,
  content_type TEXT,
  device_id TEXT,
  cached_local_path TEXT,                   -- set while the full original is in the local cache
  cache_evicted INTEGER NOT NULL DEFAULT 0, -- 1 = local copy dropped to free disk; still in R2
  archived_at TEXT NOT NULL
);
`;

// v9: catalog entries (browse-and-fetch-on-demand, PROTOCOL file_meta.catalogOnly). A catalogOnly
// file_meta records a file's metadata only (path, name, size, ext, mtime) with no quick hash, no
// thumbnail and no uploaded original, so the Mac can browse everything on the Windows PC and fetch
// any file's bytes on demand (a fetch issues a file_request; the original then caches locally and
// persists in R2). The files table gains a `catalog` flag (1 for these) and its status CHECK gains
// 'catalog' (a browse-only entry, not yet fetched). A catalog entry is kept out of the normal files
// list, search, timeline and media gallery until it is fetched; once its original arrives and caches
// it is an ordinary 'cached' file (local_path set) and appears normally. The status CHECK cannot be
// altered in place, so the files table is rebuilt (as commands was in v2); rids are preserved so the
// files_fts external-content index stays valid after its triggers are recreated and rebuilt.
const v9 = `
DROP VIEW items;
CREATE TABLE files_v9 (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT,
  size INTEGER,
  mtime TEXT,
  quick_hash TEXT,
  status TEXT NOT NULL DEFAULT 'reference' CHECK (status IN ('reference','cached','catalog')),
  source_status TEXT NOT NULL DEFAULT 'live' CHECK (source_status IN ('live','deleted_at_source')),
  source_deleted_at TEXT,
  thumb_blob_oid TEXT,
  thumb_path TEXT,
  local_path TEXT,
  event_time TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch TEXT,
  original_blob_oid TEXT,
  content_text TEXT,
  extract_status TEXT CHECK (extract_status IN ('pending','done','failed','unsupported')),
  catalog INTEGER NOT NULL DEFAULT 0,
  UNIQUE (device_id, path)
);
INSERT INTO files_v9 (rid, id, device_id, path, name, ext, size, mtime, quick_hash, status, source_status, source_deleted_at,
  thumb_blob_oid, thumb_path, local_path, event_time, captured_at, first_seen_at, updated_at, deleted_at, deleted_batch,
  original_blob_oid, content_text, extract_status)
  SELECT rid, id, device_id, path, name, ext, size, mtime, quick_hash, status, source_status, source_deleted_at,
    thumb_blob_oid, thumb_path, local_path, event_time, captured_at, first_seen_at, updated_at, deleted_at, deleted_batch,
    original_blob_oid, content_text, extract_status FROM files;
DROP TRIGGER files_fts_ai;
DROP TRIGGER files_fts_ad;
DROP TRIGGER files_fts_au;
DROP TABLE files;
ALTER TABLE files_v9 RENAME TO files;
CREATE INDEX files_mtime ON files(mtime);
CREATE INDEX files_thumb ON files(thumb_blob_oid);
CREATE INDEX files_original ON files(original_blob_oid);
CREATE INDEX files_catalog ON files(device_id, catalog);
${ftsTriggers("files", "files_fts", ["name", "path", "content_text"])}
INSERT INTO files_fts(files_fts) VALUES ('rebuild');
-- recreate the items view (dropped above so the files table could be rebuilt); unchanged from v1
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

// v10: call events carried as messages (LINE call records): the message's `call` object, all nullable.
const v10 = `
ALTER TABLE messages ADD COLUMN call_kind TEXT;          -- audio | video | unknown
ALTER TABLE messages ADD COLUMN call_outcome TEXT;       -- completed | missed | declined | cancelled | unknown
ALTER TABLE messages ADD COLUMN call_duration_s INTEGER; -- whole seconds, completed calls only
ALTER TABLE messages ADD COLUMN call_direction TEXT;     -- outgoing | incoming
`;

// v11: the orphan-manifest sweep reads blobs by status and last progress; keep that a small indexed query.
const v11 = `
CREATE INDEX blobs_pending ON blobs(status, updated_at);
`;

// v12: where the owner's own app lists the chat (chatMeta.listing): normal | archived (Telegram's Archive
// folder) | hidden (LINE's hidden chats). NULL means no source has said; the UI treats it as normal.
const v12 = `
ALTER TABLE conversations ADD COLUMN listing TEXT;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial vault schema", sql: v1 },
  { version: 2, name: "import progress, manifest commandId, transferring commands", sql: v2 },
  { version: 3, name: "activity vault import, ai conversations, embeddings", sql: v3 },
  { version: 4, name: "file originals (media policy) and document text", sql: v4 },
  { version: 5, name: "multi-source conversations: message provenance, coverage per source", sql: v5 },
  { version: 6, name: "sender identity (from_me, sender_name) and conversation avatars", sql: v6 },
  { version: 7, name: "LINE account state: profile, contacts, chat options and settings", sql: v7 },
  { version: 8, name: "media originals kept in R2: the media_archive record", sql: v8 },
  { version: 9, name: "catalog entries: browse-and-fetch-on-demand (files.catalog, status 'catalog')", sql: v9 },
  { version: 10, name: "call events on messages (call_kind, call_outcome, call_duration_s, call_direction)", sql: v10 },
  { version: 11, name: "index for the stale-blob sweep (blobs by status and last progress)", sql: v11 },
  { version: 12, name: "conversation listing (normal | archived | hidden) from chatMeta.listing", sql: v12 },
];
