/**
 * Revoke and forget tell the device to reset. The Devices page lists removed devices under "Recently removed"
 * (from GET /api/devices, so it survives a reload): waiting while the device has not answered, confirmed once
 * its status lands (reloaded on device.unpair_confirmed), and "not told" when the command could not be sent.
 * The revoke sheet says the PC resets and shows its pairing page.
 */
import { describe, it, expect } from "vitest";
import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevicesView } from "../src/views/Devices.tsx";
import { mockApi, renderWith } from "./helpers.tsx";
import { WIN } from "./fixtures.ts";

const FP = "AAAA-BBBB-CCCC-DDDD";
const REMOVED_AT = "2026-10-13T08:00:00.000Z";

function routes() {
  const removed: Array<Record<string, unknown>> = [];
  const devices = [{ id: WIN, role: "windows", name: "Desk PC", fingerprint: FP, pairedAt: "2026-10-01T00:00:00Z", revokeWarning: "Its R2 tokens stay valid until rotated in Cloudflare." }];
  return {
    removed, devices,
    routes: {
      "GET /api/devices": () => ({ macFingerprint: "MAC1-MAC2-MAC3-MAC4", devices: [...devices], removed: [...removed] }),
      [`DELETE /api/devices/${WIN}`]: () => {
        devices.splice(0);
        removed.push({ id: WIN, role: "windows", name: "Desk PC", fingerprint: FP, removedAt: REMOVED_AT, kind: "revoked", unpairSentAt: REMOVED_AT, unpairConfirmedAt: null, unpairDetail: null });
        return { revoked: true, cancelledCommands: 0, unpairSent: true, unpairCommandId: "c1", unpairSentAt: REMOVED_AT, unpairReason: null, tokenWarning: "t" };
      },
    },
  };
}

describe("Devices: telling a removed device to reset", () => {
  it("revoke shows the reset sentence, then the waiting state, then the confirmed state after the event", async () => {
    const m = routes();
    const api = mockApi(m.routes);
    const { events } = renderWith(<DevicesView />, api, { path: "/devices" });
    const u = userEvent.setup();
    await screen.findByTestId(`device-title-${WIN}`);
    expect(screen.queryByRole("region", { name: "Recently removed" })).toBeNull();

    await u.click(screen.getByRole("button", { name: "Revoke" }));
    const sheet = screen.getByRole("dialog", { name: "Confirm revoke" });
    expect(sheet).toHaveTextContent("The PC is told to reset and shows its pairing page again; pair it from here when you want it back.");
    await u.click(within(sheet).getByRole("button", { name: "Confirm revoke" }));

    expect(await screen.findByText(/Device revoked\..*The device is told to reset/)).toBeInTheDocument();
    const list = await screen.findByRole("region", { name: "Recently removed" });
    expect(within(list).getByText("Desk PC")).toBeInTheDocument();
    expect(within(list).getByTestId(`removed-state-${WIN}`))
      .toHaveTextContent("Waiting for the PC to reset (it resets on its next check-in, within about 2 minutes while online)");

    // the device's status lands: the service records it and emits device.unpair_confirmed
    m.removed[0]!.unpairConfirmedAt = "2026-10-13T08:01:30.000Z";
    act(() => events.emit("device.unpair_confirmed", { deviceId: WIN, removed: "revoked" }));
    await waitFor(() => expect(screen.getByTestId(`removed-state-${WIN}`)).toHaveTextContent(/^PC reset confirmed /));
    expect(screen.getByTestId(`removed-state-${WIN}`).querySelector("time")?.getAttribute("datetime")).toBe("2026-10-13T08:01:30.000Z");
  });

  it("a fresh load shows the waiting state, and a device that could not be told says why", async () => {
    const m = routes();
    m.devices.splice(0);
    m.removed.push(
      { id: WIN, role: "windows", name: null, fingerprint: FP, removedAt: REMOVED_AT, kind: "forgotten", unpairSentAt: REMOVED_AT, unpairConfirmedAt: null, unpairDetail: null },
      { id: "dev-2", role: "windows", name: "Old laptop", fingerprint: "EEEE-FFFF-0000-1111", removedAt: REMOVED_AT, kind: "revoked", unpairSentAt: null, unpairConfirmedAt: null,
        unpairDetail: "R2 is not configured, so the device could not be told to reset." },
    );
    renderWith(<DevicesView />, mockApi(m.routes), { path: "/devices" });
    const list = await screen.findByRole("region", { name: "Recently removed" });
    expect(within(list).getByTestId(`removed-${WIN}`)).toHaveTextContent("Forgotten");
    expect(within(list).getByTestId(`removed-state-${WIN}`)).toHaveTextContent(/^Waiting for the PC to reset/);
    expect(within(list).getByTestId("removed-state-dev-2")).toHaveTextContent("Not told to reset: R2 is not configured, so the device could not be told to reset.");
  });
});
