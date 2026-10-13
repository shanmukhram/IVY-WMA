import { describe, it, expect, beforeEach } from "vitest";
import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.tsx";
import { ApiError } from "../src/api.ts";
import { SearchView } from "../src/views/Search.tsx";
import { TimelineView } from "../src/views/Timeline.tsx";
import { DevicesView } from "../src/views/Devices.tsx";
import { mockApi, renderWith } from "./helpers.tsx";
import { WIN, shellRoutes } from "./fixtures.ts";

const unlocked = { "GET /api/keystore": { state: "unlocked", fingerprint: "F", keyInMemory: true } };
const W2 = "22222222-2222-3333-4444-555555555555";
const AND = "33333333-2222-3333-4444-555555555555";
const devices = { macFingerprint: "MAC1-MAC2-MAC3-MAC4", devices: [
  { id: WIN, role: "windows", fingerprint: "AAAA-BBBB-CCCC-DDDD" },
  { id: W2, role: "windows", fingerprint: "EEEE-FFFF-0000-1111", name: "Old laptop" },
  { id: AND, role: "android", fingerprint: "PPPP-QQQQ-RRRR-SSSS" },
] };
const day = { window: { from: "2026-10-09T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z", tz: "UTC" }, page: 1, pages: 1, total: 0, counts: {}, hours: [], gaps: [], items: [], unavailable: [] };

