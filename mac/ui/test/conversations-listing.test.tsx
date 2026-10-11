/** Archived (Telegram) and hidden (LINE) chats: a badge on the chat row and thread header, and a filter in the chat list header. */
import { describe, it, expect, beforeEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationsView } from "../src/views/Conversations.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const chat = (id: string, peer: string, listing: string | null, platform = "telegram") => ({
  id, platform, account: "777", convKey: `k-${id}`, peer, kind: "dm", coverage: "complete", coverageSources: [], listing,
  messageCount: 1, lastMessageAt: "2026-10-09T10:00:00.000Z", lastMessage: { id: "x", sender: "u", sentAt: "2026-10-09T10:00:00.000Z", text: "hi" },
});
const all = [chat("c1", "Alice", "archived"), chat("c2", "Bob", "normal"), chat("c3", "Carol", null), chat("c4", "Dee", "hidden", "line")];

function routes() {
  const thread = (c: ReturnType<typeof chat>) => ({ around: null, conversation: c, messages: [] });
  return {
    "GET /api/views/chats": (arg: { listing?: string }) => {
      const l = arg.listing;
      const items = !l ? all : all.filter((c) => (l === "normal" ? c.listing === null || c.listing === "normal" : c.listing === l));
      return { total: items.length, page: 1, pages: 1, items };
    },
    "GET /api/views/chats/c1/messages": thread(all[0]!),
    "GET /api/views/chats/c2/messages": thread(all[1]!),
    "GET /api/views/chats/c3/messages": thread(all[2]!),
    "GET /api/views/chats/c4/messages": thread(all[3]!),
    "GET /api/attachments": { items: [] },
    "GET /api/views/line/account": { counts: {} },
  };
}

beforeEach(() => { sessionStorage.clear(); });

describe("chat listing: badges and filter", () => {
  it("shows Archived / Hidden badges on rows and in the thread header, none for normal or unknown", async () => {
    const api = mockApi(routes());
    renderWith(<ConversationsView />, api, { path: "/conversations" });
    const list = await screen.findByRole("region", { name: "Chats" });
    const items = await within(list).findAllByTestId("chat-item");
    expect(items).toHaveLength(4);
    expect(within(items[0]!).getByTestId("listing-badge")).toHaveTextContent("Archived");
    expect(within(items[0]!).getByTitle("Archived in Telegram")).toBeInTheDocument();
    expect(within(items[1]!).queryByTestId("listing-badge")).toBeNull();
    expect(within(items[2]!).queryByTestId("listing-badge")).toBeNull();
    expect(within(items[3]!).getByTestId("listing-badge")).toHaveTextContent("Hidden");

    // the first chat (archived) is open: its header carries the badge too
    const main = await screen.findByRole("region", { name: "Chat" });
    await waitFor(() => expect(within(main).getByTestId("listing-badge")).toHaveTextContent("Archived"));
  });

  it("filters All / Normal / Archived / Hidden, defaults to All, and remembers the choice for the session", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    const { unmount } = renderWith(<ConversationsView />, api, { path: "/conversations" });
    const group = await screen.findByRole("group", { name: "Show chats" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Normal", "Archived", "Hidden"]);
    expect(within(group).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(api.calls.find((c) => c.path === "/api/views/chats")!.arg.listing).toBeUndefined(); // All sends no filter

    await user.click(within(group).getByRole("button", { name: "Archived" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/views/chats").at(-1)!.arg.listing).toBe("archived"));
    const list = screen.getByRole("region", { name: "Chats" });
    await waitFor(() => expect(within(list).getAllByTestId("chat-item").map((i) => i.textContent)).toEqual([expect.stringContaining("Alice")]));

    await user.click(within(group).getByRole("button", { name: "Normal" }));
    await waitFor(() => expect(within(list).getAllByTestId("chat-item")).toHaveLength(2)); // normal and unknown

    await user.click(within(group).getByRole("button", { name: "Hidden" }));
    await waitFor(() => expect(within(list).getAllByTestId("chat-item").map((i) => i.textContent)).toEqual([expect.stringContaining("Dee")]));
    unmount();

    // a fresh view in the same session starts on Hidden
    const api2 = mockApi(routes());
    renderWith(<ConversationsView />, api2, { path: "/conversations" });
    const group2 = await screen.findByRole("group", { name: "Show chats" });
    expect(within(group2).getByRole("button", { name: "Hidden" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(api2.calls.find((c) => c.path === "/api/views/chats")!.arg.listing).toBe("hidden"));
  });

  it("an empty filtered list says so and points back to All", async () => {
    const api = mockApi({ ...routes(), "GET /api/views/chats": (arg: { listing?: string }) =>
      arg.listing ? { total: 0, page: 1, pages: 1, items: [] } : { total: all.length, page: 1, pages: 1, items: all } });
    sessionStorage.setItem("ivy.chats.listing", "archived");
    renderWith(<ConversationsView />, api, { path: "/conversations" });
    expect(await screen.findByText("No archived chats")).toBeInTheDocument();
    expect(screen.getByText("Choose All to see every chat.")).toBeInTheDocument();
  });
});
