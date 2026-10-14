/**
 * Chat tags and completeness of the chats view (query/chat-tags.ts):
 *   - LINE's own chat options (hidden, notification off = muted, pinned) are shown on the chat itself,
 *     on the list, the thread and the profile; hidden also drives the listing filter;
 *   - a LINE chat known only from the options (no captured message, so no conversation row) is listed
 *     as a placeholder, for accounts that have captured conversations, never for a leftover account;
 *   - the list pages across real and placeholder chats with nothing dropped or repeated, and its total
 *     equals what the store holds and what the sidebar counts;
 *   - ingesting the account snapshot keeps every option row and every flag.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitLineAccount, commitMessageBatch } from "../src/ingest/committers.ts";
import { validateRecordKind } from "@ivy/protocol";

let svc: Service;
let dir: string;
const WIN = "dev-win";
const OTHER = "dev-other";
const ACCT = "u-ivy";
const OLD_ACCT = "u-old"; // a LINE account signed out of the PC: its last snapshot stays, with no conversations
const SENT = "2026-10-09T10:00:00.000Z";
const db = () => svc.ctx.db;

function lineBatch(convKey: string, over: Record<string, unknown> = {}, chatMeta: Record<string, unknown> = { listing: "normal" }) {
  const rec = {
    v: 1, kind: "message_batch", deviceId: WIN, eventTime: SENT, captureTime: "2026-10-10T00:00:00.000Z",
    platform: "line", account: ACCT, convKey, peer: convKey, convKind: "dm",
    sourceSession: "windows:line-desktop", coverage: "partial", cursor: "1", chatMeta,
    messages: [{ msgId: `${convKey}-1`, sender: "u1", sentAt: SENT, text: "hi", sourceStatus: "live", attachments: [] }],
    ...over,
  };
  return commitMessageBatch(db(), validateRecordKind("message_batch", rec) as never);
}
function tgBatch(convKey: string, sentAt = SENT) {
  const rec = {
    v: 1, kind: "message_batch", deviceId: WIN, eventTime: sentAt, captureTime: "2026-10-10T00:00:00.000Z",
    platform: "telegram", account: "777", convKey, peer: convKey, convKind: "dm",
    sourceSession: "windows:telegram-desktop", coverage: "complete", cursor: "1", chatMeta: { listing: "normal" },
    messages: [{ msgId: "1", sender: "u1", sentAt, text: "hi", sourceStatus: "live", attachments: [] }],
  };
  return commitMessageBatch(db(), validateRecordKind("message_batch", rec) as never);
}
function snapshot(account: string, chatOptions: Array<Record<string, unknown>>, contacts: Array<Record<string, unknown>> = []) {
  const rec = {
    v: 1, kind: "line_account", deviceId: WIN, eventTime: SENT, captureTime: "2026-10-10T00:00:00.000Z",
    account, contacts, chatOptions, settings: [],
  };
  return commitLineAccount(db(), validateRecordKind("line_account", rec) as never);
}

type Item = { id: string; title: string; listing: string | null; muted: boolean | null; pinned: boolean | null; placeholder?: boolean; messageCount: number };
const chats = async (qs = "") => (await api(svc, "GET", `/api/views/chats${qs}`)).json as { total: number; pages: number; items: Item[] };
const byTitle = (items: Item[]) => Object.fromEntries(items.map((c) => [c.title, c]));

beforeEach(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  db().prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'FPW', 't')").run(WIN);
  db().prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k2', 'FPO', 't')").run(OTHER);
});
afterEach(async () => { await svc.close(); rm(dir); });

describe("LINE chat options shown as tags", () => {
  beforeEach(() => {
    lineBatch("u-hid");   // hidden in LINE (options), normal in the batch
    lineBatch("u-mute");  // notifications off
    lineBatch("u-pin");   // pinned
    lineBatch("u-plain"); // an option row with nothing set
    lineBatch("u-none");  // no option row at all
    tgBatch("tg-1");
    snapshot(ACCT, [
      { chatId: "u-hid", hidden: true, notification: true, pinned: false },
      { chatId: "u-mute", hidden: false, notification: false, pinned: false },
      { chatId: "u-pin", hidden: false, notification: true, pinned: true },
      { chatId: "u-plain", hidden: false, notification: true, pinned: false },
    ]);
  });

  it("each chat carries its own hidden / muted / pinned, null where no source has said", async () => {
    const by = byTitle((await chats()).items);
    expect(by["u-hid"]).toMatchObject({ listing: "hidden", muted: false, pinned: false });
    expect(by["u-mute"]).toMatchObject({ listing: "normal", muted: true, pinned: false });
    expect(by["u-pin"]).toMatchObject({ listing: "normal", muted: false, pinned: true });
    expect(by["u-plain"]).toMatchObject({ listing: "normal", muted: false, pinned: false });
    expect(by["u-none"]).toMatchObject({ listing: "normal", muted: null, pinned: null });
    expect(by["tg-1"]).toMatchObject({ listing: "normal", muted: null, pinned: null });
  });

  it("a hidden LINE chat is under the Hidden filter and not under Normal", async () => {
    expect((await chats("?listing=hidden")).items.map((c) => c.title)).toEqual(["u-hid"]);
    expect((await chats("?listing=normal")).items.map((c) => c.title).sort()).toEqual(["tg-1", "u-mute", "u-none", "u-pin", "u-plain"]);
  });

  it("the thread and profile routes carry the same tags", async () => {
    const ids = byTitle((await chats()).items);
    for (const [title, want] of [["u-hid", { listing: "hidden", muted: false }], ["u-mute", { muted: true }], ["u-pin", { pinned: true }]] as const) {
      const id = ids[title]!.id;
      expect((await api(svc, "GET", `/api/views/chats/${id}/messages`)).json.conversation).toMatchObject(want);
      expect((await api(svc, "GET", `/api/views/chats/${id}/profile`)).json.conversation).toMatchObject(want);
    }
  });

  it("a later batch saying normal does not clear a hidden tag from LINE's options", async () => {
    lineBatch("u-hid", { messages: [{ msgId: "u-hid-2", sender: "u1", sentAt: SENT, text: "again", sourceStatus: "live", attachments: [] }] });
    expect(byTitle((await chats()).items)["u-hid"]!.listing).toBe("hidden");
  });

  it("unhiding in LINE (a new snapshot) clears the tag", async () => {
    snapshot(ACCT, [{ chatId: "u-hid", hidden: false, notification: true, pinned: false }]);
    expect(byTitle((await chats()).items)["u-hid"]).toMatchObject({ listing: "normal", muted: false });
  });
});

describe("LINE chats known only from the options", () => {
  beforeEach(() => {
    lineBatch("u-a");
    snapshot(ACCT, [
      { chatId: "u-a", hidden: false, notification: true },
      { chatId: "m-group", hidden: false, notification: false },   // a group with no captured message
      { chatId: "u-friend", hidden: true, notification: true },    // a hidden 1:1 with no captured message
    ], [{ mid: "u-friend", displayName: "Friend" }]);
    snapshot(OLD_ACCT, [{ chatId: "u-gone", hidden: true }]);      // leftover account: no conversations
  });

  it("are listed after the captured chats, with their tags, a title and no messages", async () => {
    const r = await chats();
    expect(r.total).toBe(3);
    expect(r.items.map((c) => c.title)).toEqual(["u-a", "m-group", "Friend"]); // placeholders by account, then chat id
    const by = byTitle(r.items);
    expect(by["u-a"]!.placeholder).toBeUndefined();
    expect(by["m-group"]).toMatchObject({ placeholder: true, listing: "normal", muted: true, messageCount: 0 });
    expect(by["Friend"]).toMatchObject({ placeholder: true, listing: "hidden", muted: false, messageCount: 0 });
    expect(by["m-group"]!.id).toBe(`lineopt:${ACCT}:m-group`);
  });

  it("never come from an account with no captured conversations", async () => {
    expect((await chats()).items.some((c) => c.title === "u-gone")).toBe(false);
  });

  it("follow the platform, listing, search and device filters", async () => {
    expect((await chats("?platform=telegram")).total).toBe(0);
    expect((await chats("?platform=line")).total).toBe(3);
    expect((await chats("?listing=hidden")).items.map((c) => c.title)).toEqual(["Friend"]);
    expect((await chats("?listing=archived")).total).toBe(0);
    expect((await chats("?q=friend")).items.map((c) => c.title)).toEqual(["Friend"]);
    expect((await chats("?q=m-gr")).items.map((c) => c.title)).toEqual(["m-group"]);
    expect((await chats(`?device=${WIN}`)).total).toBe(3);
    expect((await chats(`?device=${OTHER}`)).total).toBe(0);
    expect((await chats("?source=windows:line-desktop")).total).toBe(3);
    expect((await chats("?source=windows:telegram-desktop")).total).toBe(0);
  });

  it("stop being placeholders once a message arrives, and a chat in the recovery bin is not brought back", async () => {
    lineBatch("m-group", { convKind: "group" });
    let r = await chats();
    expect(r.total).toBe(3);
    expect(byTitle(r.items)["m-group"]).toMatchObject({ messageCount: 1, muted: true });
    expect(byTitle(r.items)["m-group"]!.placeholder).toBeUndefined();

    db().prepare("UPDATE conversations SET deleted_at = 't' WHERE conv_key = 'm-group'").run();
    r = await chats();
    expect(r.items.map((c) => c.title)).toEqual(["u-a", "Friend"]);
  });

  it("the sidebar's LINE source count includes them, matching the list total", async () => {
    const src = (await api(svc, "GET", "/api/views/sources")).json.sources as Array<{ source: string; platform: string; conversations: number }>;
    const line = src.find((s) => s.source === "windows:line-desktop" && s.platform === "line")!;
    expect(line.conversations).toBe(3);
    expect(line.conversations).toBe((await chats("?source=windows:line-desktop&platform=line")).total);
  });
});

describe("paging the chats view", () => {
  it("returns every stored chat exactly once across pages, past the real/placeholder boundary", async () => {
    for (let i = 0; i < 7; i++) lineBatch(`u-${i}`, { messages: [{ msgId: `m${i}`, sender: "u1", sentAt: `2026-10-0${i + 1}T10:00:00.000Z`, text: "hi", sourceStatus: "live", attachments: [] }] });
    for (let i = 0; i < 4; i++) tgBatch(`tg-${i}`, `2026-09-1${i}T10:00:00.000Z`);
    snapshot(ACCT, [...Array.from({ length: 7 }, (_, i) => ({ chatId: `u-${i}` })), { chatId: "m-x" }, { chatId: "m-y" }, { chatId: "m-z" }]);

    const stored = (db().prepare("SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL").get() as { n: number }).n
      + (db().prepare(`SELECT COUNT(*) AS n FROM line_chat_options o WHERE NOT EXISTS
          (SELECT 1 FROM conversations c WHERE c.platform = 'line' AND c.account = o.account AND c.conv_key = o.chat_id)`).get() as { n: number }).n;
    expect(stored).toBe(14);

    const first = await chats("?pageSize=4");
    expect(first).toMatchObject({ total: 14, pages: 4 });
    const seen: string[] = [];
    for (let page = 1; page <= first.pages; page++) {
      const r = await chats(`?pageSize=4&page=${page}`);
      expect(r.items.length).toBe(page < first.pages ? 4 : 2);
      seen.push(...r.items.map((c) => c.id));
    }
    expect(seen).toHaveLength(14);
    expect(new Set(seen).size).toBe(14);
    expect(seen.slice(-3)).toEqual([`lineopt:${ACCT}:m-x`, `lineopt:${ACCT}:m-y`, `lineopt:${ACCT}:m-z`]);
    // a page wholly past the end is empty, not an error
    expect((await chats("?pageSize=4&page=9")).items).toEqual([]);
  });
});

describe("ingesting the account snapshot keeps every option and flag", () => {
  it("stores one row per chat option with hidden, notification and pinned as sent", () => {
    const opts = [
      { chatId: "c1", hidden: true, notification: false, pinned: true },
      { chatId: "c2", hidden: false, notification: true, pinned: false },
      { chatId: "c3" },
    ];
    const r = snapshot(ACCT, opts);
    expect(r.summary).toMatchObject({ chatOptions: 3, hidden: 1 });
    expect(db().prepare("SELECT chat_id, hidden, notification, pinned FROM line_chat_options WHERE account = ? ORDER BY chat_id").all(ACCT)).toEqual([
      { chat_id: "c1", hidden: 1, notification: 0, pinned: 1 },
      { chat_id: "c2", hidden: 0, notification: 1, pinned: 0 },
      { chat_id: "c3", hidden: 0, notification: null, pinned: null },
    ]);
  });
});

describe("the LINE settings page follows the account LINE is using now", () => {
  it("picks the account with the newest snapshot, not the first by name", async () => {
    snapshot("u-aaa-old", [{ chatId: "x", hidden: true }]);
    snapshot("u-zzz-now", [{ chatId: "y", hidden: false }]);
    db().prepare("UPDATE line_chat_options SET updated_at = '2026-10-01T00:00:00.000Z' WHERE account = 'u-aaa-old'").run();
    db().prepare("UPDATE line_chat_options SET updated_at = '2026-10-13T00:00:00.000Z' WHERE account = 'u-zzz-now'").run();
    const acct = (await api(svc, "GET", "/api/views/line/account")).json;
    expect(acct).toMatchObject({ account: "u-zzz-now", counts: { hidden: 0 } });
    expect((await api(svc, "GET", "/api/views/line/account?account=u-aaa-old")).json.counts.hidden).toBe(1);
  });
});
