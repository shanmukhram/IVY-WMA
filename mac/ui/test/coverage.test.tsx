import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CoverageView, gapsByDate } from "../src/views/Coverage.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const now = new Date().toISOString();
const coverage = {
  at: now, locked: false, r2Configured: true, status: "red",
  problems: [
    { severity: "red", source: { deviceId: "d1", role: "windows", collector: "usage" }, message: "windows usage: last run 3 h ago" },
    { severity: "amber", source: { bucket: "ivy-up-windows" }, message: "1 object(s) quarantined in ivy-up-windows" },
  ],
  devices: [{
    deviceId: "d1", role: "windows", fingerprint: "AAAA-BBBB-CCCC-DDDD", pairedAt: now, lastSeen: now, lastReportAt: now, reportStatus: "green",
    appVersion: "0.1.0", queueDepthTotal: 7, status: "red", quarantined: 1, queuedCommands: 0, counts: {}, pendingBlobs: [],
    collectors: [
      { name: "files", enabled: true, lastRunAt: now, lastReportAt: now, queueDepth: 7, status: "green", statusReason: "running", captures: "File index", captureKind: "metadata",
        import: { indexed: 250, total: 1000, percent: 25, state: "in_progress", note: null } },
      { name: "usage", enabled: true, lastRunAt: now, lastReportAt: now, queueDepth: 0, status: "red", statusReason: "last run 3 h ago", captures: "Foreground app spans", captureKind: "metadata", import: null },
      { name: "screenshots", enabled: false, lastRunAt: null, lastReportAt: now, queueDepth: 0, status: "off", statusReason: "disabled on the device", captures: "Screenshots", captureKind: "media", import: null },
    ],
    gaps: [{ collector: "usage", from: "2026-10-09T10:00:00.000Z", to: "2026-10-09T11:30:00.000Z", reason: "stale", open: false }],
  }],
  buckets: [{ bucket: "ivy-up-windows", lastPollAt: now, lastSuccessAt: now, ok: true, error: null }],
  unpairedRoles: ["android"], quarantineOpen: 1,
};

describe("coverage", () => {
  it("pins problems on top, shows a dot per device and collector, import progress, gaps, quarantine actions", async () => {
    const api = mockApi({
      "GET /api/coverage": coverage,
      "GET /api/quarantine": { items: [{ id: "q1", bucket: "ivy-up-windows", object_key: "up/n/X", kind: "notification", reason: "auth tag mismatch", created_at: now, stored: 1 }] },
      "POST /api/quarantine/q1/retry": { outcome: "committed" },
      "DELETE /api/quarantine/q1": { dismissed: true },
    });
    renderWith(<CoverageView />, api, { path: "/coverage" });
    const problems = await screen.findAllByTestId("problem");
    expect(problems[0]).toHaveTextContent("windows usage: last run 3 h ago");
    expect(within(problems[0]!).getByRole("img")).toHaveAttribute("aria-label", "status red");
    const devSection = screen.getByRole("region", { name: "windows coverage" });
    expect(screen.getByRole("region", { name: "Problems" }).compareDocumentPosition(devSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByTestId("collector-windows-files")).getByRole("img")).toHaveAttribute("aria-label", "files green");
    expect(screen.getByTestId("collector-windows-files")).toHaveTextContent("250 / 1000 (25%)");
    expect(within(screen.getByTestId("collector-windows-usage")).getByRole("img")).toHaveAttribute("aria-label", "usage red");
    expect(within(screen.getByTestId("collector-windows-screenshots")).getByRole("img")).toHaveAttribute("aria-label", "screenshots off");
    expect(devSection).toHaveTextContent("device queue 7");
    expect(devSection).toHaveTextContent(/usage \d\d:\d\d–\d\d:\d\d \(stale\)/);
    expect(screen.getByText(/Not paired: android/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Quarantine: 1 open" })).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Retry: committed")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/quarantine/q1")).toBe(true));
  });

  it("groups gaps by date", () => {
    const g = gapsByDate([
      { collector: "a", from: "2026-10-08T12:00:00", to: "2026-10-08T13:00:00", reason: "stale", open: false },
      { collector: "b", from: "2026-10-09T12:00:00", to: "2026-10-09T13:00:00", reason: "stale", open: false },
    ]);
    expect(g.map((x) => x.date)).toEqual(["2026-10-09", "2026-10-08"]);
  });
});
