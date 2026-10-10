import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FEED_MAX, pushEvent } from "../src/views/Activity.tsx";
import { BinView } from "../src/views/Bin.tsx";
import { ConversationsView } from "../src/views/Conversations.tsx";
import { MediaView } from "../src/views/Media.tsx";
import { buildR2Config } from "../src/views/Settings.tsx";
import { CoverageRibbon } from "../src/views/Timeline.tsx";
import { mockApi, renderWith } from "./helpers.tsx";
import type { ServiceEvent } from "../src/events.ts";

describe("activity feed", () => {
  it("is newest first and bounded to 500", () => {
    let l: ServiceEvent[] = [];
    for (let i = 0; i < 600; i++) l = pushEvent(l, { id: i, at: "", type: "x", data: {} });
    expect(l).toHaveLength(FEED_MAX);
    expect(l[0]!.id).toBe(599);
    expect(pushEvent(l, { id: 599, at: "", type: "x", data: {} })).toBe(l);
  });
});

describe("empty states", () => {
  it("conversations say honestly that nothing is captured yet", async () => {
    renderWith(<ConversationsView />, mockApi({ "GET /api/conversations": { total: 0, page: 1, pages: 1, items: [], platforms: [] } }), { path: "/conversations" });
    expect(await screen.findByText(/No conversations in the vault yet/)).toBeInTheDocument();
  });
  it("media origin panel shows no evidence and no invented inference", async () => {
    const it0 = { type: "screenshot", id: "m1", deviceId: "d", app: null, eventTime: "2026-10-09T10:00:00Z", timeField: "taken_at", capturedAt: null, title: "shot.png", body: "", person: null, ocrText: "robotics offer", detail: { thumbUrl: "/api/media/m1/thumb", contentUrl: "/api/media/m1/content", ocrStatus: "done" } };
    renderWith(<MediaView />, mockApi({ "GET /api/media": { total: 1, page: 1, pages: 1, items: [it0] }, "GET /api/media/m1/origin": { evidenced: [], inferred: [], inferenceAvailable: false } }), { path: "/media?focus=m1" });
    expect(await screen.findByText(/No evidence links this image/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is guessed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /screenshot shot.png/ })).toHaveAttribute("title", "robotics offer");
  });
});

describe("recovery bin", () => {
  it("permanent delete needs a confirmation that names what is removed", async () => {
    const api = mockApi({
      "GET /api/bin": { retentionDays: 30, total: 1, page: 1, pageSize: 50, items: [{ type: "screenshot", id: "s1", title: "offer.png", deletedAt: "2026-10-01T00:00:00Z", purgeAt: "2026-10-31T00:00:00Z" }] },
      "DELETE /api/bin/screenshot/s1": { removedFiles: 2 },
    });
    renderWith(<BinView />, api, { path: "/bin" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Delete permanently…" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/Permanently delete screenshot “offer.png”\? This removes the original image, its thumbnail, the OCR text/);
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await u.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/bin/screenshot/s1")).toBe(true);
  });
});

describe("settings and timeline helpers", () => {
  it("builds the R2 body from fields and refuses half a device token pair", () => {
    expect(buildR2Config({ endpoint: " http://127.0.0.1:9 ", "macTokens.all": "a:b", "deviceTokens.windows.upWrite": "c:d", "deviceTokens.windows.cmdRead": "e:f" }))
      .toEqual({ endpoint: "http://127.0.0.1:9", macTokens: { all: "a:b" }, deviceTokens: { windows: { upWrite: "c:d", cmdRead: "e:f" } } });
    expect(() => buildR2Config({ accountId: "x", "deviceTokens.android.upWrite": "c:d" })).toThrow(/both/);
  });
  it("coverage ribbon draws one segment per gap", () => {
    const { container } = renderWith(<CoverageRibbon from="2026-10-09T00:00:00Z" to="2026-10-10T00:00:00Z" gaps={[{ deviceId: "d", role: "windows", collector: "usage", from: "2026-10-09T06:00:00Z", to: "2026-10-09T12:00:00Z", reason: "stale", open: false }]} />, mockApi({}));
    const seg = container.querySelector(".gap") as HTMLElement;
    expect(seg.style.left).toBe("25%");
    expect(seg.style.width).toBe("25%");
  });
});
