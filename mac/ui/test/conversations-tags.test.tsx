/**
 * Every tag on a chat is shown with its own label (Hidden / Archived, Pinned, Muted) on the row and in the
 * open chat's header; a LINE chat with no captured message opens as an honest placeholder; and the chat
 * list loads every page, so the count shown equals the number of chats the service holds.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationsView, fetchAllChats } from "../src/views/Conversations.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const at = "2026-10-09T10:00:00.000Z";
const chat = (id: string, peer: string, tags: { listing?: string | null; muted?: boolean | null; pinned?: boolean | null; placeholder?: boolean } = {}, platform = "line") => ({
  id, platform, account: "u-ivy", convKey: `k-${id}`, peer, kind: "dm", coverage: "partial", coverageSources: [],
  listing: "normal", muted: null, pinned: null, ...tags,
  messageCount: tags.placeholder ? 0 : 1, lastMessageAt: tags.placeholder ? null : at,
  lastMessage: tags.placeholder ? null : { id: `m-${id}`, sender: "u", sentAt: at, text: "hi" },
});

beforeEach(() => { sessionStorage.clear(); });

describe("chat tags", () => {
  const all = [
    chat("c1", "Everything", { listing: "hidden", muted: true, pinned: true }),
    chat("c2", "Pinned only", { pinned: true, muted: false }),
    chat("c3", "Muted only", { muted: true, pinned: false }),
    chat("c4", "Plain", { muted: false, pinned: false }),
    chat("c5", "Telegram", { listing: "archived" }, "telegram"),
    chat("lineopt:u-ivy:m-g", "m-g", { placeholder: true, muted: true }),
  ];
  const routes = () => ({
    "GET /api/views/chats": { total: all.length, page: 1, pages: 1, items: all },
    ...Object.fromEntries(all.filter((c) => !c.placeholder).map((c) => [`GET /api/views/chats/${c.id}/messages`, { around: null, conversation: c, messages: [] }])),
    "GET /api/attachments": { items: [] },
    "GET /api/views/line/account": { counts: {} },
  });

  it("shows each tag with its own label on the rows, and nothing for a chat with none", async () => {
    renderWith(<ConversationsView />, mockApi(routes()), { path: "/conversations" });
    const list = await screen.findByRole("region", { name: "Chats" });
    const rows = await within(list).findAllByTestId("chat-item");
    expect(rows).toHaveLength(6);
    const tags = (row: HTMLElement) => ["listing-badge", "pinned-badge", "muted-badge"].flatMap((t) => within(row).queryAllByTestId(t).map((b) => b.textContent));
    expect(tags(rows[0]!)).toEqual(["Hidden", "Pinned", "Muted"]);
    expect(tags(rows[1]!)).toEqual(["Pinned"]);
    expect(tags(rows[2]!)).toEqual(["Muted"]);
    expect(tags(rows[3]!)).toEqual([]);
    expect(tags(rows[4]!)).toEqual(["Archived"]);
    expect(rows[0]).toHaveAttribute("data-listing", "hidden");
    expect(within(rows[1]!).getByTitle("Pinned in LINE")).toBeInTheDocument();
  });

  it("the open chat's header carries its tags", async () => {
    renderWith(<ConversationsView />, mockApi(routes()), { path: "/conversations" });
    await within(await screen.findByRole("region", { name: "Chats" })).findAllByTestId("chat-item");
    // the first chat (hidden, pinned, muted) is open
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Chat" })).getByTestId("listing-badge")).toHaveTextContent("Hidden"));
    const main = screen.getByRole("region", { name: "Chat" });
    expect(within(main).getByTestId("pinned-badge")).toHaveTextContent("Pinned");
    expect(within(main).getByTestId("muted-badge")).toHaveTextContent("Muted");
  });

  it("a chat LINE lists with no captured message opens as a placeholder, without asking for its messages", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    renderWith(<ConversationsView />, api, { path: "/conversations" });
    const list = await screen.findByRole("region", { name: "Chats" });
    const row = (await within(list).findAllByTestId("chat-item"))[5]!;
    expect(row).toHaveAttribute("data-placeholder", "true");
    expect(row).toHaveTextContent("No messages captured on this PC");
    await user.click(row);
    const pane = await screen.findByTestId("placeholder-chat");
    expect(pane).toHaveTextContent("No messages captured on this PC");
    expect(within(pane).getByTestId("muted-badge")).toHaveTextContent("Muted");
    expect(api.calls.some((c) => c.path.includes("lineopt:"))).toBe(false);
  });
});

describe("the chat list loads every page", () => {
  const many = Array.from({ length: 1203 }, (_, i) => chat(`c${i}`, `Chat ${i}`));
  const paged = (arg: { page?: number; pageSize?: number }) => {
    const size = arg.pageSize ?? 200, page = arg.page ?? 1;
    return { total: many.length, page, pageSize: size, pages: Math.ceil(many.length / size), items: many.slice((page - 1) * size, page * size) };
  };

  it("renders every chat and shows the same count the service reports", async () => {
    const api = mockApi({
      "GET /api/views/chats": paged,
      "GET /api/views/chats/c0/messages": { around: null, conversation: many[0], messages: [] },
      "GET /api/attachments": { items: [] },
      "GET /api/views/line/account": { counts: {} },
    });
    renderWith(<ConversationsView />, api, { path: "/conversations" });
    const list = await screen.findByRole("region", { name: "Chats" });
    await waitFor(() => expect(within(list).getAllByTestId("chat-item")).toHaveLength(1203));
    expect(within(list).getByText("1203")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path === "/api/views/chats").map((c) => c.arg.page)).toEqual([1, 2, 3]);
  });

  it("keeps a chat once when it shifts between pages while they load", async () => {
    let n = 0;
    const api = mockApi({
      "GET /api/views/chats": (arg: { page: number }) => {
        n++;
        // page 2 repeats the last chat of page 1, as if a new chat had pushed the list down
        return arg.page === 1 ? { total: 3, pages: 2, items: [chat("a", "A"), chat("b", "B")] } : { total: 3, pages: 2, items: [chat("b", "B"), chat("c", "C")] };
      },
    });
    const r = await fetchAllChats(api, {});
    expect(n).toBe(2);
    expect(r.items.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});
