import { describe, it, expect, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchView } from "../src/views/Search.tsx";
import { FilesView } from "../src/views/Files.tsx";
import { CoverageView, ImportsCoverage, gapsByDate } from "../src/views/Coverage.tsx";
import { DevicesView, countdown } from "../src/views/Devices.tsx";
import { BinView } from "../src/views/Bin.tsx";
import { NotificationsView } from "../src/views/Notifications.tsx";
import { SettingsView, buildR2Config } from "../src/views/Settings.tsx";
import { FEED_MAX, pushEvent } from "../src/views/Activity.tsx";
import { applyEvent, describe as describeReq, fromCommand } from "../src/request.ts";
import type { ServiceEvent } from "../src/events.ts";
import { mockApi, renderWith } from "./helpers.tsx";
import { WIN, coverage, item, now } from "./fixtures.ts";

function result(page: number, semantic = false) {
  return {
    q: "collab", page, pageSize: 25, pages: 3, total: 60, exactTotal: 58, fuzzyTotal: 2, tookMs: 3,
    counts: { file: { exact: 1, fuzzy: 0 }, message: { exact: 57, fuzzy: 2 } },
    items: [
      item({}),
      item({ type: "message", id: "m1", app: "line", title: "Aki", person: "Aki", eventTime: "2026-09-24T09:00:00.000Z", timeField: "sent_at",
        snippetHtml: "the <mark>collab</mark> offer", detail: { conversationId: "c1", platform: "line", account: "bunny@line", attachments: 0 } }),
      item({ type: "message", id: "m2", match: "fuzzy", typos: 1, app: "telegram", title: "Ben", snippetHtml: "<mark>colab</mark>", detail: { conversationId: "c2", platform: "telegram", account: "@bunny" } }),
    ],
    groups: [], semantic: semantic ? { enabled: true, label: "Semantic matches", items: [{ type: "message", id: "m9", score: 0.81234, title: "Aki", snippet: "similar" }] } : { enabled: false, label: "Semantic matches (not enabled)", items: [] },
  };
}
const facets = { devices: [{ id: WIN, role: "windows" }], apps: ["line"], accounts: ["bunny@line"], conversations: [] };

