import { describe, it, expect } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevicesView, countdown } from "../src/views/Devices.tsx";
import { mockApi, renderWith } from "./helpers.tsx";

describe("devices and pairing", () => {
  it("start pairing shows the string, a client-rendered QR code, the Mac fingerprint and an expiry countdown", async () => {
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
    expect(screen.getByLabelText("Pairing string")).toHaveValue("ivy1." + "A".repeat(600));
    const qr = await screen.findByRole("img", { name: "Pairing QR code" });
    expect(decodeURIComponent(qr.getAttribute("src")!)).toMatch(/^data:image\/svg\+xml;utf8,<svg/);
    expect(screen.getByRole("region", { name: "Pairing code" })).toHaveTextContent("MAC1-MAC2-MAC3-MAC4");
    expect(screen.getByTestId("countdown")).toHaveTextContent("10:00");

    act(() => events.emit("pairing.completed", { pairingId: "p1", role: "android", deviceFingerprint: "NEW1-NEW2-NEW3-NEW4" }));
    expect(await screen.findByRole("status")).toHaveTextContent("NEW1-NEW2-NEW3-NEW4");
    expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();

    await u.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByText(/Revoking forgets/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/devices/d1")).toBe(true);
  });

  it("formats the countdown", () => {
    expect(countdown(61_000)).toBe("1:01");
    expect(countdown(0)).toBe("expired");
  });
});
