import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
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

describe("conversations with several sources (WX1, C9)", () => {
  const sources = [{ source: "windows:telegram-desktop", coverage: "complete" }, { source: "android:notification", coverage: "partial" }];
  const conv = { id: "c1", platform: "telegram", account: "@bunny", convKey: "-100123", peer: "Robotics lab", kind: "group", coverage: "complete",
    coverageBySource: { "windows:telegram-desktop": "complete", "android:notification": "partial" }, coverageSources: sources,
    coverageText: "complete via windows:telegram-desktop; partial via android:notification", messageCount: 1, lastMessageAt: "2026-10-09T10:00:00Z" };

  it("the list shows the coverage badge with its sources", async () => {
    renderWith(<ConversationsView />, mockApi({ "GET /api/conversations": { total: 1, page: 1, pages: 1, items: [conv], platforms: [{ platform: "telegram", coverage: "complete", n: 1 }] } }), { path: "/conversations" });
    const row = (await screen.findByRole("link", { name: "Robotics lab" })).closest("tr")!;
    expect(within(row as HTMLElement).getByText("complete", { selector: ".chip" })).toBeInTheDocument();
    expect(within(row as HTMLElement).getByTestId("coverage-sources")).toHaveTextContent("complete via windows:telegram-desktop; partial via android:notification");
  });

  it("the thread shows a source chip per message, a preview-only mark and a deletion at one source", async () => {
    const msg = (id: string, over: Record<string, unknown>) => ({ id, msg_key: id, sender: "Aki", sent_at: "2026-10-09T10:00:00Z", captured_at: "2026-10-10T00:00:00Z", text: `text ${id}`,
      text_quality: "full", reply_to: null, edited_at: null, source_status: "live", source_deleted_at: null, forwarded_from: null, media_kind: null, sources: [], ...over });
    const api = mockApi({
      "GET /api/conversations/c1/messages": { conversation: { ...conv, conv_key: conv.convKey }, around: null, messages: [
        msg("m1", { forwarded_from: "Robotics News", sources: [{ source: "windows:telegram-desktop", deletedAtSource: null }, { source: "android:root-db", deletedAtSource: null }] }),
        msg("m2", { text_quality: "preview", sources: [{ source: "android:notification", deletedAtSource: null }] }),
        msg("m3", { source_status: "deleted_at_source", sources: [{ source: "windows:telegram-desktop", deletedAtSource: null }, { source: "android:root-db", deletedAtSource: "2026-10-09T11:00:00Z" }] }),
      ] },
      "GET /api/attachments": { items: [] },
    });
    renderWith(<ConversationsView />, api, { path: "/conversations/c1" });
    const items = (await screen.findAllByRole("listitem"));
    expect(screen.getByRole("heading")).toHaveTextContent("complete via windows:telegram-desktop; partial via android:notification");
    expect(within(items[0]!).getByText("windows:telegram-desktop")).toHaveClass("chip-source");
    expect(within(items[0]!).getByText("android:root-db")).toBeInTheDocument();
    expect(within(items[0]!).getByText("forwarded from Robotics News")).toBeInTheDocument();
    expect(within(items[1]!).getByText("notification preview only")).toBeInTheDocument();
    expect(within(items[1]!).getByText("android:notification")).toBeInTheDocument();
    expect(within(items[2]!).getByText(/deleted at source \(kept in vault\)/)).toBeInTheDocument();
    expect(within(items[2]!).getByText("android:root-db (deleted there)")).toBeInTheDocument();
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