describe("search", () => {
  it("cards grouped by type with highlights, exact first, close matches after a divider, no semantic section while off", async () => {
    const api = mockApi({ "GET /api/facets": facets, "GET /api/search": (q: any) => result(Number(q.page)) });
    const { container } = renderWith(<SearchView />, api, { path: "/?q=collab" });
    expect(await screen.findByTestId("search-summary")).toHaveTextContent("60 matches · 58 exact · 2 close");
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Collab", "collab", "colab"]);
    const groups = screen.getAllByRole("region").filter((r) => r.classList.contains("result-group"));
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Files", "Messages", "Messages"]);
    const cards = screen.getAllByRole("article");
    expect(cards[0]).toHaveAttribute("data-type", "file");
    expect(within(cards[0]!).getByText("Windows")).toBeInTheDocument();
    expect(within(cards[0]!).getByText(/reference only/)).toBeInTheDocument();
    expect(within(cards[1]!).getByText("LINE")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("bunny@line")).toBeInTheDocument();
    expect(within(cards[1]!).getByRole("link", { name: /Open thread/ })).toHaveAttribute("href", "/conversations?chat=c1&around=m1");
    const divider = screen.getByRole("heading", { name: /Close matches/ });
    expect(divider.compareDocumentPosition(cards[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(cards[1]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(cards[2]!).getByText("close match (1 edit)")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Semantic matches" })).toBeNull();
    expect(cards[0]!.querySelector("time")!.getAttribute("title")).toMatch(/original time \(mtime\)[\s\S]*captured/);
    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/search").at(-1)!.arg.page).toBe(2));
  });

  it("shows the labeled semantic section only when the API reports semantic support", async () => {
    renderWith(<SearchView />, mockApi({ "GET /api/facets": facets, "GET /api/search": () => result(1, true) }), { path: "/?q=collab" });
    const sem = await screen.findByRole("region", { name: "Semantic matches" });
    expect(within(sem).getByRole("heading", { name: "Semantic matches" })).toBeInTheDocument();
    expect(sem).toHaveTextContent("score 0.812");
  });

  it("filter chips go to the API", async () => {
    const api = mockApi({ "GET /api/facets": facets, "GET /api/search": () => result(1) });
    renderWith(<SearchView />, api, { path: "/?q=collab" });
    await screen.findByTestId("search-summary");
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText("Device"), "android");
    await u.click(screen.getByRole("button", { name: /^Photos/ }));
    await waitFor(() => expect(api.calls.at(-1)!.arg).toMatchObject({ q: "collab", device: "android", type: "photo" }));
    expect(screen.getByRole("button", { name: /^Photos/ })).toHaveAttribute("aria-pressed", "true");
    await u.click(screen.getByRole("button", { name: "Date" }));
    await u.type(screen.getByLabelText("From"), "2026-09-01");
    await waitFor(() => expect(api.calls.at(-1)!.arg).toMatchObject({ from: "2026-09-01" }));
    await u.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(api.calls.at(-1)!.arg).toEqual({ q: "collab", page: 1, pageSize: 25, device: "", app: "", account: "", person: "", conversation: "", from: "", to: "", type: "", sort: "" }));
  });

  it("an empty query explains what search covers", async () => {
    renderWith(<SearchView />, mockApi({ "GET /api/facets": facets }), { path: "/" });
    expect(await screen.findByRole("heading", { name: "Search everything" })).toBeInTheDocument();
  });
});

describe("files: request original (F2-F4)", () => {
  const file = { type: "file", id: "f1", deviceId: "d1", app: null, eventTime: "2026-09-20T08:00:00.000Z", timeField: "mtime", capturedAt: "2026-10-01T00:00:00.000Z",
    title: "invoice.pdf", body: "C:\\invoice.pdf", person: null, detail: { name: "invoice.pdf", path: "C:\\invoice.pdf", size: 900, availability: "reference", contentUrl: null, lastRequest: null } };
  const cmd = (over: Record<string, unknown> = {}) => ({ id: "c1", fileId: "f1", status: "queued", display: "queued", waitingOn: "mac", detail: null, resultOid: null, progress: null, ...over });

  it("moves queued -> in progress with byte progress -> done, driven by events", async () => {
    const api = mockApi({
      "GET /api/files": { total: 1, page: 1, pageSize: 50, items: [file] },
      "GET /api/devices": { devices: [{ id: "d1", role: "windows" }] },
      "POST /api/files/f1/request": { command: cmd(), reused: false },
      "GET /api/commands/c1": cmd({ status: "uploaded", waitingOn: "transfer", resultOid: "OID1", progress: { committedParts: 0, totalChunks: 4, committedBytes: 0, totalSize: 1000 } }),
    });
    const { events } = renderWith(<FilesView />, api, { path: "/files" });
    expect(await screen.findByText(/reference only/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Request original" }));
    expect(await screen.findByTestId("request-status")).toHaveTextContent("queued on the Mac");
    expect(screen.queryByRole("button", { name: "Request original" })).toBeNull();
    act(() => events.emit("command.sent", { commandId: "c1" }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("waiting for the device");
    act(() => events.emit("command.status", { commandId: "c1", status: "uploaded", resultOid: "OID1" }));
    expect(await screen.findByText(/0 of 1000 bytes/)).toBeInTheDocument();
    act(() => events.emit("blob.progress", { oid: "OID1", committedBytes: 500, totalSize: 1000 }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("500 of 1000 bytes (50%)");
    expect(screen.getByRole("progressbar", { name: "Transfer progress" })).toHaveAttribute("aria-valuenow", "500");
    act(() => events.emit("blob.progress", { oid: "SOMETHING_ELSE", committedBytes: 900, totalSize: 1000 }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("50%");
    api.routes["GET /api/files"] = { total: 1, page: 1, pageSize: 50, items: [{ ...file, detail: { ...file.detail, availability: "local", contentUrl: "/api/files/f1/content" } }] };
    act(() => events.emit("file.cached", { fileId: "f1", commandId: "c1" }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("done: local copy available");
    expect(await screen.findByRole("link", { name: "Open local copy" })).toHaveAttribute("href", "/api/files/f1/content");
  });

  it("search within files and a failed request", async () => {
    const api = mockApi({ "GET /api/files": { total: 0, page: 1, pageSize: 50, items: [] }, "GET /api/devices": { devices: [] }, "GET /api/search": { total: 1, page: 1, pages: 1, items: [file] } });
    renderWith(<FilesView />, api, { path: "/files" });
    expect(await screen.findByText("No files indexed yet")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.type(screen.getByRole("searchbox", { name: "Search files" }), "invoice{Enter}");
    await waitFor(() => expect(api.calls.find((c) => c.path === "/api/search")!.arg).toMatchObject({ q: "invoice", type: "file" }));
    let s = fromCommand(cmd({ status: "sent", waitingOn: "device" }) as never);
    s = applyEvent(s, { at: "", type: "command.status", data: { commandId: "c1", status: "not_found", detail: "no such file" } });
    expect(s.phase).toBe("failed");
    expect(describeReq(s)).toBe("failed: not_found (no such file)");
  });
});

describe("coverage (D1-D5)", () => {
  it("pins problems on top, a card per device with collector dots, import progress, gaps, quarantine actions", async () => {
    const api = mockApi({
      "GET /api/coverage": coverage, "GET /api/stats": { counts: { messages: 3 } },
      "GET /api/quarantine": { items: [{ id: "q1", bucket: "ivy-up-windows", object_key: "up/n/X", kind: "notification", reason: "auth tag mismatch", created_at: now, stored: 1 }] },
      "POST /api/quarantine/q1/retry": { outcome: "committed" },
      "DELETE /api/quarantine/q1": { dismissed: true },
    });
    renderWith(<CoverageView />, api, { path: "/coverage" });
    const problems = await screen.findAllByTestId("problem");
    expect(problems[0]).toHaveTextContent("windows usage: last run 3 h ago");
    expect(within(problems[0]!).getByRole("img")).toHaveAttribute("aria-label", "status red");
    const dev = screen.getByRole("region", { name: "windows coverage" });
    expect(screen.getByRole("region", { name: "Problems" }).compareDocumentPosition(dev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByTestId("collector-windows-files")).getAllByRole("img")[0]).toHaveAttribute("aria-label", "files green");
    expect(screen.getByTestId("collector-windows-files")).toHaveTextContent("250 / 1000 (25%)");
    expect(within(screen.getByTestId("collector-windows-files")).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(within(screen.getByTestId("collector-windows-usage")).getAllByRole("img")[0]).toHaveAttribute("aria-label", "usage red");
    expect(within(screen.getByTestId("collector-windows-screenshots")).getAllByRole("img")[0]).toHaveAttribute("aria-label", "screenshots off");
    expect(dev).toHaveTextContent("device queue 7");
    expect(dev).toHaveTextContent(/usage \d\d:\d\d–\d\d:\d\d \(stale\)/);
    expect(screen.getByText(/Not paired: Android/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Quarantine: 1 open" })).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Retry: committed")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/quarantine/q1")).toBe(true));
  });

  it("groups gaps by date; imports label source-reported gaps apart from unknown days", () => {
    expect(gapsByDate([
      { collector: "a", from: "2026-10-08T12:00:00", to: "2026-10-08T13:00:00", reason: "stale", open: false },
      { collector: "b", from: "2026-10-09T12:00:00", to: "2026-10-09T13:00:00", reason: "stale", open: false },
    ]).map((x) => x.date)).toEqual(["2026-10-09", "2026-10-08"]);
    renderWith(<ImportsCoverage imports={[{
      name: "Activity Vault import", source: "activity_vault", status: "green", statusReason: "imported", location: "/av", lastRunAt: now, lastSuccessAt: now,
      rowsTotal: 5, lastRowsAdded: 2, gapWindowDays: 14, firstRowAt: now, captureReported: { healthy: null },
      gaps: [{ date: "2026-10-07", state: "gap", rows: 0, note: "the source reported a capture gap" }, { date: "2026-10-06", state: "unknown", rows: 0, note: "no rows; the source did not report on this day" }],
      captures: "Google activity",
    }]} />, mockApi({}));
    const row = screen.getByTestId("import-activity_vault");
    expect(row).toHaveTextContent(/2026-10-07 gap · the source reported a capture gap/);
    expect(row).toHaveTextContent(/2026-10-06 unknown · no rows/);
  });
});

describe("devices and pairing", () => {
  it("pairing sheet: string, client-rendered QR, Mac fingerprint, countdown; revoke needs a confirmation", async () => {
    const t0 = Date.parse("2026-10-10T10:00:00.000Z");
    const api = mockApi({
      "GET /api/devices": { macFingerprint: "MAC1-MAC2-MAC3-MAC4", devices: [{ id: "d1", role: "windows", fingerprint: "DEV1-DEV2-DEV3-DEV4", pairedAt: "2026-10-01T00:00:00Z", revokeWarning: "Revoking forgets this device's key." }] },
      "POST /api/pairings": (b: any) => ({ pairingId: "p1", role: b.role, pairingString: "ivy1." + "A".repeat(600), macFingerprint: "MAC1-MAC2-MAC3-MAC4", expiresAt: new Date(t0 + 600_000).toISOString() }),
      "DELETE /api/devices/d1": { revoked: true },
    });
    const { events } = renderWith(<DevicesView />, api, { path: "/devices", now: () => t0 });
    expect(await screen.findByText("DEV1-DEV2-DEV3-DEV4")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Start pairing: Android" }));
    expect(api.calls.find((c) => c.path === "/api/pairings")!.arg).toEqual({ role: "android" });
    const sheet = screen.getByRole("dialog", { name: "Pairing" });
    expect(within(sheet).getByLabelText("Pairing string")).toHaveValue("ivy1." + "A".repeat(600));
    const qr = await within(sheet).findByRole("img", { name: "Pairing QR code" });
    expect(decodeURIComponent(qr.getAttribute("src")!)).toMatch(/^data:image\/svg\+xml;utf8,<svg/);
    expect(within(sheet).getByRole("region", { name: "Pairing code" })).toHaveTextContent("MAC1-MAC2-MAC3-MAC4");
    expect(screen.getByTestId("countdown")).toHaveTextContent("10:00");
    act(() => events.emit("pairing.completed", { pairingId: "p1", role: "android", deviceFingerprint: "NEW1-NEW2-NEW3-NEW4" }));
    expect(await screen.findByRole("status")).toHaveTextContent("NEW1-NEW2-NEW3-NEW4");
    expect(screen.queryByRole("dialog", { name: "Pairing" })).toBeNull();

    await u.click(screen.getByRole("button", { name: "Revoke" }));
    const confirm = screen.getByRole("dialog", { name: "Confirm revoke" });
    expect(confirm).toHaveTextContent(/Revoking forgets/);
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await u.click(within(confirm).getByRole("button", { name: "Confirm revoke" }));
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/devices/d1")).toBe(true);
    expect(countdown(61_000)).toBe("1:01");
    expect(countdown(0)).toBe("expired");
  });
});

describe("recovery bin (B1-B4)", () => {
  it("permanent delete needs a confirmation that names what is removed; restore is one click", async () => {
    const api = mockApi({
      "GET /api/bin": { retentionDays: 30, total: 1, page: 1, pageSize: 50, items: [{ type: "screenshot", id: "s1", title: "offer.png", deletedAt: "2026-10-01T00:00:00Z", purgeAt: "2026-10-31T00:00:00Z" }] },
      "DELETE /api/bin/screenshot/s1": { removedFiles: 2 },
      "POST /api/bin/screenshot/s1/restore": { restored: true },
    });
    renderWith(<BinView />, api, { path: "/bin" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Delete permanently…" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm permanent delete" });
    expect(dialog).toHaveTextContent(/Permanently delete screenshot “offer.png”\? This removes the original image, its thumbnail, the OCR text/);
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await u.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await u.click(screen.getByRole("button", { name: "Delete permanently…" }));
    await u.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete permanently" }));
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/bin/screenshot/s1")).toBe(true);
    await u.click(screen.getByRole("button", { name: "Restore" }));
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/api/bin/screenshot/s1/restore")).toBe(true);
  });
});

describe("notifications (N2, N4)", () => {
  it("apps on the left filter the stream on the right; every item is a partial record", async () => {
    const n = (id: string, app: string) => ({ type: "notification", id, deviceId: WIN, app, eventTime: now, timeField: "posted_at", capturedAt: now, title: `from ${app}`, body: "hello", person: null, detail: { partial: true } });
    const api = mockApi({
      "GET /api/notifications/apps": { apps: [{ app: "LINE", source: "android", count: 2, latest: now }, { app: "Teams", source: "windows", count: 1, latest: now }] },
      "GET /api/notifications": (q: any) => ({ total: 1, page: 1, pages: 1, items: [n("n1", q.app || "LINE")] }),
    });
    renderWith(<NotificationsView />, api, { path: "/notifications" });
    const apps = await screen.findByRole("region", { name: "Apps" });
    expect(within(apps).getByRole("button", { name: /All apps/ })).toHaveAttribute("aria-current", "true");
    await userEvent.setup().click(within(apps).getByRole("button", { name: /Teams/ }));
    await waitFor(() => expect(api.calls.at(-1)!.arg).toMatchObject({ app: "Teams" }));
    const stream = screen.getByRole("region", { name: "Notification stream" });
    expect(await within(stream).findByText("from Teams")).toBeInTheDocument();
    expect(within(stream).getByText("preview · partial record")).toBeInTheDocument();
    expect(within(stream).getByText(/partial records, not conversations/)).toBeInTheDocument();
  });
});

describe("settings", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });

  it("sections like System Settings; R2 masks secrets; appearance override sets the theme", async () => {
    const api = mockApi({ "GET /api/r2": { configured: true, config: { endpoint: "http://r2", macTokens: { all: { accessKeyId: "AK", secret: "********" } } } } });
    renderWith(<SettingsView />, api, { path: "/settings" });
    const list = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(list).getAllByRole("link").map((l) => l.textContent)).toEqual(["Cloudflare R2", "Auto-lock", "Recovery bin", "Passphrase", "AI", "Imports", "Appearance"]);
    expect(within(list).getByRole("link", { name: "Cloudflare R2" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("AK:********")).toBeInTheDocument();
    expect(screen.getByLabelText("Mac token, all four buckets (fallback)")).toHaveAttribute("type", "password");
    const u = userEvent.setup();
    await u.click(within(list).getByRole("link", { name: "Appearance" }));
    await u.click(await screen.findByRole("button", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("ivy.theme")).toBe("dark");
    await u.click(screen.getByRole("button", { name: "Auto" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("builds the R2 body from fields and refuses half a device token pair", () => {
    expect(buildR2Config({ endpoint: " http://127.0.0.1:9 ", "macTokens.all": "a:b", "deviceTokens.windows.upWrite": "c:d", "deviceTokens.windows.cmdRead": "e:f" }))
      .toEqual({ endpoint: "http://127.0.0.1:9", macTokens: { all: "a:b" }, deviceTokens: { windows: { upWrite: "c:d", cmdRead: "e:f" } } });
    expect(() => buildR2Config({ accountId: "x", "deviceTokens.android.upWrite": "c:d" })).toThrow(/both/);
  });
});

describe("activity feed", () => {
  it("is newest first and bounded to 500", () => {
    let l: ServiceEvent[] = [];
    for (let i = 0; i < 600; i++) l = pushEvent(l, { id: i, at: "", type: "x", data: {} });
    expect(l).toHaveLength(FEED_MAX);
    expect(l[0]!.id).toBe(599);
    expect(pushEvent(l, { id: 599, at: "", type: "x", data: {} })).toBe(l);
  });
});

describe("settings forms: inline errors at the field (UX error-placement)", () => {
  it("auto-lock minutes out of range shows an error below the field, linked by aria-describedby, and sends nothing", async () => {
    const api = mockApi({ "GET /api/keystore": { state: "unlocked", autoLockMinutes: 30, autoLockMode: "ui" }, "PUT /api/keystore/settings": {} });
    renderWith(<SettingsView />, api, { path: "/settings?section=lock" });
    const input = await screen.findByLabelText("Lock after idle minutes (0 = never)");
    await waitFor(() => expect(input).toHaveValue(30));
    const u = userEvent.setup();
    await u.clear(input); await u.type(input, "5000");
    await u.click(screen.getByRole("button", { name: "Save" }));
    const err = await screen.findByRole("alert");
    expect(err).toHaveTextContent("Enter the minutes between 0 and 1440.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toBe(err.id);
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
    await u.clear(input); await u.type(input, "15");
    await u.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls.find((c) => c.method === "PUT")!.arg).toEqual({ autoLockMinutes: 15, autoLockMode: "ui" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("R2: half a device token pair is reported under the tokens, not as a server error", async () => {
    const api = mockApi({ "GET /api/r2": { configured: false, config: null } });
    renderWith(<SettingsView />, api, { path: "/settings" });
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Android device: up-bucket write token"), "a:b");
    await u.click(screen.getByRole("button", { name: "Save R2 configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/android device tokens need both.*Fill in both, or leave both empty/);
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("passphrase: a wrong current passphrase is shown at the current field", async () => {
    const { ApiError } = await import("../src/api.ts");
    const api = mockApi({ "POST /api/keystore/change-passphrase": () => { throw new ApiError(401, "wrong_passphrase", "wrong passphrase"); } });
    renderWith(<SettingsView />, api, { path: "/settings?section=passphrase" });
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Current"), "nope");
    await u.type(screen.getByLabelText("New"), "a new long passphrase");
    await u.click(screen.getByRole("button", { name: "Change passphrase" }));
    const err = await screen.findByRole("alert");
    expect(err).toHaveTextContent(/wrong passphrase.*Enter the passphrase you unlock IVY with/);
    expect(screen.getByLabelText("Current")).toHaveAttribute("aria-describedby", err.id);
  });
});
