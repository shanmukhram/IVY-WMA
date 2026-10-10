import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationsView } from "../src/views/Conversations.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const LINE_PATH = "/conversations?source=windows:line-desktop&platform=line";
const TG_PATH = "/conversations?source=windows:telegram-desktop&platform=telegram";

const account = {
  account: "self-line", profile: { mid: "u0001", displayName: "Bunny", userId: "bunny-line", statusMessage: "Backing everything up" },
  counts: { contacts: 3, hidden: 2, blocked: 0, settings: 2 },
};
const contacts = {
  all: [
    { mid: "u1", displayName: "Aiko Tanaka", statusMessage: "Out surfing" },
    { mid: "u2", displayName: "Kenji", status: "FRIEND" },
  ],
  blocked: [{ mid: "u9", displayName: "Spammer", blocked: true, statusMessage: "" }],
};
const hidden = [{ chatId: "h1", title: "Old project room", lastAt: "2026-10-01T09:00:00.000Z" }];
const settings = [{ key: "notifications.enabled", value: true }, { key: "theme", value: "dark" }];

/** A LINE source view with no chats (the toolbar still shows); routes overridable per test. */
function lineRoutes(over: Record<string, unknown> = {}) {
  return {
    "GET /api/views/chats": { total: 0, page: 1, pages: 1, items: [] },
    "GET /api/views/line/account": account,
    "GET /api/views/line/contacts": (q: any) => (q?.filter === "blocked" ? contacts.blocked : contacts.all),
    "GET /api/views/line/hidden": hidden,
    "GET /api/views/line/settings": settings,
    ...over,
  };
}

describe("LINE area: toolbar, sheets, settings", () => {
  it("shows the toolbar for a LINE source, not for Telegram", async () => {
    const api = mockApi(lineRoutes());
    const { unmount } = renderWith(<ConversationsView />, api, { path: LINE_PATH });
    const bar = await screen.findByRole("group", { name: "LINE" });
    expect(within(bar).getByRole("button", { name: "Hidden chats (2)" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Blocked contacts (0)" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "LINE settings" })).toBeInTheDocument();
    unmount();

    renderWith(<ConversationsView />, mockApi({ "GET /api/views/chats": { total: 0, page: 1, pages: 1, items: [] } }), { path: TG_PATH });
    await screen.findByRole("region", { name: "Chats" });
    expect(screen.queryByRole("group", { name: "LINE" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Hidden chats/ })).toBeNull();
  });

  it("hidden chats open in a sheet, with an honest empty state and a list when present", async () => {
    const user = userEvent.setup();
    // empty first
    const empty = renderWith(<ConversationsView />, mockApi(lineRoutes({ "GET /api/views/line/hidden": [] })), { path: LINE_PATH });
    await user.click(await screen.findByRole("button", { name: "Hidden chats (2)" }));
    const sheet = await screen.findByRole("complementary", { name: "Hidden chats" });
    expect(await within(sheet).findByText("No hidden chats")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Hidden chats" })).toBeNull());
    empty.unmount();

    // with items
    renderWith(<ConversationsView />, mockApi(lineRoutes()), { path: LINE_PATH });
    await user.click(await screen.findByRole("button", { name: "Hidden chats (2)" }));
    const withItems = await screen.findByRole("complementary", { name: "Hidden chats" });
    expect(await within(withItems).findByText("Old project room")).toBeInTheDocument();
    expect(within(withItems).getByTestId("line-hidden-row")).toBeInTheDocument();
  });

  it("blocked contacts show a clear empty state when there are none", async () => {
    const user = userEvent.setup();
    const api = mockApi(lineRoutes({ "GET /api/views/line/contacts": [] }));
    renderWith(<ConversationsView />, api, { path: LINE_PATH });
    await user.click(await screen.findByRole("button", { name: "Blocked contacts (0)" }));
    const sheet = await screen.findByRole("complementary", { name: "Blocked contacts" });
    expect(await within(sheet).findByText("No blocked contacts")).toBeInTheDocument();
    // it asked the service for the blocked subset only
    expect(api.calls.some((c) => c.path === "/api/views/line/contacts" && c.arg?.filter === "blocked")).toBe(true);
  });

  it("empty routes (404) read as empty areas, not errors", async () => {
    const user = userEvent.setup();
    // no hidden route at all -> the loader's 404 fallback shows the empty state
    renderWith(<ConversationsView />, mockApi({ "GET /api/views/chats": { total: 0, page: 1, pages: 1, items: [] }, "GET /api/views/line/account": account }), { path: LINE_PATH });
    await user.click(await screen.findByRole("button", { name: "Hidden chats (2)" }));
    const sheet = await screen.findByRole("complementary", { name: "Hidden chats" });
    expect(await within(sheet).findByText("No hidden chats")).toBeInTheDocument();
    expect(within(sheet).queryByRole("alert")).toBeNull();
  });

  it("the settings area shows the profile, filters contacts All/Blocked, and lists settings", async () => {
    const user = userEvent.setup();
    const api = mockApi(lineRoutes());
    renderWith(<ConversationsView />, api, { path: LINE_PATH });
    await user.click(await screen.findByRole("button", { name: "LINE settings" }));
    const dlg = await screen.findByRole("dialog", { name: "LINE settings" });

    // own profile
    expect(within(dlg).getByText("Bunny")).toBeInTheDocument();
    expect(within(dlg).getByText("Backing everything up")).toBeInTheDocument();
    expect(within(dlg).getByRole("img", { name: "Bunny avatar" })).toBeInTheDocument();

    // contacts (All): display name and, muted, the raw status
    const contactRows = await within(dlg).findAllByTestId("line-contact");
    expect(contactRows).toHaveLength(2);
    expect(within(dlg).getByText("Aiko Tanaka")).toBeInTheDocument();
    expect(within(dlg).getByText("Out surfing")).toBeInTheDocument();

    // switch to Blocked: it refetches and shows the blocked contact with the API's own flag
    await user.click(within(dlg).getByRole("button", { name: "Blocked" }));
    await within(dlg).findByText("Spammer");
    expect(within(dlg).getByText("blocked")).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/api/views/line/contacts" && c.arg?.filter === "blocked")).toBe(true);

    // settings key/values and hidden chats
    expect(within(dlg).getByText("notifications.enabled")).toBeInTheDocument();
    expect(within(dlg).getAllByTestId("line-setting")).toHaveLength(2);
    expect(within(dlg).getByText("Old project room")).toBeInTheDocument();

    // Esc closes the settings area
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "LINE settings" })).toBeNull());
  });
});
