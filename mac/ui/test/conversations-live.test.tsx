import { describe, it, expect } from "vitest";
import { screen, within, waitFor, act } from "@testing-library/react";
import { ConversationsView, commitTouches, isNearBottom, liveWindow } from "../src/views/Conversations.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const ME = "5521004";
const chat = (id: string, peer: string, sentAt: string) => ({
  id, platform: "telegram", account: ME, convKey: `k-${id}`, peer, kind: "dm", coverage: "complete",
  coverageSources: [{ source: "windows:telegram-desktop", coverage: "complete" }], coverageText: "complete via windows:telegram-desktop",
  messageCount: 2, lastMessageAt: sentAt, lastMessage: { id: "x", sender: "77", sentAt, text: "" },
});
const msg = (id: string, sentAt: string, text: string) => ({ id, fromMe: false, sender: "77", senderName: "Aiko", sentAt, text, attachments: [] });
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** c1 is the newest chat (opens first); its thread is served from a list the test appends to. */
function setup(path = "/conversations", onFetch: () => void = () => {}) {
  const thread = [msg("m1", "2026-10-09T10:00:00.000Z", "Morning"), msg("m2", "2026-10-09T10:01:00.000Z", "Coffee?")];
  const api = mockApi({
    "GET /api/views/chats": { total: 2, page: 1, pages: 1, items: [chat("c1", "Aiko", "2026-10-09T10:01:00.000Z"), chat("c2", "Kenji", "2026-10-08T08:00:00.000Z")] },
    "GET /api/views/chats/c1/messages": (q: any) => (onFetch(), { around: q.around ?? null, conversation: chat("c1", "Aiko", "2026-10-09T10:01:00.000Z"), messages: [...thread] }),
  });
  const r = renderWith(<ConversationsView />, api, { path });
  const threadCalls = () => api.calls.filter((c) => c.path === "/api/views/chats/c1/messages");
  return { ...r, api, thread, threadCalls };
}

// jsdom does no layout, so the scroll box's metrics are stubbed on the element
function stubScroll(el: HTMLElement, m: { top: number; height: number; client: number }) {
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => m.top, set: (v: number) => { m.top = v; } });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => m.height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => m.client });
  return m;
}

