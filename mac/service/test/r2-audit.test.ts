/**
 * POST /api/r2/audit (the zero-plaintext bucket audit with the service's own tokens),
 * GET /api/r2/objects, and POST /api/ingest/pause / resume (hold the queue in R2
 * without locking the vault).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newOid, upKey, utf8 } from "@ivy/protocol";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import type { SimDevice } from "./helpers/device.ts";

const NOTE = "Quarterly robotics budget review notes";
let stack: Awaited<ReturnType<typeof fullStack>>;
let dev: SimDevice;

beforeAll(async () => {
  stack = await fullStack({ pollIntervalMs: 0 });
  dev = await pairNew(stack.svc, "windows");
  await dev.put("windows_notification", { app: "Microsoft.Teams", title: "Lab", text: NOTE, sender: "Kenji", postedAt: new Date().toISOString() });
  await dev.put("file_meta", { path: "C:\\Users\\bunny\\Desktop\\IVY-G1\\plan.pdf", name: "plan.pdf", ext: "pdf", size: 10, mtime: new Date().toISOString(), quickHash: "q" });
  await stack.svc.ingester.poll();
});
afterAll(async () => { dev.close(); await stack.cleanup(); });

describe("POST /api/r2/audit", () => {
  it("passes over ciphertext and harvests markers from the vault", async () => {
    await dev.put("usage_event", { app: "chrome.exe", title: "x", start: new Date().toISOString(), end: new Date().toISOString() }).catch(() => undefined);
    const r = await api(stack.svc, "POST", "/api/r2/audit", { markers: ["g1-extra-marker"] });
    expect(r.status).toBe(200);
    expect(r.json.pass).toBe(true);
    expect(r.json.buckets).toHaveLength(4);
    expect(r.json.markers.fromRequest).toBe(1);
    expect(r.json.markers.harvested).toBeGreaterThan(0);
    expect(r.json.totals.hits).toBe(0);
  });

  it("finds plaintext by marker, names the key and never returns the plaintext", async () => {
    const key = upKey("usage_event", newOid());
    await dev.up.put(key, utf8(JSON.stringify({ note: NOTE })));
    const r = await api(stack.svc, "POST", "/api/r2/audit", {});
    expect(r.json.pass).toBe(false);
    const hit = r.json.hits.find((h: { key: string }) => h.key === key);
    expect(hit).toBeTruthy();
    expect(hit.bucket).toBe("ivy-up-windows");
    expect(hit.rules.some((x: string) => /^marker \(\d+ chars\)$/.test(x))).toBe(true);
    expect(r.body).not.toContain(NOTE);
    // scoped by bucket and prefix
    const scoped = await api(stack.svc, "POST", "/api/r2/audit", { buckets: ["cmd-windows"], harvest: false });
    expect(scoped.json.buckets.map((b: { bucket: string }) => b.bucket)).toEqual(["ivy-cmd-windows"]);
    await stack.svc.ingester.poll(); // the service quarantines it and removes it from the bucket
  });

  it("validates the body and answers 423 while the vault is locked", async () => {
    expect((await api(stack.svc, "POST", "/api/r2/audit", { markers: "x" })).status).toBe(400);
    expect((await api(stack.svc, "POST", "/api/r2/audit", { buckets: ["up-mars"] })).status).toBe(400);
    expect((await api(stack.svc, "GET", "/api/r2/objects?bucket=nope")).status).toBe(400);
    await api(stack.svc, "POST", "/api/keystore/lock");
    expect((await api(stack.svc, "POST", "/api/r2/audit", {})).status).toBe(423);
    await api(stack.svc, "POST", "/api/keystore/unlock", { passphrase: "correct horse battery staple" });
  });
});

describe("POST /api/ingest/pause and /resume", () => {
  it("holds objects in R2 with the vault unlocked, lists them, and ingests them after resume", async () => {
    const p = await api(stack.svc, "POST", "/api/ingest/pause", { minutes: 5 });
    expect(p.json).toMatchObject({ paused: true });
    const ks = await api(stack.svc, "GET", "/api/keystore");
    expect(ks.json).toMatchObject({ locked: false, ingestRunning: false });
    expect(ks.json.ingestPausedUntil).toBe(p.json.until);
    const key = await dev.put("windows_notification", { app: "Microsoft.Teams", title: "Lab", text: "held while paused", sender: "Kenji", postedAt: new Date().toISOString() });
    expect((await stack.svc.ingester.poll()).skipped).toBe("paused");
    const listed = await api(stack.svc, "GET", `/api/r2/objects?bucket=up-windows&prefix=${encodeURIComponent("up/")}`);
    expect(listed.json.objects.map((o: { key: string }) => o.key)).toContain(key);
    // the audit works while paused and sees the held object
    const a = await api(stack.svc, "POST", "/api/r2/audit", { buckets: ["up-windows"] });
    expect(a.json.pass).toBe(true);
    expect(a.json.buckets[0].objects).toBeGreaterThanOrEqual(1);
    expect((await api(stack.svc, "GET", "/api/ingest/status")).json.pausedUntil).toBe(p.json.until);

    expect((await api(stack.svc, "POST", "/api/ingest/resume")).json).toEqual({ paused: false });
    await stack.svc.ingester.settle();
    await stack.svc.ingester.poll();
    const after = await api(stack.svc, "GET", `/api/r2/objects?bucket=up-windows&prefix=${encodeURIComponent("up/")}`);
    expect(after.json.objects.map((o: { key: string }) => o.key)).not.toContain(key);
    expect((await api(stack.svc, "GET", "/api/keystore")).json.ingestPausedUntil).toBeNull();
  });

  it("a pause ends by itself and rejects bad durations", async () => {
    expect((await api(stack.svc, "POST", "/api/ingest/pause", { minutes: 0 })).status).toBe(400);
    expect((await api(stack.svc, "POST", "/api/ingest/pause", { minutes: 2000 })).status).toBe(400);
    stack.svc.ingester.pause(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(stack.svc.ingester.pausedTill()).toBeNull();
    expect((await stack.svc.ingester.poll()).skipped).toBeUndefined();
  });
});
