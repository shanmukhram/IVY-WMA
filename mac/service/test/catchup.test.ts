/**
 * No lifecycle expiry on the up-buckets (PLAN decision 6): a Mac that was away for
 * weeks must catch up on its first poll. The incremental listing starts at
 * (marker - 8 days), so the service lists everything in full on start, after a
 * full unlock, and when the last successful poll is older than that window.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { makeOid, newOid } from "@ivy/protocol";
import { fullStack, pairNew, PASS } from "./helpers/harness.ts";
import { SimDevice, PNG_1x1, iso } from "./helpers/device.ts";
import { join } from "node:path";
import { openDb, setSetting } from "../src/db/index.ts";

const DAY = 86400_000;
const BUCKET = "ivy-up-windows";
let st: Awaited<ReturnType<typeof fullStack>>;
let dev: SimDevice;
const db = () => st.svc.ctx.db;
const upKeys = () => st.s3.mock.listAll(BUCKET).map((o) => o.key);
const oldOid = (daysAgo: number) => makeOid(Date.now() - daysAgo * DAY, new Uint8Array(randomBytes(10)));
const usageCount = (app: string) => (db().prepare("SELECT COUNT(*) AS n FROM usage_events WHERE app = ?").get(app) as { n: number }).n;

/** pretend the vault last polled successfully just now, with a marker at "now" */
function recentPollState() {
  setSetting(db(), `marker:${BUCKET}`, newOid());
  setSetting(db(), `poll:${BUCKET}`, JSON.stringify({ at: iso(), ok: true, error: null, lastOkAt: iso(), committed: 0, quarantined: 0, listed: 0, waiting: 0 }));
}

beforeAll(async () => {
  st = await fullStack();
  dev = await pairNew(st.svc, "windows");
});
afterAll(async () => { dev.close(); await st.cleanup(); });

describe("catch-up after a long absence (no up-bucket expiry)", () => {
  it("a fresh service with an old marker ingests objects whose oids are 30 days old", async () => {
    const t30 = new Date(Date.now() - 30 * DAY).toISOString();
    const keys = [
      await dev.put("usage_event", { app: "Away30", startedAt: t30, endedAt: t30 }, { oid: oldOid(30), eventTime: t30 }),
      await dev.put("usage_event", { app: "Away30", startedAt: new Date(Date.now() - 29 * DAY).toISOString(), endedAt: t30 }, { oid: oldOid(29) }),
    ];
    const b = dev.blob(PNG_1x1, "screenshot", 64, { ms: Date.now() - 30 * DAY });
    await dev.putBlob(b);
    keys.push(await dev.put("screenshot", { sourcePath: "C:\\shot.png", sha256: "x", blobOid: b.oid, takenAt: t30 }, { oid: oldOid(30) }));
    await st.svc.close();
    // the old service polled recently and its marker is newer than every waiting object by > 8 days
    recentPollStateOn(st.dataDir);
    const svc = await st.restart();
    const r = await svc.ingester.poll();
    expect(r.buckets.find((x) => x.bucket === BUCKET)).toMatchObject({ full: true });
    expect(usageCount("Away30")).toBe(2);
    expect(db().prepare("SELECT local_path IS NOT NULL AS placed FROM media WHERE blob_oid = ?").get(b.oid)).toEqual({ placed: 1 });
    for (const k of keys) expect(upKeys()).not.toContain(k);
    expect(upKeys().filter((k) => k.startsWith(`up/blob/${b.oid}/`))).toEqual([]);
  });

  it("a running service lists incrementally, but a full unlock lists everything again", async () => {
    await st.svc.ingester.poll(); // hourly full sweep already done: this pass is incremental
    recentPollState();
    const key = await dev.put("usage_event", { app: "LateOld", startedAt: iso(), endedAt: iso() }, { oid: oldOid(30) });
    const inc = await st.svc.ingester.poll();
    expect(inc.buckets.find((x) => x.bucket === BUCKET)).toMatchObject({ full: false });
    expect(upKeys()).toContain(key); // outside the marker window: not seen by an incremental pass
    st.svc.ctx.keystore.lock("test", { full: true });
    await st.svc.ctx.keystore.unlock(PASS);
    const full = await st.svc.ingester.poll();
    expect(full.buckets.find((x) => x.bucket === BUCKET)).toMatchObject({ full: true });
    expect(usageCount("LateOld")).toBe(1);
    expect(upKeys()).not.toContain(key);
  });

  it("a UI unlock does not force a full listing; a last successful poll older than the window does", async () => {
    await st.svc.ingester.poll();
    st.svc.ctx.keystore.lock("test");
    await st.svc.ctx.keystore.unlock(PASS);
    recentPollState();
    expect((await st.svc.ingester.poll()).buckets.find((x) => x.bucket === BUCKET)).toMatchObject({ full: false });
    const key = await dev.put("usage_event", { app: "StaleOld", startedAt: iso(), endedAt: iso() }, { oid: oldOid(20) });
    const nineDaysAgo = new Date(Date.now() - 9 * DAY).toISOString();
    setSetting(db(), `poll:${BUCKET}`, JSON.stringify({ at: nineDaysAgo, ok: true, error: null, lastOkAt: nineDaysAgo }));
    expect((await st.svc.ingester.poll()).buckets.find((x) => x.bucket === BUCKET)).toMatchObject({ full: true });
    expect(usageCount("StaleOld")).toBe(1);
    expect(upKeys()).not.toContain(key);
  });
});

/** recentPollState() on a closed service's database */
function recentPollStateOn(dataDir: string) {
  const d = openDb(join(dataDir, "vault.db"));
  try {
    setSetting(d, `marker:${BUCKET}`, newOid());
    setSetting(d, `poll:${BUCKET}`, JSON.stringify({ at: iso(), ok: true, error: null, lastOkAt: iso() }));
  } finally { d.close(); }
}
