/**
 * What was deleted in the owner's own app shows plainly: a whole chat carries a red "Deleted <when>" badge,
 * a chat with removed messages a red "<n> deleted" badge, the Deleted filter lists only those, and each removed
 * message keeps its text with the red mark and when it was noticed gone.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationsView } from "../src/views/Conversations.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const at = "2026-11-02T07:40:00.000Z";
const gone = "2026-11-06T09:15:00.000Z";
const chat = (id: string, peer: string, del: { deletedAtSource?: string | null; deletedMessages?: number } = {}) => ({
  id, platform: "line", account: "u-ivy", convKey: `k-${id}`, peer, kind: "dm", coverage: "partial", coverageSources: [], listing: "normal",
  muted: null, pinned: null, deletedAtSource: null, deletedMessages: 0, ...del,
  messageCount: 2, lastMessageAt: at, lastMessage: { id: `m-${id}`, sender: "u", sentAt: at, text: "hi" },
});
const all = [chat("c1", "Removed chat", { deletedAtSource: gone }), chat("c2", "Some removed", { deletedMessages: 9 }), chat("c3", "Untouched")];
const msg = (id: string, text: string, deletedAt: string | null) => ({
  id, msg_key: id, sender: "u-aki", sent_at: at, captured_at: at, text, reply_to: null, edited_at: null, forwarded_from: null, media_kind: null,
  source_status: deletedAt ? "deleted_at_source" : "live", source_deleted_at: deletedAt, attachments: [],
});
function routes() {
  return {
    "GET /api/views/chats": (arg: { listing?: string }) => {
      const items = arg.listing === "deleted" ? all.filter((c) => c.deletedAtSource || c.deletedMessages > 0) : all;
      return { total: items.length, page: 1, pages: 1, items };
    },
    "GET /api/views/chats/c1/messages": { around: null, conversation: all[0], messages: [msg("a", "still there", null), msg("b", "the removed text", gone)] },
    "GET /api/views/chats/c2/messages": { around: null, conversation: all[1], messages: [] },
    "GET /api/views/chats/c3/messages": { around: null, conversation: all[2], messages: [] },
    "GET /api/attachments": { items: [] },
    "GET /api/views/line/account": { counts: {} },
  };
}

beforeEach(() => { sessionStorage.clear(); });

describe("deleted at the source", () => {
  it("marks a removed chat with when, a chat with removed messages with how many, and nothing on the rest", async () => {
    renderWith(<ConversationsView />, mockApi(routes()), { path: "/conversations" });
    const rows = await within(await screen.findByRole("region", { name: "Chats" })).findAllByTestId("chat-item");
    expect(within(rows[0]!).getByTestId("deleted-badge")).toHaveTextContent(/^Deleted /);
    expect(within(rows[0]!).getByTestId("deleted-badge").querySelector(".badge")!.getAttribute("title")).toMatch(/Removed from LINE, first noticed .*IVY keeps every message/);
    expect(within(rows[1]!).getByTestId("deleted-badge")).toHaveTextContent("9 deleted");
    expect(within(rows[2]!).queryByTestId("deleted-badge")).toBeNull();
  });

  it("the Deleted filter lists only chats with a deletion", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    renderWith(<ConversationsView />, api, { path: "/conversations" });
    const group = await screen.findByRole("group", { name: "Show chats" });
    await user.click(within(group).getByRole("button", { name: "Deleted" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/views/chats").at(-1)!.arg.listing).toBe("deleted"));
    const list = screen.getByRole("region", { name: "Chats" });
    await waitFor(() => expect(within(list).getAllByTestId("chat-item")).toHaveLength(2));
  });

  it("a removed message keeps its text, with the red mark and when it was noticed gone", async () => {
    renderWith(<ConversationsView />, mockApi(routes()), { path: "/conversations" });
    const log = await screen.findByRole("log", { name: "Messages" });
    await within(log).findByText("the removed text");
    const bubbles = within(log).getAllByTestId("message");
    expect(within(bubbles[0]!).queryByTestId("deleted-at")).toBeNull();
    expect(within(bubbles[1]!).getByText("deleted at source (kept in vault)")).toBeInTheDocument();
    const when = within(bubbles[1]!).getByTestId("deleted-at");
    expect(when).toHaveAttribute("dateTime", gone);
    expect(when.getAttribute("title")).toMatch(/^first noticed gone /);
    // the open chat's header says the chat itself was removed
    expect(within(screen.getByRole("region", { name: "Chat" })).getByTestId("deleted-badge")).toHaveTextContent(/^Deleted /);
  });
});
