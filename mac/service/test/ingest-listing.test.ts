/**
 * The incremental listing must stay cheap as the archive grows. Media originals stay in R2 under
 * `up/blob/` for good (PLAN decision 11), so the poll lists from per-prefix positions: `up/anotif/` from
 * its position, and `up/` from the blob position (which also returns every prefix after `up/blob/`). These
 * tests check that an idle poll costs the same number of ListObjectsV2 calls whatever the archive size, that
 * a flood never hides a small record, that the blob position never passes a blob still assembling, and that
 * a late record below every position is found after its device comes back or by the hourly sweep.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { makeOid } from "@ivy/protocol";
import { fullStack, pairNew } from "./helpers/harness.ts";
import { PNG_1x1, iso, type SimDevice } from "./helpers/device.ts";
import { getSetting, setSetting } from "../src/db/index.ts";

const BUCKET = "ivy-up-windows";
const DAY = 86400_000;
type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
let dev: SimDevice | undefined;
afterEach(async () => { dev?.close(); dev = undefined; await st?.cleanup(); st = undefined; });

const db = () => st!.svc.ctx.db;
const listsPerBucket = () => {
  const m: Record<string, number> = {};
  for (const r of st!.s3.mock.requests()) if (r.operation === "ListObjectsV2") m[r.bucket ?? "?"] = (m[r.bucket ?? "?"] ?? 0) + 1;
  return m;
};
const win = async (opts: { full?: boolean } = {}) => (await st!.svc.ingester.poll(opts)).buckets.find((b) => b.bucket === BUCKET)!;
const pos = (prefix: string) => getSetting(db(), `pos:${BUCKET}:${prefix}`) ?? null;
const blobStatus = (oid: string) => (db().prepare("SELECT status FROM blobs WHERE oid = ?").get(oid) as { status: string } | undefined)?.status;
const oldOid = (msAgo: number) => makeOid(Date.now() - msAgo, new Uint8Array(randomBytes(10)));
const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
/** make every pairing look long closed (older than ttl + grace), so `pair/` is not listed */
const closeAllPairings = () => {
  const old = iso(Date.now() - 2 * 3600_000);
  db().prepare("UPDATE pairings SET created_at = ?, consumed_at = CASE WHEN consumed_at IS NULL THEN NULL ELSE ? END").run(old, old);
};

/** Ingest `n` kept one-part photo originals, then return the ListObjectsV2 calls of one idle poll. */
async function idleListsAfterKeptMedia(n: number) {
  st = await fullStack();
  dev = await pairNew(st.svc, "windows");
  for (let i = 0; i < n; i += 100) {
    await Promise.all(Array.from({ length: Math.min(100, n - i) }, () =>
      dev!.putBlob(dev!.blob(new Uint8Array([...PNG_1x1, ...randomBytes(32)]), "photo", 4096))));
  }
  for (let pass = 0; pass < 10 && count("SELECT COUNT(*) AS n FROM blobs WHERE status = 'complete'") < n; pass++) await win();
  expect(count("SELECT COUNT(*) AS n FROM blobs WHERE status = 'complete'")).toBe(n);
  expect(st.s3.mock.listAll(BUCKET).length).toBe(2 * n); // every manifest and part is kept in R2
  await win(); // settle anything the last ingest pass left to its successor
  closeAllPairings();
  st.s3.mock.clearRequests();
  const r = await win();
  expect(r).toMatchObject({ full: false, listed: 0, committed: 0, replayed: 0 });
  return listsPerBucket();
}

