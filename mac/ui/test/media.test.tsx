import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MediaView } from "../src/views/Media.tsx";
import { mockApi, renderWith } from "./helpers.tsx";
import { WIN } from "./fixtures.ts";

const day = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
const media = (id: string, type: string, t: string, over: Record<string, unknown> = {}) => ({
  type, id, deviceId: WIN, app: null, eventTime: t, timeField: "taken_at", capturedAt: t, title: `C:\\pics\\${id}.png`, body: "", person: null, ocrText: `text of ${id}`,
  detail: { thumbUrl: `/api/media/${id}/thumb`, contentUrl: `/api/media/${id}/content`, original: true, sourcePath: `C:\\pics\\${id}.png`, takenAt: t, ocrStatus: "done" }, ...over,
});
const items = [
  media("a", "screenshot", day(9, 12)),
  media("b", "photo", day(9, 10), { detail: { thumbUrl: "/api/media/b/thumb", contentUrl: null, original: false, sourcePath: "C:\\pics\\b.jpg" } }),
  media("c", "photo", day(8, 18)),
];
const routes = () => ({
  "GET /api/views/records": { total: 3, page: 1, pages: 1, items },
  "GET /api/media/a/origin": { evidenced: [], inferred: [], inferenceAvailable: false },
  "GET /api/media/b/origin": { evidenced: [{ attachmentId: "x", evidence: "identical content hash", platform: "line", sender: "Aki", sentAt: day(9, 9), conversationId: "c1", messageId: "m1", peer: "Aki", account: "bunny" }], inferred: [], inferenceAvailable: false },
  "POST /api/commands": { id: "cmd1", status: "queued" },
  "DELETE /api/items/screenshot/a": { binned: true },
  "DELETE /api/items/photo/b": { binned: true },
});

describe("media gallery", () => {
  it("groups by day with headers, filters by kind and device through the API", async () => {
    const api = mockApi(routes());
    renderWith(<MediaView />, api, { path: "/media" });
    const days = await screen.findAllByRole("heading", { level: 3 });
    expect(days).toHaveLength(2);
    expect(within(days[0]!.closest("section")!).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /screenshot C:\\pics\\a.png/ })).toHaveAttribute("title", "text of a");
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Photos" }));
    await waitFor(() => expect(api.calls.at(-1)!.arg).toMatchObject({ type: "photo" }));
    await u.selectOptions(screen.getByLabelText("Device"), "android");
    await waitFor(() => expect(api.calls.at(-1)!.arg).toMatchObject({ type: "photo", device: "android" }));
  });

  it("picker mode: selection count and bulk actions", async () => {
    const api = mockApi(routes());
    renderWith(<MediaView />, api, { path: "/media" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Select" }));
    expect(screen.getByTestId("selection-count")).toHaveTextContent("0 selected");
    const a = screen.getByRole("button", { name: /screenshot C:\\pics\\a.png/ });
    const b = screen.getByRole("button", { name: /photo C:\\pics\\b.png/ });
    await u.click(a); await u.click(b);
    expect(a).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 selected");
    expect(screen.queryByRole("dialog")).toBeNull(); // picking does not open the viewer
    await u.click(a);
    expect(screen.getByTestId("selection-count")).toHaveTextContent("1 selected");
    await u.click(a);

    // request originals: only the one without its original, by its device path
    await u.click(screen.getByRole("button", { name: "Request originals" }));
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([{ method: "POST", path: "/api/commands", arg: { deviceId: WIN, params: { type: "file_request", path: "C:\\pics\\b.jpg" } } }]);
    expect(await screen.findByRole("status")).toHaveTextContent("Requested 1 original(s); 1 already on this Mac");

    await u.click(screen.getByRole("button", { name: "Move to recovery bin" }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/items/screenshot/a", "/api/items/photo/b"]));
    expect(await screen.findByText(/Moved 2 item\(s\) to the recovery bin/)).toBeInTheDocument();
    expect(screen.getByTestId("selection-count")).toHaveTextContent("0 selected");
  });

  it("lightbox: prev / next, metadata, OCR text and origin", async () => {
    renderWith(<MediaView />, mockApi(routes()), { path: "/media" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /screenshot C:\\pics\\a.png/ }));
    const viewer = screen.getByRole("dialog", { name: "Media viewer" });
    expect(within(viewer).getByText("1 of 3")).toBeInTheDocument();
    expect(within(viewer).getByText("text of a")).toBeInTheDocument();
    expect(await within(viewer).findByText(/No evidence links this image/)).toBeInTheDocument();
    expect(within(viewer).getByText(/nothing is guessed/)).toBeInTheDocument();
    expect(within(viewer).getByRole("button", { name: "Previous" })).toBeDisabled();
    await u.click(within(viewer).getByRole("button", { name: "Next" }));
    expect(within(viewer).getByText("2 of 3")).toBeInTheDocument();
    expect(await within(viewer).findByText(/identical content hash/)).toBeInTheDocument();
    expect(within(viewer).getByRole("link", { name: "Aki" })).toHaveAttribute("href", "/conversations?chat=c1&around=m1");
    expect(within(viewer).getByRole("button", { name: "Request original" })).toBeInTheDocument();
    await u.keyboard("{ArrowRight}");
    expect(within(viewer).getByText("3 of 3")).toBeInTheDocument();
    await u.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Media viewer" })).toBeNull();
  });

  it("an empty gallery explains where media comes from", async () => {
    renderWith(<MediaView />, mockApi({ "GET /api/views/records": { total: 0, page: 1, pages: 1, items: [] } }), { path: "/media" });
    expect(await screen.findByText(/Screenshots and photos appear here as the devices send them/)).toBeInTheDocument();
  });
});
