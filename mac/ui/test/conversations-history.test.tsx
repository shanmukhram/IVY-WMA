import { describe, it, expect } from "vitest";
import { screen, within, waitFor, act, fireEvent } from "@testing-library/react";
import { ConversationsView } from "../src/views/Conversations.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const ME = "5521004";
const chat = (id: string, peer: string) => ({
  id, platform: "telegram", account: ME, convKey: `k-${id}`, peer, kind: "dm", coverage: "complete",
  coverageSources: [{ source: "windows:telegram-desktop", coverage: "complete" }], coverageText: "complete via windows:telegram-desktop",
  messageCount: 0, lastMessageAt: "2026-10-09T10:00:00.000Z", lastMessage: null,
});
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const mid = (n: number) => `m${String(n).padStart(4, "0")}`;
const msg = (n: number) => ({ id: mid(n), fromMe: false, sender: "77", senderName: "Aiko", sentAt: new Date(T0 + n * 60_000).toISOString(), text: `text ${n}`, attachments: [] });
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** A fake thread route that behaves like the service: the newest (or `around`) pivot, `before` older, up to `after` newer, both capped at 200. */
function setup(n: number, path = "/conversations", gate?: (q: any, i: number) => Promise<void> | void) {
  const thread = Array.from({ length: n }, (_, i) => msg(i + 1));
  let i = 0;
  const api = mockApi({
    "GET /api/views/chats": { total: 1, page: 1, pages: 1, items: [chat("c1", "Aiko")] },
    "GET /api/views/chats/c1/messages": async (q: any) => {
      await gate?.(q, i++);
      const before = Math.min(200, q.before ?? 40), after = Math.min(200, q.after ?? 40);
      let p = q.around ? thread.findIndex((m) => m.id === q.around) : -1;
      if (p < 0) p = thread.length - 1;
      return { around: q.around ?? null, conversation: chat("c1", "Aiko"), messages: [...thread.slice(Math.max(0, p - before), p), ...thread.slice(p, p + after + 1)] };
    },
  });
  const r = renderWith(<ConversationsView />, api, { path });
  const threadCalls = () => api.calls.filter((c) => c.path === "/api/views/chats/c1/messages");
  return { ...r, api, thread, threadCalls };
}
const shownIds = (log: HTMLElement) => [...log.querySelectorAll<HTMLElement>("[data-mid]")].map((e) => e.dataset.mid!);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => mid(a + i));

describe("conversations: thread history and the latest-jump", () => {
  it("there is no later button; the latest-jump shows only when opened at a search hit and drops the anchor", async () => {
    setup(100);
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("text 100");
    expect(within(log).queryByRole("button", { name: /load later/i })).toBeNull();
    expect(within(log).queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("at a search hit, Jump to latest navigates to the chat without around and shows the newest", async () => {
    setup(300, "/conversations?chat=c1&around=m0050");
    const log = await screen.findByRole("log", { name: "Messages" });
    expect(await within(log).findByTestId("thread-hit")).toHaveTextContent("text 50");
    expect(within(log).queryByText("text 300")).toBeNull();
    expect(within(log).queryByRole("button", { name: /load later/i })).toBeNull();
    fireEvent.click(within(log).getByRole("button", { name: "Jump to latest" }));
    const log2 = await screen.findByRole("log", { name: "Messages" });
    expect(await within(log2).findByText("text 300")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("around")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("chat")).toBe("c1");
    expect(within(log2).queryByTestId("thread-hit")).toBeNull();
    expect(within(log2).queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("one click on Load earlier pages back to the first message, in order, without duplicates, then hides", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // hold the second history page so the progress label can be seen
    const { threadCalls } = setup(450, "/conversations", (_q, i) => (i === 2 ? held : undefined));
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("text 450");
    expect(shownIds(log)).toEqual(range(410, 450));
    fireEvent.click(within(log).getByRole("button", { name: "Load earlier messages" }));
    const busy = await within(log).findByRole("button", { name: "Loading history… 241 messages" });
    expect(busy).toBeDisabled();
    release();
    await waitFor(() => expect(within(log).queryByRole("button", { name: /Load earlier|Loading history/ })).toBeNull());
    const ids = shownIds(log);
    expect(ids).toEqual(range(1, 450));
    expect(new Set(ids).size).toBe(450);
    expect(threadCalls().slice(1).map((c) => c.arg)).toEqual([
      { around: "m0410", before: 200, after: 0 },
      { around: "m0210", before: 200, after: 0 },
      { around: "m0010", before: 200, after: 0 },
    ]);
  });

  it("no earlier button when the first window already holds the whole chat", async () => {
    setup(12);
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("text 12");
    expect(within(log).queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  });

  it("after a full history load, live commits append new messages and keep the earlier ones (including past the 200 cap)", async () => {
    const { events, thread } = setup(450);
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("text 450");
    fireEvent.click(within(log).getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(shownIds(log)).toHaveLength(450));

    // one new message: the window grows by one
    thread.push(msg(451));
    act(() => events.emit("ingest.committed", { kind: "message_batch", conversationId: "c1", inserted: 1 }));
    await within(log).findByText("text 451", {}, { timeout: 2000 });
    expect(shownIds(log)).toEqual(range(1, 451));

    // 200 more: the window hits its cap and its start moves forward; the folded history covers the rest
    for (let k = 452; k <= 651; k++) thread.push(msg(k));
    act(() => events.emit("ingest.committed", { kind: "message_batch", conversationId: "c1", inserted: 200 }));
    await within(log).findByText("text 651", {}, { timeout: 2000 });
    await sleep(50);
    expect(shownIds(log)).toEqual(range(1, 651));

    // more new messages than the window holds: the gap is paged forward
    for (let k = 652; k <= 951; k++) thread.push(msg(k));
    act(() => events.emit("ingest.committed", { kind: "message_batch", conversationId: "c1", inserted: 300 }));
    await within(log).findByText("text 951", {}, { timeout: 2000 });
    await waitFor(() => expect(shownIds(log)).toEqual(range(1, 951)));
  }, 20_000);
});
