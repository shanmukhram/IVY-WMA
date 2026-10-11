/**
 * R2 bills lists as Class A operations (1 million free per month). At the default
 * poll interval (5 s, 17 280 polls a day) the Mac's listing must stay small and must
 * not grow with the archive: two ListObjectsV2 per up-bucket per idle poll (`up/anotif/`
 * from its position, and `up/` from the `up/blob/` position, which also returns every
 * prefix after it), `pair/` only while a pairing is open, and the hourly / catch-up
 * full listing in place of both. See ingest-listing.test.ts for archive size and floods.
 *
 * Adjusted when the listing moved to per-prefix positions: an idle poll used to be one
 * `up/` call that paged the whole bucket, kept media originals included; it is now two
 * single-page calls, so the expected counts below went from 1 to 2 per bucket.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { makeOid, newOid } from "@ivy/protocol";
import { fullStack, pairNew } from "./helpers/harness.ts";
import { SimDevice, iso } from "./helpers/device.ts";
import { setSetting } from "../src/db/index.ts";
import { startPairing } from "../src/pairing/pairing.ts";

const DAY = 86400_000;
const BUCKET = "ivy-up-windows";
let st: Awaited<ReturnType<typeof fullStack>>;
let dev: SimDevice;
const db = () => st.svc.ctx.db;
const lists = () => st.s3.mock.requests().filter((r) => r.operation === "ListObjectsV2");
const listsPerBucket = () => {
  const m: Record<string, number> = {};
  for (const r of lists()) m[r.bucket ?? "?"] = (m[r.bucket ?? "?"] ?? 0) + 1;
  return m;
};
/** make every pairing look long closed (older than ttl + grace) */
const closeAllPairings = () => {
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  db().prepare("UPDATE pairings SET created_at = ?, consumed_at = CASE WHEN consumed_at IS NULL THEN NULL ELSE ? END").run(old, old);
};

beforeAll(async () => {
  st = await fullStack();
  dev = await pairNew(st.svc, "windows"); // this pass was the first, full listing
});
afterAll(async () => { dev.close(); await st.cleanup(); });

describe("R2 list requests per poll", () => {
  // was "lists each up-bucket once": now two calls (anotif + up/ from the blob position), see the header
  it("an incremental poll lists each up-bucket twice", async () => {
    closeAllPairings();
    await dev.put("usage_event", { app: "Budget", startedAt: iso(), endedAt: iso() });
    st.s3.mock.clearRequests();
    const r = await st.svc.ingester.poll();
    expect(r.buckets.every((b) => !b.full)).toBe(true);
    expect(r.buckets.find((b) => b.bucket === BUCKET)!.committed).toBe(1);
    expect(listsPerBucket()).toEqual({ "ivy-up-windows": 2, "ivy-up-android": 2 });
  });

  it("pair/ is listed only while a pairing for that role is open", async () => {
    const p = await startPairing(st.svc.ctx, "android");
    st.s3.mock.clearRequests();
    await st.svc.ingester.poll();
    expect(listsPerBucket()).toEqual({ "ivy-up-windows": 2, "ivy-up-android": 3 });
    db().prepare("UPDATE pairings SET status = 'cancelled' WHERE id = ?").run(p.pairingId);
    closeAllPairings();
    st.s3.mock.clearRequests();
    await st.svc.ingester.poll();
    expect(listsPerBucket()).toEqual({ "ivy-up-windows": 2, "ivy-up-android": 2 });
  });

  it("the hourly full listing replaces the incremental calls (one list per bucket)", async () => {
    st.s3.mock.clearRequests();
    const r = await st.svc.ingester.poll({ full: true });
    expect(r.buckets.every((b) => b.full)).toBe(true);
    expect(listsPerBucket()).toEqual({ "ivy-up-windows": 1, "ivy-up-android": 1 });
  });

  // The bucket-wide marker is gone: each prefix has its own position (pos:<bucket>:<prefix>), still listed
  // with the look-back window, so this now moves the usg position, and the poll costs 2 lists per bucket.
  it("an object older than its prefix position but inside the window is still ingested by an incremental pass", async () => {
    setSetting(db(), `pos:${BUCKET}:usg`, newOid());
    const twoDaysAgo = makeOid(Date.now() - 2 * DAY, new Uint8Array(randomBytes(10)));
    await dev.put("usage_event", { app: "LateInWindow", startedAt: iso(), endedAt: iso() }, { oid: twoDaysAgo });
    st.s3.mock.clearRequests();
    const r = await st.svc.ingester.poll();
    expect(r.buckets.find((b) => b.bucket === BUCKET)).toMatchObject({ full: false, committed: 1 });
    expect((db().prepare("SELECT COUNT(*) AS n FROM usage_events WHERE app = 'LateInWindow'").get() as { n: number }).n).toBe(1);
    expect(listsPerBucket()).toEqual({ "ivy-up-windows": 2, "ivy-up-android": 2 });
  });
});