describe("device scope", () => {
  beforeEach(() => localStorage.clear());

  it("lists every paired device under its role; choosing one scopes the view and shows the chip; clearing returns to everything", async () => {
    const api = mockApi({ ...shellRoutes, ...unlocked, "GET /api/devices": devices, "GET /api/timeline": day });
    const { events } = renderWith(<App />, api, { path: "/timeline" });
    const nav = await screen.findByRole("navigation", { name: "Sidebar" });
    const u = userEvent.setup();
    await u.click(within(nav).getByRole("button", { name: "Windows" }));
    await u.click(within(nav).getByRole("button", { name: "Android" }));
    const win = within(nav).getByRole("group", { name: "Windows" });
    // the device's name when it has one, else its fingerprint; a status dot (or "no report") beside it
    await waitFor(() => expect(within(win).getAllByRole("link", { name: /^Windows device / }).map((l) => l.textContent)).toEqual(["AAAA-BBBB-CCCC-DDDD", "Old laptopno report"]));
    expect(within(within(win).getByRole("link", { name: "Windows device AAAA-BBBB-CCCC-DDDD" })).getByRole("img", { name: "AAAA-BBBB-CCCC-DDDD red" })).toBeInTheDocument();
    const android = within(nav).getByRole("group", { name: "Android" });
    expect(within(android).getAllByRole("link", { name: /^Android device / }).map((l) => l.getAttribute("aria-label"))).toEqual(["Android device PPPP-QQQQ-RRRR-SSSS"]);
    expect(screen.queryByTestId("scope-chip")).toBeNull();
    expect(api.calls.filter((c) => c.path === "/api/timeline").every((c) => !c.arg.device)).toBe(true);

    // choosing a device keeps the current view and narrows it to that device
    await u.click(within(win).getByRole("link", { name: "Windows device Old laptop" }));
    expect(location.pathname).toBe("/timeline");
    expect(new URLSearchParams(location.search).get("device")).toBe(W2);
    expect(await screen.findByTestId("scope-chip")).toHaveTextContent("Showing: Windows · Old laptop");
    expect(within(win).getByRole("link", { name: "Windows device Old laptop" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/timeline").at(-1)!.arg.device).toBe(W2));
    expect(api.calls.filter((c) => c.path === "/api/views/sources").at(-1)!.arg.device).toBe(W2);

    // the scope follows the user to other pages; a page with no device dimension says so and keeps the chip
    await u.click(within(nav).getByRole("link", { name: "Settings" }));
    expect(new URLSearchParams(location.search).get("device")).toBe(W2);
    expect(screen.getByRole("region", { name: "Device scope" })).toHaveTextContent("This page is the same for every device.");
    await u.click(within(nav).getByRole("link", { name: "Timeline" }));

    // the role overview means every device of that role
    await u.click(within(win).getByRole("link", { name: "Windows overview" }));
    expect(await screen.findByTestId("scope-chip")).toHaveTextContent("Showing: Windows (all devices)");

    // clear returns to everything
    await u.click(screen.getByRole("button", { name: "Show all devices" }));
    expect(screen.queryByTestId("scope-chip")).toBeNull();
    expect(new URLSearchParams(location.search).has("device")).toBe(false);

    // a scope on a device that is then forgotten is cleared
    await u.click(within(android).getByRole("link", { name: "Android device PPPP-QQQQ-RRRR-SSSS" }));
    expect(await screen.findByTestId("scope-chip")).toHaveTextContent("Showing: Android · PPPP-QQQQ-RRRR-SSSS");
    act(() => events.emit("device.forgotten", { deviceId: AND, role: "android" }));
    await waitFor(() => expect(screen.queryByTestId("scope-chip")).toBeNull());
  });

  it("Search passes device=<id> while a scope is set and leaves it out otherwise", async () => {
    const result = { q: "collab", page: 1, pageSize: 25, total: 0, pages: 1, counts: {}, items: [] };
    const api = mockApi({ "GET /api/facets": { devices: [], apps: [], accounts: [], conversations: [] }, "GET /api/search": () => result });
    const r = renderWith(<SearchView />, api, { path: `/?q=collab&device=${W2}` });
    await waitFor(() => expect(api.calls.find((c) => c.path === "/api/search")?.arg).toMatchObject({ q: "collab", device: W2 }));
    r.unmount();
    api.calls.length = 0;
    renderWith(<SearchView />, api, { path: "/?q=collab" });
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/search")).toBe(true));
    expect(api.calls.filter((c) => c.path === "/api/search").every((c) => !c.arg.device)).toBe(true);
  });

  it("Timeline passes the scope too, and its device picker sets the same scope", async () => {
    const api = mockApi({ "GET /api/timeline": day });
    renderWith(<TimelineView />, api, { path: "/timeline" });
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/timeline")).toBe(true));
    expect(api.calls.at(-1)!.arg.device).toBeFalsy();
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText("Device"), "android");
    expect(new URLSearchParams(location.search).get("device")).toBe("android");
    await waitFor(() => expect(api.calls.at(-1)!.arg.device).toBe("android"));
  });
});

const footprint = {
  deviceId: "d1", role: "windows", fingerprint: "DEV1-DEV2-DEV3-DEV4", confirmWith: "fingerprint",
  counts: { messages: 1250, conversations: 12, messageSources: 1300, messageEdits: 4, attachments: 80, notifications: 900, media: 340, files: 160000, calls: 0, usageEvents: 5000,
    commands: 3, quarantine: 0, collectorState: 6, collectorHistory: 40, pairings: 1, ledger: 9000, mediaArchive: 410, blobs: 500 },
  shared: { messagesKept: 30, conversationsKept: 2 }, binRows: 7, cacheBytes: 2.5 * 1024 ** 3, leftInR2: { objects: 410, bytes: 3.2 * 1024 ** 3 },
};
const forgetResult = {
  forgotten: true, deviceId: "d1", removed: footprint.counts, shared: footprint.shared, cancelledCommands: 0, binPurged: 7, binNote: "",
  cacheBytesFreed: 2.5 * 1024 ** 3, cacheFilesRemoved: 900, leftInR2Bytes: 3.2 * 1024 ** 3, leftInR2Objects: 410,
  r2Note: "Nothing in R2 was changed.", tokenWarning: "The device's R2 tokens remain valid until you rotate them in the Cloudflare dashboard.",
};
const devRoutes = (del: unknown) => ({
  "GET /api/devices": { macFingerprint: "MAC1-MAC2-MAC3-MAC4", devices: [{ id: "d1", role: "windows", fingerprint: "DEV1-DEV2-DEV3-DEV4", pairedAt: "2026-10-01T00:00:00Z", revokeWarning: "Captured content stays in the vault." }] },
  "GET /api/devices/d1/footprint": footprint,
  "DELETE /api/devices/d1?wipe=1": del,
});

describe("forget a device", () => {
  it("shows the footprint, needs the fingerprint, then forgets and shows what was removed", async () => {
    const api = mockApi(devRoutes(() => forgetResult));
    renderWith(<DevicesView />, api, { path: "/devices" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Forget…" }));
    const sheet = screen.getByRole("dialog", { name: "Forget device" });
    const fp = await within(sheet).findByTestId("forget-footprint");
    expect(fp).toHaveTextContent("Messages1,250 (30 messages kept, because another device also captured them)");
    expect(fp).toHaveTextContent("Conversations12 (2 conversations kept");
    expect(fp).toHaveTextContent("Files160,000");
    expect(fp).toHaveTextContent("Photos and screenshots340");
    expect(fp).toHaveTextContent("Notifications900");
    expect(fp).toHaveTextContent("Calls0");
    expect(fp).toHaveTextContent("App usage events5,000");
    expect(fp).toHaveTextContent("Local cache freed2.50 GB");
    expect(within(sheet).getByText("7 items of this device in the recovery bin are removed too and cannot be restored.")).toBeInTheDocument();
    expect(within(sheet).getByTestId("forget-r2")).toHaveTextContent("410 media originals (3.20 GB) stay in your R2 bucket.");
    expect(sheet).toHaveTextContent("R2 is not changed");
    expect(sheet).toHaveTextContent("still works until you rotate it in Cloudflare");
    expect(within(sheet).getByTestId("forget-fingerprint")).toHaveTextContent("DEV1-DEV2-DEV3-DEV4");

    // disabled until the typed fingerprint matches (letter case and surrounding spaces ignored)
    const go = within(sheet).getByRole("button", { name: "Forget this device" });
    expect(go).toBeDisabled();
    const field = within(sheet).getByLabelText("Type the fingerprint to confirm");
    await u.type(field, "dev1-dev2-dev3-dev");
    expect(go).toBeDisabled();
    await u.type(field, "4 ");
    expect(go).toBeEnabled();
    await u.click(go);

    const del = api.calls.find((c) => c.method === "DELETE");
    expect(del).toEqual({ method: "DELETE", path: "/api/devices/d1?wipe=1", arg: { confirm: "dev1-dev2-dev3-dev4" } });
    const done = await screen.findByRole("dialog", { name: "Forget device" });
    expect(within(done).getByRole("status")).toHaveTextContent(
      "Removed 1,250 messages, 12 conversations, 160,000 files, 340 photos and screenshots, 900 notifications, 5,000 app usage events and freed 2.50 GB of local cache; 3.20 GB of media stays in R2.");
    expect(done).toHaveTextContent("rotate them in the Cloudflare dashboard");
    // the list is reloaded
    expect(api.calls.filter((c) => c.path === "/api/devices").length).toBeGreaterThan(1);
  });

  it("a rejected confirmation and a device that is gone get plain messages", async () => {
    const api = mockApi(devRoutes(() => { throw new ApiError(400, "bad_confirm", "confirm must be the device's fingerprint"); }));
    renderWith(<DevicesView />, api, { path: "/devices" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Forget…" }));
    const sheet = screen.getByRole("dialog", { name: "Forget device" });
    await u.type(await within(sheet).findByLabelText("Type the fingerprint to confirm"), "DEV1-DEV2-DEV3-DEV4");
    await u.click(within(sheet).getByRole("button", { name: "Forget this device" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("That is not this device's fingerprint.");

    api.routes["DELETE /api/devices/d1?wipe=1"] = () => { throw new ApiError(404, "not_found", "no such device"); };
    await u.click(within(sheet).getByRole("button", { name: "Forget this device" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("This device is no longer paired.");
  });

  it("revoke says it keeps the archive", async () => {
    renderWith(<DevicesView />, mockApi(devRoutes({})), { path: "/devices" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("dialog", { name: "Confirm revoke" })).toHaveTextContent("Everything it already captured stays in the archive on this Mac.");
  });
});
