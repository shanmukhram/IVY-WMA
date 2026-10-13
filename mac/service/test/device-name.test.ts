/**
 * The owner names a paired device: PATCH /api/devices/:id { name } sets it (trimmed, at most 60 characters),
 * "" or null clears it, a longer value or a non-string is refused with 400, an unknown device is 404. The name
 * is shown by /api/devices, /api/devices/:id and the forget footprint, and a device.renamed event is emitted.
 * The forget confirmation stays the fingerprint.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import type { SimDevice } from "./helpers/device.ts";
import type { ServiceEvent } from "../src/events.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
const devs: SimDevice[] = [];
afterEach(async () => { for (const d of devs.splice(0)) d.close(); await st?.cleanup(); st = undefined; });

async function setup() {
  st = await fullStack();
  const win = await pairNew(st.svc, "windows");
  devs.push(win);
  return win;
}

describe("PATCH /api/devices/:id", () => {
  it("sets a trimmed name, shows it everywhere a device is described, and emits device.renamed", async () => {
    const win = await setup();
    const seen: ServiceEvent[] = [];
    const off = st!.svc.ctx.events.on((e) => { if (e.type === "device.renamed") seen.push(e); });

    let r = await api(st!.svc, "GET", "/api/devices");
    expect(r.json.devices[0].name).toBeNull();

    r = await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: "  Desk PC  " });
    expect(r.status).toBe(200);
    expect(r.json.name).toBe("Desk PC");
    expect(r.json.id).toBe(win.deviceId);
    off();
    expect(seen.map((e) => e.data)).toEqual([{ deviceId: win.deviceId, name: "Desk PC" }]);

    r = await api(st!.svc, "GET", "/api/devices");
    expect(r.json.devices[0].name).toBe("Desk PC");
    r = await api(st!.svc, "GET", `/api/devices/${win.deviceId}`);
    expect(r.json.name).toBe("Desk PC");
    r = await api(st!.svc, "GET", `/api/devices/${win.deviceId}/footprint`);
    expect(r.status).toBe(200);
    expect(r.json.name).toBe("Desk PC");
    expect(r.json.confirmWith).toBe("fingerprint");
  });

  it("clears the name with an empty string or null", async () => {
    const win = await setup();
    await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: "Desk PC" });
    let r = await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: "   " });
    expect(r.status).toBe(200);
    expect(r.json.name).toBeNull();
    await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: "Desk PC" });
    r = await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: null });
    expect(r.json.name).toBeNull();
    r = await api(st!.svc, "GET", `/api/devices/${win.deviceId}/footprint`);
    expect(r.json.name).toBeNull();
  });

  it("accepts 60 characters and refuses 61, a non-string or a missing name", async () => {
    const win = await setup();
    let r = await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: "x".repeat(60) });
    expect(r.status).toBe(200);
    expect(r.json.name).toHaveLength(60);
    r = await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: "y".repeat(61) });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/at most 60 characters/);
    r = await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: 42 });
    expect(r.status).toBe(400);
    r = await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, {});
    expect(r.status).toBe(400);
    r = await api(st!.svc, "GET", `/api/devices/${win.deviceId}`);
    expect(r.json.name).toBe("x".repeat(60));
  });

  it("is 404 for an unknown device", async () => {
    await setup();
    const r = await api(st!.svc, "PATCH", "/api/devices/no-such-device", { name: "Ghost" });
    expect(r.status).toBe(404);
  });
});
