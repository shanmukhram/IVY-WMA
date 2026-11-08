/**
 * What was deleted at the source, and when (PRD C6): a message removed from the owner's app is marked with the
 * time the source first noticed, a chat removed from the app is marked on the conversation
 * (chatMeta.deletedAtSource), the vault keeps every message either way, and the chats view shows both and can
 * list only chats with deletions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitMessageBatch } from "../src/ingest/committers.ts";
import { validateRecordKind } from "@ivy/protocol";

let svc: Service;
let dir: string;
const WIN = "dev-win";
const db = () => svc.ctx.db;
const T = (d: number) => `2026-11-0${d}T10:00:00.000Z`;

function batch(convKey: string, messages: Array<Record<string, unknown>>, chatMeta: Record<string, unknown> = {}) {
  const rec = {
    v: 1, kind: "message_batch", deviceId: WIN, eventTime: T(1), captureTime: T(8),
    platform: "line", account: "u-ivy", convKey, peer: convKey, convKind: "dm",
    sourceSession: "windows:line-desktop", coverage: "partial", cursor: "1", chatMeta,
    messages: messages.map((m) => ({ sender: "u1", sentAt: T(1), text: "hi", sourceStatus: "live", attachments: [], ...m })),
  };
  return commitMessageBatch(db(), validateRecordKind("message_batch", rec) as never);
}
const conv = (k: string) => db().prepare("SELECT id, source_deleted_at FROM conversations WHERE conv_key = ?").get(k) as { id: string; source_deleted_at: string | null };
const messagesIn = (k: string) => (db().prepare("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.conv_key = ?").get(k) as { n: number }).n;
type Item = { title: string; deletedAtSource: string | null; deletedMessages: number };
const chats = async (qs = "") => ((await api(svc, "GET", `/api/views/chats${qs}`)).json.items as Item[]);
const byTitle = (items: Item[]) => Object.fromEntries(items.map((c) => [c.title, c]));

beforeEach(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  db().prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'FPW', 't')").run(WIN);
});
afterEach(async () => { await svc.close(); rm(dir); });

describe("a chat removed from the owner's app", () => {
  it("is marked with when it was noticed, keeps every message, and the earliest notice stands", () => {
    batch("u-aki", Array.from({ length: 49 }, (_, i) => ({ msgId: `m${i}` })));
    expect(conv("u-aki").source_deleted_at).toBeNull();
    batch("u-aki", [], { deletedAtSource: T(5) });
    expect(conv("u-aki").source_deleted_at).toBe(T(5));
    expect(messagesIn("u-aki")).toBe(49);                  // nothing removed from the vault
    batch("u-aki", [], { deletedAtSource: T(7) });         // reported again later: the first notice stands
    expect(conv("u-aki").source_deleted_at).toBe(T(5));
    batch("u-aki", [], {});                                // a batch that does not say: unchanged
    expect(conv("u-aki").source_deleted_at).toBe(T(5));
  });

  it("is cleared when the source says the chat is in the app again", () => {
    batch("u-bo", [{ msgId: "1" }], { deletedAtSource: T(5) });
    expect(conv("u-bo").source_deleted_at).toBe(T(5));
    batch("u-bo", [{ msgId: "2" }], { deletedAtSource: null });
    expect(conv("u-bo").source_deleted_at).toBeNull();
  });

  it("rejects a deletedAtSource that is not a time or null", () => {
    expect(() => batch("u-x", [{ msgId: "1" }], { deletedAtSource: 5 })).toThrow();
  });
});

describe("messages removed from the owner's app", () => {
  it("49 messages, 9 later removed: all 49 kept, 9 marked with when they were noticed gone", async () => {
    batch("u-cat", Array.from({ length: 49 }, (_, i) => ({ msgId: `m${i}`, text: `text ${i}` })));
    batch("u-cat", Array.from({ length: 9 }, (_, i) => ({ msgId: `m${i}`, text: `text ${i}`, sourceStatus: "deleted_at_source", deletedAtSource: T(6) })));
    expect(messagesIn("u-cat")).toBe(49);
    const rows = db().prepare(`SELECT m.msg_key, m.source_status, m.source_deleted_at, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id
                               WHERE c.conv_key = 'u-cat' AND m.source_status = 'deleted_at_source' ORDER BY m.msg_key`).all() as Array<{ msg_key: string; source_deleted_at: string; text: string }>;
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.source_deleted_at === T(6))).toBe(true);
    expect(rows.map((r) => r.text)).toContain("text 3");    // the text is still there to read
    expect(byTitle(await chats())["u-cat"]).toMatchObject({ deletedMessages: 9, deletedAtSource: null });
  });
});

describe("the chats view", () => {
  beforeEach(() => {
    batch("u-live", [{ msgId: "1" }]);
    batch("u-gone", [{ msgId: "1" }], { deletedAtSource: T(5) });
    batch("u-some", [{ msgId: "1" }, { msgId: "2", sourceStatus: "deleted_at_source", deletedAtSource: T(4) }]);
  });

  it("returns each chat's deletion and deleted-message count", async () => {
    const by = byTitle(await chats());
    expect(by["u-live"]).toMatchObject({ deletedAtSource: null, deletedMessages: 0 });
    expect(by["u-gone"]).toMatchObject({ deletedAtSource: T(5), deletedMessages: 0 });
    expect(by["u-some"]).toMatchObject({ deletedAtSource: null, deletedMessages: 1 });
  });

  it("listing=deleted lists only chats with a deletion; other filters still include them", async () => {
    expect((await chats("?listing=deleted")).map((c) => c.title).sort()).toEqual(["u-gone", "u-some"]);
    expect((await chats("?listing=all")).length).toBe(3);
    expect((await chats("?listing=normal")).length).toBe(3);
  });

  it("the thread and profile carry the chat's deletion", async () => {
    const id = conv("u-gone").id;
    expect((await api(svc, "GET", `/api/views/chats/${id}/messages`)).json.conversation).toMatchObject({ deletedAtSource: T(5) });
    expect((await api(svc, "GET", `/api/views/chats/${id}/profile`)).json.conversation).toMatchObject({ deletedAtSource: T(5) });
  });

  it("rejects an unknown listing", async () => {
    expect((await api(svc, "GET", "/api/views/chats?listing=removed")).status).toBe(400);
  });
});

describe("the text of a removed message stays readable", () => {
  it("a later blank copy (LINE unsend, or a deleted message re-sent empty) does not replace the stored words", () => {
    batch("u-dee", [{ msgId: "1", text: "meet at 6" }]);
    batch("u-dee", [{ msgId: "1", text: "" }]);                                                          // unsend blanked it
    batch("u-dee", [{ msgId: "1", text: "", sourceStatus: "deleted_at_source", deletedAtSource: T(6) }]); // then marked removed
    const m = db().prepare(`SELECT m.text, m.source_status, m.source_deleted_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
                            WHERE c.conv_key = 'u-dee'`).get();
    expect(m).toEqual({ text: "meet at 6", source_status: "deleted_at_source", source_deleted_at: T(6) });
    expect(db().prepare("SELECT COUNT(*) AS n FROM message_edits").get()).toEqual({ n: 0 }); // not recorded as an edit either
  });

  it("a real edit still replaces the text and keeps the old one", () => {
    batch("u-eve", [{ msgId: "1", text: "first" }]);
    batch("u-eve", [{ msgId: "1", text: "second", editedAt: T(3) }]);
    expect((db().prepare("SELECT text FROM messages WHERE msg_key = '1' AND conversation_id = (SELECT id FROM conversations WHERE conv_key = 'u-eve')").get() as { text: string }).text).toBe("second");
    expect(db().prepare("SELECT text FROM message_edits").all()).toEqual([{ text: "first" }]);
  });
});
