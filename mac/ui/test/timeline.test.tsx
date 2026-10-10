import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimelineView, gapLabels, gapSpan, type Gap } from "../src/views/Timeline.tsx";
import { mockApi, renderWith } from "./helpers.tsx";
import { WIN } from "./fixtures.ts";

// a local day so hour rows line up whatever zone the test runs in
const day = new Date(2026, 8, 24); // 24 Sep 2026, local midnight
const at = (h: number, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000).toISOString();
const gap = (collector: string, from: string, to: string, reason = "stale"): Gap => ({ deviceId: WIN, role: "windows", collector, from, to, reason, open: false });

const msg = (i: number, h: number, m: number) => ({
  type: "message", id: `m${i}`, deviceId: WIN, app: "line", eventTime: at(h, m), timeField: "sent_at", capturedAt: at(23, 0), title: "Aki", body: `message ${i}`, person: "Aki",
  detail: { conversationId: "c1", platform: "line", account: "bunny" },
});
const photo = { type: "photo", id: "p1", deviceId: WIN, app: null, eventTime: at(9, 15), timeField: "taken_at", capturedAt: at(9, 20), title: "C:\\IMG_1.jpg", body: "", person: null,
  detail: { thumbUrl: "/api/media/p1/thumb", contentUrl: "/api/media/p1/content", original: true, importedAt: at(9, 21) } };

function result() {
  const items = [photo, ...Array.from({ length: 8 }, (_, i) => msg(i, 14, i * 5))];
  return {
    window: { from: at(0), to: at(24), tz: "local" }, page: 1, pages: 1, total: items.length, counts: { photo: 1, message: 8 },
    hours: [{ index: 9, from: at(9), to: at(10), count: 1 }, { index: 14, from: at(14), to: at(15), count: 8 }],
    gaps: [gap("usage", at(10, 30), at(12, 0)), gap("files", at(10, 30), at(12, 0)), gap("notifications", at(20), at(21), "disabled")],
    items, unavailable: [{ role: "android", reason: "no paired device" }],
  };
}

describe("timeline", () => {
  it("places gaps on the axis as shaded bands with one label per window", async () => {
    const api = mockApi({ "GET /api/timeline": result() });
    renderWith(<TimelineView />, api, { path: `/timeline?date=2026-09-24` });
    const axis = await screen.findByRole("region", { name: "Day timeline" });
    // 24 hour rows from 00:00 to 24:00
    expect(axis.querySelectorAll(".tl-hour")).toHaveLength(24);
    // 10:30-12:00: half of hour 10, all of hour 11, for each of the two collectors
    const h10 = within(screen.getByTestId("hour-10")).getAllByTestId("gap-band");
    expect(h10).toHaveLength(2);
    expect(h10[0]!.style.top).toBe("50%");
    expect(h10[0]!.style.height).toBe("50%");
    const h11 = within(screen.getByTestId("hour-11")).getAllByTestId("gap-band");
    expect(h11[0]!.style.top).toBe("0%");
    expect(h11[0]!.style.height).toBe("100%");
    expect(within(screen.getByTestId("hour-12")).queryAllByTestId("gap-band")).toHaveLength(0);
    // labels: grouped by window, only where the gap starts
    expect(within(screen.getByTestId("hour-10")).getAllByTestId("gap-label").map((l) => l.textContent)).toEqual(["Not captured: Windows usage, files · 10:30–12:00 · stale"]);
    expect(within(screen.getByTestId("hour-11")).queryAllByTestId("gap-label")).toHaveLength(0);
    expect(within(screen.getByTestId("hour-20")).getByTestId("gap-label")).toHaveTextContent("Windows notifications · 20:00–21:00 · disabled");
    expect(screen.getByText(/Unavailable sources: Android \(no paired device\)/)).toBeInTheDocument();
  });

  it("puts events in their hour, photos inline, capture time on hover, and collapses busy hours", async () => {
    renderWith(<TimelineView />, mockApi({ "GET /api/timeline": result() }), { path: `/timeline?date=2026-09-24` });
    const h9 = await screen.findByTestId("hour-9");
    const img = within(h9).getByRole("img", { name: /photo/ });
    expect(img).toHaveAttribute("src", "/api/media/p1/thumb");
    const t = h9.querySelector("time")!;
    expect(t.textContent).toBe("09:15");
    expect(t.getAttribute("title")).toMatch(/original time \(taken_at\)[\s\S]*captured[\s\S]*imported/);
    // 8 records at 14:00: collapsed to a preview with "Show all 8"
    const h14 = screen.getByTestId("hour-14");
    const head = within(h14).getByRole("button", { name: /8 records/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(within(h14).getAllByTestId("item-message")).toHaveLength(3);
    const u = userEvent.setup();
    await u.click(within(h14).getByRole("button", { name: "Show all 8" }));
    expect(within(h14).getAllByTestId("item-message")).toHaveLength(8);
    await u.click(head);
    expect(within(h14).getAllByTestId("item-message")).toHaveLength(3);
    expect(within(h14).getAllByTestId("item-message")[0]).toHaveTextContent("message 0");
  });

  it("date navigation and the AI drawer", async () => {
    const api = mockApi({ "GET /api/timeline": result(), "GET /api/ai/settings": { cloudEnabled: false, whatIsSent: "nothing" } });
    renderWith(<TimelineView />, api, { path: `/timeline?date=2026-09-24` });
    await screen.findByRole("region", { name: "Day timeline" });
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(api.calls.at(-1)!.arg.date).toBe("2026-09-25"));
    await u.click(screen.getByRole("button", { name: "Previous day" }));
    await u.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/timeline").at(-1)!.arg.date).toBe("2026-09-23"));
    await u.click(screen.getByRole("button", { name: "AI overview" }));
    const drawer = screen.getByRole("complementary", { name: "AI drawer" });
    expect(await within(drawer).findByText(/Cloud AI is off/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Day timeline" })).toBeInTheDocument(); // beside, never replacing
  });

  it("gap helpers", () => {
    const hs = Date.parse(at(10));
    expect(gapSpan(gap("u", at(9), at(10, 15)), hs)).toEqual({ top: 0, height: 25 });
    expect(gapSpan(gap("u", at(11), at(12)), hs)).toBeNull();
    expect(gapLabels([gap("a", at(1), at(2)), gap("b", at(1), at(2)), gap("c", at(1), at(2), "disabled")])).toEqual(["Windows a, b · 01:00–02:00 · stale", "Windows c · 01:00–02:00 · disabled"]);
  });
});
