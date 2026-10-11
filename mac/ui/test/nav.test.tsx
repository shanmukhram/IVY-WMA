import { describe, it, expect, beforeEach } from "vitest";
import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.tsx";
import { mockApi, renderWith } from "./helpers.tsx";
import { shellRoutes } from "./fixtures.ts";

const unlocked = { "GET /api/keystore": { state: "unlocked", fingerprint: "F", keyInMemory: true } };

describe("sidebar navigation", () => {
  beforeEach(() => localStorage.clear());

  it("has sections, collapsible device groups, per-source conversation entries, and no top bar", async () => {
    renderWith(<App />, mockApi({ ...shellRoutes, ...unlocked }));
    const nav = await screen.findByRole("navigation", { name: "Sidebar" });
    expect(screen.queryByRole("banner")).toBeNull();
    for (const name of ["Search", "Timeline", "Ask AI", "Media", "Files", "Notifications", "All chats", "Coverage", "Devices", "Recovery bin", "Settings"]) {
      expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    }
    // a skip link comes first; coverage problems are written out, not shown by colour alone
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    const cov = within(nav).getByRole("link", { name: "Coverage" });
    expect(await within(cov).findByText("2 problem(s) need attention")).toBeInTheDocument();
    expect(cov).toHaveAccessibleDescription("2 problem(s) need attention");
    // conversation sources and chat sources under devices carry their app's icon
    expect((await within(nav).findByRole("link", { name: /Telegram · Windows/ })).querySelector("[data-app-icon='telegram']")).not.toBeNull();
    // the current page is marked
    expect(within(nav).getByRole("link", { name: "Search" })).toHaveAttribute("aria-current", "page");
    // one conversation entry per capture source, from the API
    const tg = await within(nav).findByRole("link", { name: /Telegram · Windows/ });
    expect(tg).toHaveAttribute("href", "/conversations?source=windows%3Atelegram-desktop&platform=telegram");
    expect(within(nav).getByRole("link", { name: /LINE · Windows/ })).toBeInTheDocument();

    // device groups start collapsed and expand on click
    const win = within(nav).getByRole("button", { name: "Windows" });
    expect(win).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).queryByRole("link", { name: "Windows Files" })).toBeNull();
    const u = userEvent.setup();
    await u.click(win);
    expect(win).toHaveAttribute("aria-expanded", "true");
    const group = within(nav).getByRole("group", { name: "Windows" });
    expect(within(group).getAllByRole("link").map((l) => l.getAttribute("aria-label"))).toEqual(
      ["Windows overview", "Windows Files", "Windows Browse PC", "Windows Screenshots", "Windows Usage", "Windows Notifications", "Windows Telegram", "Windows LINE"]);
    await u.click(within(nav).getByRole("button", { name: "Android" }));
    const android = within(nav).getByRole("group", { name: "Android" });
    expect(within(android).getAllByRole("link").map((l) => l.getAttribute("aria-label"))).toEqual(
      ["Android overview", "Android Notifications", "Android Calls", "Android Usage", "Android Media", "Android LINE", "Android Telegram", "Android WhatsApp", "Android SMS"]);
    expect(within(android).getByRole("link", { name: "Android overview" })).toHaveTextContent("not paired");
    // collapsing again hides it, and the choice is remembered
    await u.click(win);
    expect(within(nav).queryByRole("group", { name: "Windows" })).toBeNull();
    expect(localStorage.getItem("ivy.nav.windows")).toBe("0");
  });

  it("routes: a link changes the view and the selection", async () => {
    const api = mockApi({ ...shellRoutes, ...unlocked,
      "GET /api/timeline": { window: { from: "2026-10-09T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z", tz: "UTC" }, page: 1, pages: 1, total: 0, counts: {}, hours: [], gaps: [], items: [], unavailable: [] },
      "GET /api/views/records": { total: 0, page: 1, pages: 1, items: [] },
    });
    renderWith(<App />, api);
    const nav = await screen.findByRole("navigation", { name: "Sidebar" });
    const u = userEvent.setup();
    await u.click(within(nav).getByRole("link", { name: "Timeline" }));
    expect(location.pathname).toBe("/timeline");
    expect(await screen.findByRole("heading", { name: "Timeline", level: 1 })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Timeline" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Search" })).not.toHaveAttribute("aria-current");

    // a device source opens the per-device view: status card + the source filtered to that device
    await u.click(within(nav).getByRole("button", { name: "Windows" }));
    await u.click(within(nav).getByRole("link", { name: "Windows Files" }));
    expect(location.pathname).toBe("/device/windows/files");
    expect(await screen.findByRole("region", { name: "Windows status" })).toHaveTextContent("AAAA-BBBB-CCCC-DDDD");
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/views/records" && c.arg.type === "file" && c.arg.device === "windows")).toBe(true));
  });

  it("a device with nothing paired says so honestly", async () => {
    renderWith(<App />, mockApi({ ...shellRoutes, ...unlocked }), { path: "/device/android/notifications" });
    expect(await screen.findByText(/Nothing from Android yet: pair the phone under Devices/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pair under Devices" })).toHaveAttribute("href", "/devices");
  });

  it("the activity panel slides over, newest first", async () => {
    const api = mockApi({ ...shellRoutes, ...unlocked, "GET /api/activity": { events: [{ id: 2, at: "2026-10-10T10:00:01Z", type: "file.cached", data: { fileId: "f" } }, { id: 1, at: "2026-10-10T10:00:00Z", type: "ingest.poll", data: {} }] } });
    const { events } = renderWith(<App />, api);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Activity" }));
    const panel = screen.getByRole("complementary", { name: "Live activity" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(2));
    act(() => events.emit("command.sent", { commandId: "c9" }));
    expect(within(panel).getAllByRole("listitem").map((l) => l.querySelector(".act-type")!.textContent)).toEqual(["command.sent", "file.cached", "ingest.poll"]);
    await u.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Live activity" })).toBeNull();
  });
});
