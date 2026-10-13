/**
 * Current-code state and Forget (PLAN decision 20, parts C and D-support). The pair screen reads the live state
 * of the code it holds so it can mark a consumed code "used" and mint a fresh one; Forget must leave no
 * consumed code as "current", so the next attempt yields an unused code and a second device can pair.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { SimDevice } from "./helpers/device.ts";
import { startPairing } from "../src/pairing/pairing.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
const devs: SimDevice[] = [];
afterEach(async () => { for (const d of devs.splice(0)) d.close(); await st?.cleanup(); st = undefined; });

describe("current-code state", () => {
  it("GET /api/pairings/current reports usable while pending and used after a device pairs", async () => {
    st = await fullStack();
    const p = await startPairing(st.svc.ctx, "windows");
    let cur = (await api(st.svc, "GET", "/api/pairings/current?role=windows")).json.current;
    expect(cur).toMatchObject({ pairingId: p.pairingId, status: "pending", usable: true, consumedAt: null });

    const dev = new SimDevice(p.pairingString);
    devs.push(dev);
    await dev.pair();
    await st.svc.ingester.poll();

    cur = (await api(st.svc, "GET", "/api/pairings/current?role=windows")).json.current;
    expect(cur).toMatchObject({ pairingId: p.pairingId, status: "consumed", usable: false, deviceId: dev.deviceId });
    expect(cur.consumedAt).toBeTruthy();
    // the state carries no secret
    expect(JSON.stringify(cur)).not.toContain("secret");

    const byId = (await api(st.svc, "GET", `/api/pairings/${p.pairingId}/state`)).json;
    expect(byId).toMatchObject({ pairingId: p.pairingId, usable: false });
  });

  it("current is null before any code is issued; state 404s for an unknown id; bad role 400s", async () => {
    st = await fullStack();
    expect((await api(st.svc, "GET", "/api/pairings/current?role=windows")).json.current).toBeNull();
    expect((await api(st.svc, "GET", "/api/pairings/nope/state")).status).toBe(404);
    expect((await api(st.svc, "GET", "/api/pairings/current?role=bad")).status).toBe(400);
  });
});

describe("Forget clears the current code (part C)", () => {
  it("after Forget, the next code is a fresh unused one, not the consumed one, and a second PC pairs", async () => {
    st = await fullStack();
    const first = await pairNew(st.svc, "windows");
    devs.push(first);
    const usedId = first.payload.pairingId;

    const r = await api(st.svc, "DELETE", `/api/devices/${first.deviceId}?wipe=1`, { confirm: first.fingerprint });
    expect(r.status).toBe(200);

    const p2 = await startPairing(st.svc.ctx, "windows");
    expect(p2.pairingId).not.toBe(usedId);
    const cur = (await api(st.svc, "GET", "/api/pairings/current?role=windows")).json.current;
    expect(cur).toMatchObject({ pairingId: p2.pairingId, usable: true, consumedAt: null });

    const second = new SimDevice(p2.pairingString);
    devs.push(second);
    await second.pair();
    await st.svc.ingester.poll();
    const ids = (await api(st.svc, "GET", "/api/devices")).json.devices.map((d: any) => d.id);
    expect(ids).toContain(second.deviceId);
  });
});