describe("conversations: the open thread follows new messages", () => {
  it("a message batch for the open chat refetches once after the debounce and the new message shows", async () => {
    const { events, thread, threadCalls } = setup();
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("Coffee?");
    const n0 = threadCalls().length;

    thread.push(msg("m3", "2026-10-09T10:02:00.000Z", "On my way"));
    act(() => {
      events.emit("ingest.committed", { kind: "message_batch", conversationId: "c1", platform: "telegram", inserted: 1 });
      events.emit("ingest.committed", { kind: "message_batch", conversationId: "c1", platform: "telegram", inserted: 0, edited: 1 });
    });
    expect(threadCalls()).toHaveLength(n0); // nothing until the debounce elapses
    expect(await within(log).findByText("On my way", {}, { timeout: 2000 })).toBeInTheDocument();
    await sleep(700);
    expect(threadCalls()).toHaveLength(n0 + 1); // two events, one refetch
    // the newest-messages window grows by the new message so the older ones stay on screen
    expect(threadCalls().at(-1)!.arg).toMatchObject({ before: 41, after: 40 });
  });

  it("a commit for another chat, or of another kind, does not refetch the open thread", async () => {
    const { events, threadCalls } = setup();
    await within(await screen.findByRole("log", { name: "Messages" })).findByText("Coffee?");
    const n0 = threadCalls().length;
    act(() => {
      events.emit("ingest.committed", { kind: "message_batch", conversationId: "c2", platform: "telegram", inserted: 3 });
      events.emit("ingest.committed", { kind: "screenshot", mediaId: "s1" });
    });
    await sleep(800);
    expect(threadCalls()).toHaveLength(n0);
  });

  it("a message batch that does not name its conversation still refreshes the thread", async () => {
    const { events, thread, threadCalls } = setup();
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("Coffee?");
    const n0 = threadCalls().length;
    thread.push(msg("m3", "2026-10-09T10:02:00.000Z", "Unattributed"));
    act(() => events.emit("ingest.committed", { kind: "message_batch" }));
    expect(await within(log).findByText("Unattributed", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(threadCalls()).toHaveLength(n0 + 1);
  });

  it("anchored on a search hit, new messages still appear", async () => {
    const { events, thread } = setup("/conversations?chat=c1&around=m1");
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByTestId("thread-hit");
    thread.push(msg("m3", "2026-10-09T10:02:00.000Z", "After the hit"));
    act(() => events.emit("ingest.committed", { kind: "message_batch", conversationId: "c1", inserted: 1 }));
    expect(await within(log).findByText("After the hit", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(within(log).getByTestId("thread-hit")).toHaveTextContent("Morning"); // still anchored
  });

  it("a reader at the bottom stays pinned to it when new messages land", async () => {
    let grown = false; // the content grows only once the refetched window renders
    const { events, thread } = setup("/conversations", () => { if (grown) m.height = 1100; });
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("Coffee?");
    const m = stubScroll(log, { top: 550, height: 1000, client: 400 }); // 50 px from the bottom
    grown = true;
    thread.push(msg("m3", "2026-10-09T10:02:00.000Z", "Pinned"));
    act(() => events.emit("ingest.committed", { kind: "message_batch", conversationId: "c1", inserted: 1 }));
    await within(log).findByText("Pinned", {}, { timeout: 2000 });
    await waitFor(() => expect(m.top).toBe(1100));
  });

  it("a reader scrolled up into history keeps their place", async () => {
    let grown = false;
    const { events, thread } = setup("/conversations", () => { if (grown) m.height = 1100; });
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("Coffee?");
    const m = stubScroll(log, { top: 100, height: 1000, client: 400 });
    grown = true;
    thread.push(msg("m3", "2026-10-09T10:02:00.000Z", "Not yanked"));
    act(() => events.emit("ingest.committed", { kind: "message_batch", conversationId: "c1", inserted: 1 }));
    await within(log).findByText("Not yanked", {}, { timeout: 2000 });
    await sleep(50);
    expect(m.top).toBe(100);
  });

  it("helpers: near-bottom, event matching, window growth", () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 520, scrollHeight: 1000, clientHeight: 400 })).toBe(true); // exactly 80 px
    expect(isNearBottom({ scrollTop: 519, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true); // nothing to scroll

    const ev = (data: Record<string, unknown>) => ({ at: "", type: "ingest.committed", data });
    expect(commitTouches(ev({ kind: "message_batch", conversationId: "c1" }), "c1")).toBe(true);
    expect(commitTouches(ev({ kind: "message_batch", conversationId: "c2" }), "c1")).toBe(false);
    expect(commitTouches(ev({ kind: "message_batch" }), "c1")).toBe(true);
    expect(commitTouches(ev({ kind: "file_meta", conversationId: "c1" }), "c1")).toBe(false);

    const ids = ["a", "b", "c", "d"];
    // newest window: keep the older messages by growing `before`, capped at the service limit
    expect(liveWindow({ around: null, ids, before: 40, after: 40, grow: 2 })).toEqual({ before: 42, after: 40 });
    expect(liveWindow({ around: null, ids, before: 200, after: 40, grow: 2 })).toBeNull();
    expect(liveWindow({ around: null, ids, before: 40, after: 40, grow: 0 })).toBeNull(); // edits only
    // anchored: room left in `after` needs nothing; a full `after` that reaches the newest grows
    expect(liveWindow({ around: "b", ids, before: 40, after: 40, grow: 1 })).toBeNull();
    expect(liveWindow({ around: "b", ids, before: 40, after: 3, grow: 2 })).toEqual({ before: 40, after: 4 });
    // anchored far back (more newer messages than shown): new ones would not be in view anyway
    expect(liveWindow({ around: "b", ids, before: 40, after: 2, grow: 1 })).toBeNull();
  });
});
