import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

const CONTENT = ["conversations", "messages", "attachments", "notifications", "media", "files", "calls", "usage_events"];
const PROTOCOL_TABLES = ["devices", "sync_objects", "collector_state", "commands", "blobs", "quarantine", "pairings", "settings"];

describe("vault database", () => {
  it("applies versioned migrations once", () => {
    const db = openDb(":memory:");
    const v = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
    expect(v.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(migrate(db)).toEqual([]); // idempotent
    db.close();
  });

  it("has every PRD table, the protocol tables, and deleted_at on every content table", () => {
    const db = openDb(":memory:");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((r) => r.name));
    for (const t of [...CONTENT, ...PROTOCOL_TABLES, "items"]) expect(tables.has(t), t).toBe(true);
    for (const t of CONTENT) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols, t).toContain("deleted_at");
    }
    const msg = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(msg).toEqual(expect.arrayContaining(["sent_at", "captured_at", "reply_to", "edited_at", "source_status"]));
    const media = (db.prepare("PRAGMA table_info(media)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(media).toEqual(expect.arrayContaining(["taken_at", "saved_at", "imported_at", "ocr_text", "thumb_path", "attachment_id"]));
    const blobs = (db.prepare("PRAGMA table_info(blobs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(blobs).toContain("committed_parts");
    db.close();
  });

  it("keeps the trigram FTS index in sync on insert, update and delete", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO files(id, device_id, path, name, event_time, captured_at, first_seen_at, updated_at) VALUES ('f1','d','C:\\\\Docs\\\\Invoice-2026.pdf','Invoice-2026.pdf','t','t','t','t')").run();
    const hits = (q: string) => (db.prepare("SELECT COUNT(*) AS n FROM files_fts WHERE files_fts MATCH ?").get(q) as { n: number }).n;
    expect(hits('"voice"')).toBe(1); // substring
    expect(hits('"INVOICE"')).toBe(1); // case-insensitive
    db.prepare("UPDATE files SET name = 'Receipt.pdf', path = 'C:\\\\Docs\\\\Receipt.pdf' WHERE id = 'f1'").run();
    expect(hits('"voice"')).toBe(0);
    expect(hits('"receipt"')).toBe(1);
    db.prepare("DELETE FROM files WHERE id = 'f1'").run();
    expect(hits('"receipt"')).toBe(0);
    db.close();
  });

  it("folds diacritics in the index", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO notifications(id, device_id, source, app, title, preview, posted_at, captured_at, ingested_at, dedupe_key) VALUES ('n','d','windows','LINE','Café meeting','À bientôt','t','t','t','k')").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM notifications_fts WHERE notifications_fts MATCH ?").get('"cafe"') as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM notifications_fts WHERE notifications_fts MATCH ?").get('"bientot"') as { n: number }).n).toBe(1);
    db.close();
  });

  it("the items view keeps the original event time and capture time apart", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO conversations(id, platform, account, conv_key, kind, coverage, created_at, updated_at) VALUES ('c','line','me','k','dm','complete','t','t')").run();
    db.prepare("INSERT INTO messages(id, conversation_id, msg_key, sender, sent_at, captured_at, text) VALUES ('m','c','1','Aki','2026-09-24T10:00:00.000Z','2026-10-01T00:00:00.000Z','hello')").run();
    const r = db.prepare("SELECT event_time, time_field, captured_at FROM items WHERE id = 'm'").get();
    expect(r).toEqual({ event_time: "2026-09-24T10:00:00.000Z", time_field: "sent_at", captured_at: "2026-10-01T00:00:00.000Z" });
    db.close();
  });
});
