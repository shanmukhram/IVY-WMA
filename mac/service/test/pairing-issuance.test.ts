/**
 * Pairing issuance (PLAN decision 20): the Mac mints a FRESH code per attempt so more than one device can
 * pair. Each attempt is a new pairingId + a new one-time secret + a newly written pair/<id> bootstrap; a code
 * a device has already consumed is reported as used and is never re-served. The one-time, single-device
 * property (decision 1) is unchanged: consuming a code is what makes it one-time. These tests pair devices
 * only with the fresh code each attempt returns.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { SimDevice } from "./helpers/device.ts";
import { startPairing, currentPairing } from "../src/pairing/pairing.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
const devs: SimDevice[] = [];
afterEach(async () => { for (const d of devs.splice(0)) d.close(); await st?.cleanup(); st = undefined; });

const cmdKeys = (role = "windows") => st!.s3.mock.listAll(`ivy-cmd-${role}`).map((o) => o.key);
const bootstrapKeys = (role = "windows") => cmdKeys(role).filter((k) => k.startsWith("pair/"));

describe("a fresh code per attempt", () => {
  it("two consecutive starts give two different pairingIds, each with its own bootstrap object", async () => {
    st = await fullStack();
    const a = (await api(st.svc, "POST", "/api/pairings", { role: "windows" })).json;
    const b = (await api(st.svc, "POST", "/api/pairings", { role: "windows" })).json;

    expect(a.pairingId).not.toBe(b.pairingId);
    expect(a.pairingString).not.toBe(b.pairingString);
    // each attempt wrote its own bootstrap; the superseded one is cleaned up so only the live code remains
    expect(bootstrapKeys()).toEqual([`pair/${b.pairingId}`]);
    // both ids are recorded; the older one is cancelled, the newer pending
    const rows = (await api(st.svc, "GET", "/api/pairings")).json.pairings as Array<{ id: string; status: string }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[a.pairingId]).toBe("cancelled");
    expect(byId[b.pairingId]).toBe("pending");
  });

  it("two devices pair, each with its own fresh code, both recorded", async () => {
    st = await fullStack();

    // first device: mint, pair, ingest
    const p1 = await startPairing(st.svc.ctx, "windows");
    const first = new SimDevice(p1.pairingString);
    devs.push(first);
    await first.pair();
    await st.svc.ingester.poll();

    // the first code is now used; the pair screen would mint a SECOND, different code for the next device
    expect(currentPairing(st.svc.ctx, "windows")!.usable).toBe(false);
    expect(currentPairing(st.svc.ctx, "windows")!.consumedAt).toBeTruthy();

    const p2 = await startPairing(st.svc.ctx, "windows");
    expect(p2.pairingId).not.toBe(p1.pairingId);
    const second = new SimDevice(p2.pairingString);
    devs.push(second);
    await second.pair();
    await st.svc.ingester.poll();

    const ids = (await api(st.svc, "GET", "/api/devices")).json.devices.map((d: any) => d.id);
    expect(ids).toContain(first.deviceId);
    expect(ids).toContain(second.deviceId);
    expect(ids.length).toBe(2);
  });

  it("a code a device consumed is never re-served; the second device gets a new bootstrap", async () => {
    st = await fullStack();
    const p1 = await startPairing(st.svc.ctx, "windows");
    const first = new SimDevice(p1.pairingString);
    devs.push(first);
    await first.pair();
    await st.svc.ingester.poll();
    // the consumed bootstrap is gone from the cmd-bucket (single-use holds)
    expect(bootstrapKeys()).not.toContain(`pair/${p1.pairingId}`);

    const p2 = await startPairing(st.svc.ctx, "windows");
    expect(bootstrapKeys()).toEqual([`pair/${p2.pairingId}`]);
  });
});
