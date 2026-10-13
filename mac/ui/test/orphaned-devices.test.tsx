/**
 * Devices page, "Data from devices no longer paired": device ids with records on this Mac but no pairing
 * (GET /api/devices `orphaned`). Each row shows role, fingerprint or short id, last seen and a one-line
 * footprint; "Forget…" opens the Forget sheet, confirmed with the fingerprint when one is on record, else the
 * first 8 characters of the id. The section is hidden when the list is empty.
 */
import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevicesView, orphanSummary } from "../src/views/Devices.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

const OLD = "ed2d211c-cbb0-41cb-9cf0-b923858f32e5";
const counts = { messages: 2, conversations: 1, messageSources: 2, messageEdits: 0, attachments: 0, notifications: 0, media: 0, files: 1059192, calls: 0, usageEvents: 0,
  commands: 0, quarantine: 0, collectorState: 0, collectorHistory: 0, pairings: 1, ledger: 4000, mediaArchive: 0, blobs: 3 };
const orphan = { id: OLD, role: "windows", fingerprint: null, name: null, lastSeen: "2026-10-01T00:00:00Z", confirmWith: "shortId",
  counts, catalogFiles: 1059189, cacheBytes: 2048, leftInR2: { objects: 0, bytes: 0 } };
const footprint = { deviceId: OLD, role: "windows", fingerprint: null, name: null, paired: false, confirmWith: "shortId", counts, catalogFiles: 1059189,
  shared: { messagesKept: 0, conversationsKept: 0 }, binRows: 0, cacheBytes: 2048, leftInR2: { objects: 0, bytes: 0 } };
const result = {
  forgotten: true, deviceId: OLD, removed: counts, shared: footprint.shared, cancelledCommands: 0, binPurged: 0, binNote: "",
  cacheBytesFreed: 2048, cacheFilesRemoved: 3, leftInR2Bytes: 0, leftInR2Objects: 0, r2Note: "Nothing this device uploaded to R2 was changed.",
  tokenWarning: "The device's R2 tokens remain valid until you rotate them in the Cloudflare dashboard.",
  unpairSent: false, unpairCommandId: null, unpairSentAt: null, unpairReason: "Device was not paired, so it was not told to reset.",
};
const routes = (orphaned: unknown[]) => ({
  "GET /api/devices": { macFingerprint: "MAC1-MAC2-MAC3-MAC4", devices: [], removed: [], orphaned },
  [`GET /api/devices/${OLD}/footprint`]: footprint,
  [`DELETE /api/devices/${OLD}?wipe=1`]: () => result,
});

describe("data from devices no longer paired", () => {
  it("lists each orphaned id with role, short id, last seen and a one-line footprint", async () => {
    renderWith(<DevicesView />, mockApi(routes([orphan, { ...orphan, id: "aaaa1111-0000", role: "unknown", fingerprint: "FP01-FP02-FP03-FP04", name: "Old desk", confirmWith: "fingerprint",
      counts: { ...counts, messages: 0, conversations: 0, files: 0, notifications: 5 }, catalogFiles: 0, cacheBytes: 0 }])), { path: "/devices" });
    const section = await screen.findByRole("region", { name: "Data from devices no longer paired" });
    const row = within(section).getByTestId(`orphaned-${OLD}`);
    expect(row).toHaveTextContent("ed2d211c");
    expect(row).toHaveTextContent("Windows · no fingerprint on record, id ed2d211c · last seen");
    expect(within(row).getByTestId(`orphaned-summary-${OLD}`)).toHaveTextContent("1,059,189 catalogue entries, 3 files with content, 2 messages, 1 conversation; 2.0 KB of local cache");
    const other = within(section).getByTestId("orphaned-aaaa1111-0000");
    expect(other).toHaveTextContent("Old desk");
    expect(other).toHaveTextContent("Unknown device type · fingerprint FP01-FP02-FP03-FP04");
    expect(other).toHaveTextContent("5 notifications");
  });

  it("is hidden when the list is empty", async () => {
    const api = mockApi(routes([]));
    renderWith(<DevicesView />, api, { path: "/devices" });
    await screen.findByRole("region", { name: "Paired devices" });
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/devices")).toBe(true));
    expect(screen.queryByRole("region", { name: "Data from devices no longer paired" })).toBeNull();
  });

  it("Forget… opens the Forget sheet; it needs the short id, then DELETEs with wipe=1 and shows the result", async () => {
    const api = mockApi(routes([orphan]));
    renderWith(<DevicesView />, api, { path: "/devices" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Forget data from ed2d211c" }));
    const sheet = screen.getByRole("dialog", { name: "Forget device" });
    expect(sheet).toHaveTextContent("Forget data from a device no longer paired?");
    expect(sheet).toHaveTextContent("Nothing is sent to the device, because it is not paired.");
    expect(sheet).not.toHaveTextContent("is told to reset");
    const fp = await within(sheet).findByTestId("forget-footprint");
    expect(fp).toHaveTextContent("Files1,059,192 (1,059,189 catalogue entries with no content on this Mac)");
    expect(sheet).toHaveTextContent("Nothing is written to R2.");
    expect(within(sheet).getByTestId("forget-fingerprint")).toHaveTextContent("ed2d211c");

    const go = within(sheet).getByRole("button", { name: "Forget this data" });
    expect(go).toBeDisabled();
    const field = within(sheet).getByLabelText("Type the first 8 characters of the device id to confirm");
    await u.type(field, "ED2D211");
    expect(go).toBeDisabled();
    await u.type(field, "C");
    expect(go).toBeEnabled();
    await u.click(go);

    expect(api.calls.find((c) => c.method === "DELETE")).toEqual({ method: "DELETE", path: `/api/devices/${OLD}?wipe=1`, arg: { confirm: "ED2D211C" } });
    const done = await screen.findByRole("dialog", { name: "Forget device" });
    expect(done).toHaveTextContent("Data from Windows · ed2d211c forgotten");
    expect(within(done).getByRole("status")).toHaveTextContent("Removed 2 messages, 1 conversation, 1,059,192 files and freed 2.0 KB of local cache");
    expect(done).toHaveTextContent("Device was not paired, so it was not told to reset.");
    expect(api.calls.filter((c) => c.path === "/api/devices").length).toBeGreaterThan(1);
  });

  it("orphanSummary falls back to the bookkeeping rows when no content is left", () => {
    expect(orphanSummary({ counts: { pairings: 1, ledger: 2 }, catalogFiles: 0, cacheBytes: 0 })).toBe("3 bookkeeping records");
  });
});
