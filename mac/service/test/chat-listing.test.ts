/**
 * chatMeta.listing (PROTOCOL.md §6): where the owner's own app lists a chat — normal, archived (Telegram's
 * Archive folder) or hidden (LINE's hidden chats). The committer keeps a stored value when a batch omits it,
 * an explicit value always replaces it, and a metadata-only batch (no messages) updates the conversation
 * alone. The chats view returns the listing and filters on it.
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
const SENT = "2026-10-09T10:00:00.000Z";

function batch(convKey: string, chatMeta: Record<string, unknown> | undefined, messages: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  const rec = {
    v: 1, kind: "message_batch", deviceId: WIN, eventTime: SENT, captureTime: "2026-10-10T00:00:00.000Z",
    platform: "telegram", account: "777", convKey, peer: convKey, convKind: "dm",
    sourceSession: "windows:telegram-desktop", coverage: "complete", cursor: "1",
    ...(chatMeta ? { chatMeta } : {}),
    messages: messages.map((m) => ({ sender: "u1", sentAt: SENT, text: "hi", sourceStatus: "live", attachments: [], ...m })),
    ...over,
  };
  // through the real schema, so an unknown listing value would be rejected here as on ingest
  return commitMessageBatch(db(), validateRecordKind("message_batch", rec) as never);
}
const listingOf = (convKey: string) =>
  (db().prepare("SELECT listing FROM conversations WHERE conv_key = ?").get(convKey) as { listing: string | null }).listing;

beforeEach(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  db().prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'FPW', 't')").run(WIN);
});
afterEach(async () => { await svc.close(); rm(dir); });

describe("committer: conversations.listing", () => {
  it("stores the listing, keeps it when a batch omits it, and an explicit normal clears archived", () => {
    batch("user:1", { title: "Alice", listing: "archived" }, [{ msgId: "1" }]);
    expect(listingOf("user:1")).toBe("archived");
    batch("user:1", { title: "Alice" }, [{ msgId: "2" }]);          // missing: unknown, keeps archived
    expect(listingOf("user:1")).toBe("archived");
    batch("user:1", undefined, [{ msgId: "3" }]);                     // no chatMeta at all: keeps it too
    expect(listingOf("user:1")).toBe("archived");
    batch("user:1", { listing: "normal" }, [{ msgId: "4" }]);        // explicit unarchive wins
    expect(listingOf("user:1")).toBe("normal");
    expect((db().prepare("SELECT chat_title FROM conversations WHERE conv_key = 'user:1'").get() as { chat_title: string }).chat_title).toBe("Alice");
  });

  it("a conversation never given a listing stays NULL", () => {
    batch("user:2", { title: "Bob" }, [{ msgId: "1" }]);
    expect(listingOf("user:2")).toBeNull();
  });

  it("a metadata-only batch updates the conversation and stores no message", () => {
    batch("user:3", { title: "Carol" }, [{ msgId: "1" }]);
    const r = batch("user:3", { title: "Carol K", listing: "hidden" }, [], { cursor: "1", eventTime: "2026-10-11T00:00:00.000Z" });
    expect(r.summary).toMatchObject({ inserted: 0, edited: 0, upgraded: 0 });
    expect(listingOf("user:3")).toBe("hidden");
    expect(db().prepare("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.conv_key = 'user:3'").get()).toEqual({ n: 1 });
    expect((db().prepare("SELECT chat_title FROM conversations WHERE conv_key = 'user:3'").get() as { chat_title: string }).chat_title).toBe("Carol K");
  });

  it("a metadata-only batch for a chat not seen yet creates the conversation with no messages", () => {
    const r = batch("user:4", { title: "Dan", listing: "archived" }, []);
    expect(r.summary).toMatchObject({ inserted: 0 });
    expect(listingOf("user:4")).toBe("archived");
  });

  it("rejects a listing value outside normal/archived/hidden", () => {
    expect(() => batch("user:5", { listing: "muted" }, [{ msgId: "1" }])).toThrow();
  });
});

describe("GET /api/views/chats listing", () => {
  beforeEach(() => {
    batch("user:1", { title: "Alice", listing: "archived" }, [{ msgId: "1" }]);
    batch("user:2", { title: "Bob", listing: "normal" }, [{ msgId: "1" }]);
    batch("user:3", { title: "Carol" }, [{ msgId: "1" }]);                       // unknown
    batch("u9", { title: "Hidden pal", listing: "hidden" }, [{ msgId: "1" }], { platform: "line", sourceSession: "windows:line-desktop", coverage: "partial" });
  });
  const titles = async (qs: string) =>
    ((await api(svc, "GET", `/api/views/chats${qs}`)).json.items as Array<{ title: string }>).map((c) => c.title).sort();

  it("returns listing on each chat and shows every chat by default", async () => {
    const r = await api(svc, "GET", "/api/views/chats");
    expect(r.status).toBe(200);
    const by = Object.fromEntries((r.json.items as Array<{ title: string; listing: string | null }>).map((c) => [c.title, c.listing]));
    expect(by).toEqual({ Alice: "archived", Bob: "normal", Carol: null, "Hidden pal": "hidden" });
    expect(await titles("?listing=all")).toEqual(["Alice", "Bob", "Carol", "Hidden pal"]);
  });

  it("filters normal (including unknown), archived and hidden, and rejects other values", async () => {
    expect(await titles("?listing=normal")).toEqual(["Bob", "Carol"]);
    expect(await titles("?listing=archived")).toEqual(["Alice"]);
    expect(await titles("?listing=hidden")).toEqual(["Hidden pal"]);
    expect(await titles("?listing=hidden&platform=telegram")).toEqual([]);
    expect((await api(svc, "GET", "/api/views/chats?listing=muted")).status).toBe(400);
  });

  it("the thread and profile routes return listing on the conversation", async () => {
    const id = ((await api(svc, "GET", "/api/views/chats?listing=archived")).json.items[0] as { id: string }).id;
    expect((await api(svc, "GET", `/api/views/chats/${id}/messages`)).json.conversation.listing).toBe("archived");
    expect((await api(svc, "GET", `/api/views/chats/${id}/profile`)).json.conversation.listing).toBe("archived");
  });
});