describe("incremental listing from per-prefix positions", () => {
  it("an idle poll makes the same ListObjectsV2 calls for 50 and 2,500 kept media blobs, two per bucket", async () => {
    const small = await idleListsAfterKeptMedia(50);
    await st!.cleanup(); dev!.close(); st = undefined; dev = undefined;
    const large = await idleListsAfterKeptMedia(2500); // 5,000 keys kept: a whole-bucket listing would be 5 pages
    expect(large).toEqual(small);
    expect(large).toEqual({ "ivy-up-windows": 2, "ivy-up-android": 2 });
  }, 300_000);

  it("a device status report behind 150 fresh file listings is committed on the very next poll", async () => {
    st = await fullStack({ ingestBulkBudget: 10 }); // the `up/` call is capped at 2 * 10 + 100 = 120 keys
    dev = await pairNew(st.svc, "windows");
    for (let i = 0; i < 150; i++) {
      await dev.put("file_meta", { path: `C:\\flood\\f${i}.txt`, name: `f${i}.txt`, ext: "txt", size: 1, mtime: iso(), quickHash: `h${i}` });
    }
    await dev.report([{ name: "files", lastRunAt: iso() }], "2026-10-11T12:00:00.000Z");

    closeAllPairings();
    st.s3.mock.clearRequests();
    const r = await win();
    expect(r.full).toBe(false);
    expect(db().prepare("SELECT last_report_at FROM devices WHERE id = ?").get(dev.deviceId)).toEqual({ last_report_at: "2026-10-11T12:00:00.000Z" });
    // anotif, the capped `up/` call ending inside up/file/, then one call each for lineacct, msg, scr, status, usg, wnotif
    expect(listsPerBucket()["ivy-up-windows"]).toBe(8);

    // the file position moves only over the file listings actually ingested, never to the last one listed
    const files = count("SELECT COUNT(*) AS n FROM files");
    expect(files).toBeGreaterThan(0);
    expect(files).toBeLessThan(150);
    const committedFiles = (db().prepare("SELECT object_key FROM sync_objects WHERE kind = 'file_meta' AND status = 'committed'").all() as Array<{ object_key: string }>)
      .map((x) => x.object_key.split("/")[2]!).sort();
    expect(pos("file")).toBe(committedFiles[committedFiles.length - 1]);

    for (let i = 0; i < 30 && count("SELECT COUNT(*) AS n FROM files") < 150; i++) await win();
    expect(count("SELECT COUNT(*) AS n FROM files")).toBe(150);
    st.s3.mock.clearRequests();
    await win();
    expect(listsPerBucket()["ivy-up-windows"]).toBe(2);
  });

  it("a large blob whose parts are still arriving is not skipped after a newer avatar blob commits", async () => {
    st = await fullStack();
    dev = await pairNew(st.svc, "windows");
    const big = dev.blob(new Uint8Array([...PNG_1x1, ...randomBytes(1000)]), "photo", 256, { ms: Date.now() - 60_000 });
    expect(big.parts.length).toBeGreaterThan(2);
    await dev.up.put(big.manifest.key, big.manifest.bytes); // manifest first, as the Windows uploader sends it
    await dev.up.put(big.parts[0]!.key, big.parts[0]!.bytes);
    const avatar = dev.blob(PNG_1x1, "avatar", 256);
    expect(avatar.oid > big.oid).toBe(true);
    await dev.putBlob(avatar);

    await win();
    expect(blobStatus(avatar.oid)).toBe("complete");
    expect(blobStatus(big.oid)).toBe("assembling");
    expect(pos("blob")! < big.oid).toBe(true); // held below the unfinished blob, not moved past the avatar
    await win(); // idle passes keep it there
    expect(pos("blob")! < big.oid).toBe(true);

    for (const p of big.parts.slice(1)) await dev.up.put(p.key, p.bytes);
    const r = await win();
    expect(r.full).toBe(false);
    expect(blobStatus(big.oid)).toBe("complete");
    expect(db().prepare("SELECT local_path IS NOT NULL AS placed FROM blobs WHERE oid = ?").get(big.oid)).toEqual({ placed: 1 });
    // settled: the position moves past it (the avatar was deleted from R2 after commit, so nothing is left to list)
    expect(pos("blob")! >= big.oid).toBe(true);
    closeAllPairings();
    expect(await win()).toMatchObject({ listed: 0 });
  });

  it("a blob stuck assembling longer than one full-sweep interval no longer holds the blob position back", async () => {
    st = await fullStack();
    dev = await pairNew(st.svc, "windows");
    const stuck = dev.blob(new Uint8Array([...PNG_1x1, ...randomBytes(600)]), "photo", 256, { ms: Date.now() - 60_000 });
    await dev.up.put(stuck.manifest.key, stuck.manifest.bytes); // no part ever arrives
    const later = dev.blob(new Uint8Array([...PNG_1x1, ...randomBytes(32)]), "photo", 4096);
    await dev.putBlob(later);
    await win();
    expect(blobStatus(stuck.oid)).toBe("assembling");
    expect(pos("blob")! < stuck.oid).toBe(true);

    // past fullSweepEveryMs (60 min): the hourly full listing still sees it, so it stops pinning the position
    db().prepare("UPDATE blobs SET first_seen_at = ? WHERE oid = ?").run(new Date(Date.now() - 61 * 60_000).toISOString(), stuck.oid);
    await win();
    expect(pos("blob")! >= later.oid).toBe(true);
    st.s3.mock.clearRequests();
    expect(await win()).toMatchObject({ listed: 0 }); // its kept manifest is no longer re-listed every pass
  });

  it("a late record older than every position is committed once its device comes back, and by the hourly sweep", async () => {
    st = await fullStack();
    dev = await pairNew(st.svc, "windows");
    await dev.put("usage_event", { app: "Fresh", startedAt: iso(), endedAt: iso() });
    await win();
    expect(pos("usg")).not.toBeNull();

    // 30 days old: below the usg position minus the 8-day look-back, so the incremental listing skips it
    const t30 = iso(Date.now() - 30 * DAY);
    await dev.put("usage_event", { app: "Late1", startedAt: t30, endedAt: t30 }, { oid: oldOid(30 * DAY) });
    expect(await win()).toMatchObject({ full: false, committed: 0 });
    expect(count("SELECT COUNT(*) AS n FROM usage_events WHERE app = 'Late1'")).toBe(0);

    // the device was silent for an hour; its report arrives with a queue still draining
    db().prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(iso(Date.now() - 3600_000), dev.deviceId);
    await dev.report([{ name: "usage", lastRunAt: iso(), queueDepth: 5 }]);
    expect(await win()).toMatchObject({ full: false, committed: 1 }); // the report
    expect(await win()).toMatchObject({ full: true, committed: 1 }); // the device-return full listing
    expect(count("SELECT COUNT(*) AS n FROM usage_events WHERE app = 'Late1'")).toBe(1);

    // more of the queue drains; the first report showing it empty asks for one more full listing
    await dev.put("usage_event", { app: "Late2", startedAt: t30, endedAt: t30 }, { oid: oldOid(29 * DAY) });
    await dev.report([{ name: "usage", lastRunAt: iso(), queueDepth: 0 }]);
    expect(await win()).toMatchObject({ full: false });
    expect(await win()).toMatchObject({ full: true });
    expect(count("SELECT COUNT(*) AS n FROM usage_events WHERE app = 'Late2'")).toBe(1);
    expect(await win()).toMatchObject({ full: false });

    // the hourly sweep still lists everything
    await dev.put("usage_event", { app: "Late3", startedAt: t30, endedAt: t30 }, { oid: oldOid(28 * DAY) });
    expect(await win()).toMatchObject({ full: false });
    expect(count("SELECT COUNT(*) AS n FROM usage_events WHERE app = 'Late3'")).toBe(0);
    (st.svc.ingester as unknown as { lastFull: Map<string, number> }).lastFull.set(BUCKET, Date.now() - 2 * 3600_000);
    expect(await win()).toMatchObject({ full: true });
    expect(count("SELECT COUNT(*) AS n FROM usage_events WHERE app = 'Late3'")).toBe(1);
  });

  it("an install with only the old bucket-wide marker starts every prefix from it", async () => {
    st = await fullStack();
    dev = await pairNew(st.svc, "windows");
    expect(pos("msg")).toBeNull();
    const marker = oldOid(DAY);
    setSetting(db(), `marker:${BUCKET}`, marker);
    expect(st.svc.ingester.marker(BUCKET)).toBe(marker);
    for (const p of ["anotif", "blob", "file", "msg", "status"]) expect(pos(p)).toBe(marker);
  });
});
