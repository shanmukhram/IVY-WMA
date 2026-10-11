/**
 * A blob whose manifest is in but whose data parts never come: quarantined after orphanPartMs on a pass,
 * or at once through POST /api/blobs/:oid/abandon.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { PNG_1x1, type SimDevice } from "./helpers/device.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
afterEach(async () => { await st?.cleanup(); st = undefined; });

async function setup() {
  st = await fullStack();
  const dev = await pairNew(st.svc, "windows");
  return { s: st, dev };
}
const upKeys = (s: Stack) => s.s3.mock.listAll("ivy-up-windows").map((o) => o.key);
const blobRow = (s: Stack, oid: string) => s.svc.ctx.db.prepare("SELECT status, detail FROM blobs WHERE oid = ?").get(oid) as { status: string; detail: string | null };
const ageBlob = (s: Stack, oid: string, days: number) =>
  s.svc.ctx.db.prepare("UPDATE blobs SET updated_at = ?, first_seen_at = ? WHERE oid = ?").run(...[new Date(Date.now() - days * 86400_000).toISOString(), new Date(Date.now() - days * 86400_000).toISOString(), oid]);
const qRow = (s: Stack, key: string) => s.svc.ctx.db.prepare("SELECT reason, stored_path, kind FROM quarantine WHERE object_key = ?").get(key) as { reason: string; stored_path: string | null; kind: string } | undefined;
const ledger = (s: Stack, key: string) => s.svc.ctx.db.prepare("SELECT status FROM sync_objects WHERE object_key = ?").get(key) as { status: string } | undefined;

/** A photo blob of three parts with only its manifest uploaded. */
async function manifestOnly(dev: SimDevice) {
  const b = dev.blob(new Uint8Array(randomBytes(600)), "photo", 256);
  await dev.up.put(b.manifest.key, b.manifest.bytes);
  return b;
}

describe("a manifest whose data parts never arrive", () => {
  it("is quarantined by a pass once older than orphanPartMs; a younger one stays assembling", async () => {
    const { s, dev } = await setup();
    const old = await manifestOnly(dev);
    const young = await manifestOnly(dev);
    await s.svc.ingester.poll();
    expect(blobRow(s, old.oid).status).toBe("assembling");
    expect(upKeys(s)).toContain(old.manifest.key);

    ageBlob(s, old.oid, 8);
    await s.svc.ingester.poll();

    expect(blobRow(s, old.oid)).toMatchObject({ status: "quarantined", detail: "no data part within 7 days" });
    expect(upKeys(s)).not.toContain(old.manifest.key);
    const q = qRow(s, old.manifest.key)!;
    expect(q).toMatchObject({ kind: "manifest", reason: "no data part within 7 days" });
    expect(existsSync(q.stored_path!)).toBe(true);
    expect(ledger(s, old.manifest.key)).toEqual({ status: "quarantined" });

    expect(blobRow(s, young.oid).status).toBe("assembling");
    expect(upKeys(s)).toContain(young.manifest.key);
    // idempotent: another pass changes nothing
    const again = await s.svc.ingester.poll();
    expect(again.buckets[0]!.quarantined).toBe(0);
    expect(s.svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM quarantine WHERE object_key = ?").get(old.manifest.key)).toEqual({ n: 1 });
  });

  it("a stale blob that holds some parts gets its manifest and those parts quarantined", async () => {
    const { s, dev } = await setup();
    const b = dev.blob(new Uint8Array(randomBytes(600)), "photo", 256);
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    await s.svc.ingester.poll(); // part 0 committed (kept in R2 as a media original part)
    ageBlob(s, b.oid, 9);
    await s.svc.ingester.poll();
    expect(blobRow(s, b.oid).status).toBe("quarantined");
    expect(upKeys(s)).not.toContain(b.manifest.key);
    expect(upKeys(s)).not.toContain(b.parts[0]!.key);
    expect(qRow(s, b.manifest.key)).toBeTruthy();
    expect(qRow(s, b.parts[0]!.key)).toBeTruthy();
  });
});

describe("POST /api/blobs/:oid/abandon", () => {
  it("quarantines a young assembling blob on demand, with the same effects", async () => {
    const { s, dev } = await setup();
    const b = await manifestOnly(dev);
    await s.svc.ingester.poll();
    const quarantinedEvents: string[] = [];
    s.svc.ctx.events.on((e) => { if (e.type === "ingest.quarantined") quarantinedEvents.push(e.type); });

    const r = await api(s.svc, "POST", `/api/blobs/${b.oid}/abandon`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, oid: b.oid, reason: expect.any(String), quarantined: 1 });
    expect(blobRow(s, b.oid).status).toBe("quarantined");
    expect(upKeys(s)).not.toContain(b.manifest.key);
    expect(qRow(s, b.manifest.key)).toBeTruthy();
    expect(ledger(s, b.manifest.key)).toEqual({ status: "quarantined" });
    expect(quarantinedEvents.length).toBe(1);

    // it left the pending list, and a second call is a conflict
    const status = await api(s.svc, "GET", "/api/ingest/status");
    expect(status.json.pendingBlobs.map((p: { oid: string }) => p.oid)).not.toContain(b.oid);
    expect((await api(s.svc, "POST", `/api/blobs/${b.oid}/abandon`)).status).toBe(409);
  });

  it("404 for an unknown oid, 409 for a complete blob", async () => {
    const { s, dev } = await setup();
    expect((await api(s.svc, "POST", "/api/blobs/0000000000000000000000000/abandon")).status).toBe(404);
    const done = dev.blob(PNG_1x1, "photo", 64);
    await dev.putBlob(done);
    await s.svc.ingester.poll();
    expect(blobRow(s, done.oid).status).toBe("complete");
    expect((await api(s.svc, "POST", `/api/blobs/${done.oid}/abandon`)).status).toBe(409);
    expect(blobRow(s, done.oid).status).toBe("complete");
  });

  it("needs the session token", async () => {
    const { s } = await setup();
    const r = await s.svc.app.inject({ method: "POST", url: "/api/blobs/x/abandon", headers: { host: "127.0.0.1" } });
    expect(r.statusCode).toBe(401);
  });
});
