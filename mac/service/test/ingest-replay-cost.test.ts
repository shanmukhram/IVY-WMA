/**
 * A key the ledger already settled must not be downloaded again just to be recognised as a replay, and the
 * poll timer keeps a fixed cadence from pass start. Before this, every pass re-fetched each listed known
 * object (a stuck media manifest, a delete that had not flushed) and the next pass was armed only after the
 * previous one ended, so a slow pass stretched the cadence to pass duration + interval.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { fullStack, pairNew } from "./helpers/harness.ts";
import { iso, type SimDevice } from "./helpers/device.ts";
import { Bucket } from "../src/r2/client.ts";
import { Ingester, type PollResult } from "../src/ingest/ingester.ts";

const BUCKET = "ivy-up-windows";
let st: Awaited<ReturnType<typeof fullStack>>;
let dev: SimDevice;
const db = () => st.svc.ctx.db;
const getsFor = (keys: string[]) => st.s3.mock.requests().filter((r) => r.operation === "GetObject" && keys.includes(r.key ?? ""));
const win = (r: PollResult) => r.buckets.find((b) => b.bucket === BUCKET)!;
const upKeys = async () => (await st.svc.ctx.r2()!.bucket("up", "windows")!.list()).map((o) => o.key);

beforeAll(async () => {
  st = await fullStack();
  dev = await pairNew(st.svc, "windows");
});
afterAll(async () => { dev.close(); await st.cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("replays are settled from the ledger without a GET", () => {
  it("a committed record whose delete did not flush is replayed and deleted with zero GetObject", async () => {
    const key = await dev.put("usage_event", { app: "NoFlush", startedAt: iso(), endedAt: iso() });
    // the batch delete reports every key as failed, so the object stays in R2 with its original LastModified
    const spy = vi.spyOn(Bucket.prototype, "deleteMany").mockImplementationOnce(async (keys: string[]) => keys);
    expect(win(await st.svc.ingester.poll()).committed).toBe(1);
    spy.mockRestore();
    expect(await upKeys()).toContain(key);

    st.s3.mock.clearRequests();
    const r = win(await st.svc.ingester.poll());
    expect(r).toMatchObject({ replayed: 1, committed: 0, quarantined: 0 });
    expect(getsFor([key])).toEqual([]);
    expect(await upKeys()).not.toContain(key);
    expect(db().prepare("SELECT COUNT(*) AS n FROM usage_events WHERE app = 'NoFlush'").get()).toEqual({ n: 1 });
  });

  it("a blob stuck assembling (kept media manifest, a part never uploaded) costs zero GETs after its first pass", async () => {
    const b = dev.blob(new Uint8Array(randomBytes(500)), "photo", 256); // 2 parts
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes); // part 1 never arrives
    const keys = [b.manifest.key, b.parts[0]!.key];

    st.s3.mock.clearRequests();
    expect(win(await st.svc.ingester.poll()).committed).toBe(2);
    expect(getsFor(keys).length).toBe(2); // read once each, then kept in R2 (media original)
    expect(db().prepare("SELECT status FROM blobs WHERE oid = ?").get(b.oid)).toEqual({ status: "assembling" });

    for (let pass = 2; pass <= 4; pass++) {
      st.s3.mock.clearRequests();
      const r = win(await st.svc.ingester.poll());
      expect(r).toMatchObject({ replayed: 2, committed: 0, quarantined: 0 });
      expect(getsFor(keys)).toEqual([]);
    }
    expect(await upKeys()).toEqual(expect.arrayContaining(keys)); // still kept
    expect(db().prepare("SELECT status FROM blobs WHERE oid = ?").get(b.oid)).toEqual({ status: "assembling" });
  });

  it("after a restart a kept manifest written well before it was ingested is still settled without a GET", async () => {
    const b = dev.blob(new Uint8Array(randomBytes(300)), "photo", 256); // 2 parts, only the manifest arrives
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await st.svc.ingester.poll();
    // as if the Mac had ingested it ten minutes after R2 wrote it
    db().prepare("UPDATE sync_objects SET ingested_at = ? WHERE object_key = ?").run(new Date(Date.now() + 10 * 60_000).toISOString(), b.manifest.key);
    await st.restart();
    st.s3.mock.clearRequests();
    expect(win(await st.svc.ingester.poll()).replayed).toBeGreaterThanOrEqual(1);
    expect(getsFor([b.manifest.key])).toEqual([]);
  });

  it("a same-size re-upload with different bytes under a committed key is still fetched and quarantined", async () => {
    const s = dev.seal("windows_notification", { app: "Slack", title: "Original", text: "1", postedAt: iso() });
    await dev.up.put(s.key, s.bytes);
    await st.svc.ingester.poll();
    const forged = dev.seal("windows_notification", { app: "Slack", title: "Forgery!", text: "2", postedAt: iso() }, { oid: s.key.split("/")[2] });
    expect(forged.bytes.length).toBe(s.bytes.length);
    await new Promise((r) => setTimeout(r, 5)); // a later LastModified than the copy already read
    await dev.up.put(forged.key, forged.bytes);
    st.s3.mock.clearRequests();
    const r = win(await st.svc.ingester.poll());
    expect(r.quarantined).toBe(1);
    expect(getsFor([s.key]).length).toBeGreaterThanOrEqual(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = 'Forgery!'").get()).toEqual({ n: 0 });
  });
});

describe("poll cadence", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("runs passes every interval from pass start, never overlapping, and an overrun does not add a gap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t0 = Date.now();
    const ctx = { config: { pollIntervalMs: 100 }, keystore: { isUnlocked: () => true }, events: { emit() { /* ignore */ } } };
    const ing = new Ingester(ctx as never);
    const durations = [250, 30, 30, 170, 30, 30];
    const starts: number[] = [];
    let active = 0, maxActive = 0;
    ing.poll = () => {
      const d = durations[starts.length] ?? 30;
      starts.push(Date.now() - t0);
      active++; maxActive = Math.max(maxActive, active);
      return new Promise<PollResult>((res) => setTimeout(() => { active--; res({ at: "", buckets: [], durationMs: d }); }, d));
    };
    ing.start();
    await vi.advanceTimersByTimeAsync(1_840); // through the start of the 7th pass
    await ing.stop();
    // first pass after 1 s; the 250 ms pass overruns the 100 ms interval, so the next starts as it ends;
    // short passes keep 100 ms from pass start; the 170 ms overrun again starts the next one at once.
    // (a zero-delay timer still fires 1 ms later, as in Node, hence the 2 ms tolerance)
    expect(starts[0]).toBe(1000);
    expect(starts.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < 7; i++) {
      const gap = starts[i]! - starts[i - 1]!;
      const want = Math.max(100, durations[i - 1]!);
      expect(gap).toBeGreaterThanOrEqual(want);
      expect(gap).toBeLessThanOrEqual(want + 2);
    }
    expect(maxActive).toBe(1);
    const n = starts.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts.length).toBe(n); // stop() ends the chain
  });
});
