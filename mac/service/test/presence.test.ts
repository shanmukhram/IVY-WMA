/**
 * Device presence stays honest during a large media backfill (PLAN decision 21).
 * The device is alive and uploading; the Mac must not show it stale. Covers:
 *  - a committed blob refreshes last_seen (a device uploading media is not stale);
 *  - a long blob flood never starves the heartbeat: the pass caps on wall clock, the report still lands;
 *  - the backlog drains over later passes;
 *  - presence follows the freshest of report/seen, and a stalled heartbeat is surfaced, not hidden.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { fullStack, pairNew } from "./helpers/harness.ts";
import { SimDevice, iso } from "./helpers/device.ts";
import { coverage } from "../src/query/coverage.ts";
import { nowIso } from "../src/util/time.ts";

let st: Awaited<ReturnType<typeof fullStack>>;
let dev: SimDevice;
const db = () => st.svc.ctx.db;
const device = () => db().prepare("SELECT last_seen, last_report_at FROM devices").get() as { last_seen: string; last_report_at: string };
const covDevice = () => coverage(st.svc.ctx).devices.find((x) => x.deviceId === dev.deviceId)!;
const blobObjectsInR2 = () => st.s3.mock.listAll("ivy-up-windows").filter((o: { key: string }) => o.key.includes("/blob/")).length;
const ms = (s: string) => new Date(s).getTime();
const OLD = new Date(Date.now() - 50 * 60_000).toISOString(); // 50 min ago → amber by the 15-min threshold

function setStale() { db().prepare("UPDATE devices SET last_seen = ?, last_report_at = ? WHERE id = ?").run(OLD, OLD, dev.deviceId); }
async function flood(n: number) { for (let i = 0; i < n; i++) await dev.putBlob(dev.blob(randomBytes(300), "photo", 256, { ms: Date.now() + i })); }

beforeAll(async () => { st = await fullStack(); dev = await pairNew(st.svc); });
afterAll(async () => { dev?.close(); await st.cleanup(); });

describe("device presence during a backfill (PLAN 21)", () => {
  it("B: committing a blob refreshes last_seen — a device uploading media is not stale", async () => {
    setStale();
    await dev.putBlob(dev.blob(randomBytes(300), "photo", 256));
    await st.svc.ingester.poll();
    const d = device();
    expect(ms(d.last_seen)).toBeGreaterThan(ms(OLD));  // the upload refreshed presence
    expect(d.last_report_at).toBe(OLD);                 // no report sent: the two are tracked apart
  });

  it("B: a new report refreshes last_seen and last_report", async () => {
    setStale();
    await dev.report([{ name: "files", lastRunAt: iso() }]);
    await st.svc.ingester.poll();
    const d = device();
    expect(ms(d.last_seen)).toBeGreaterThan(ms(OLD));
    expect(ms(d.last_report_at)).toBeGreaterThan(ms(OLD));
  });

  it("C: a blob flood never starves the heartbeat — the pass caps but the report lands and the device stays green", async () => {
    st.svc.ctx.config.ingestPassBudgetMs = 0; // force the bulk/blob phase to cap immediately
    setStale();
    await flood(20);
    await dev.report([{ name: "files", lastRunAt: iso() }]);
    const r = await st.svc.ingester.poll();

    const wb = r.buckets.find((b) => b.bucket === "ivy-up-windows")!;
    expect(wb.capped).toBe(true);                              // the pass ended on the time budget
    expect(ms(device().last_report_at)).toBeGreaterThan(ms(OLD)); // the heartbeat committed despite the flood
    expect(covDevice().status).toBe("green");                  // alive: the dot did not go stale
    expect(blobObjectsInR2()).toBeGreaterThan(0);              // the flood is left in R2 for the next pass
  });

  it("C: the backlog drains over later passes once there is time budget", async () => {
    st.svc.ctx.config.ingestPassBudgetMs = 60_000;
    await st.svc.ingester.poll();
    await st.svc.ingester.poll();
    // every blob reached a terminal state; none left mid-assembly (media originals stay in R2 by design).
    const inProgress = (db().prepare("SELECT COUNT(*) AS n FROM blobs WHERE status IN ('assembling','awaiting_manifest')").get() as { n: number }).n;
    expect(inProgress).toBe(0);
  });

  it("D: presence follows last-heard, and a stalled heartbeat is surfaced (not hidden) and distinct from silence", async () => {
    // uploading now, but the heartbeat is behind: last_seen fresh, last_report_at old.
    db().prepare("UPDATE devices SET last_report_at = ?, last_seen = ? WHERE id = ?").run(OLD, nowIso(), dev.deviceId);
    const uploading = coverage(st.svc.ctx);
    const du = uploading.devices.find((x) => x.deviceId === dev.deviceId)!;
    expect(du.lastHeard).toBeTruthy();
    expect(ms(du.lastHeard!)).toBeGreaterThan(ms(OLD));        // last-heard reflects the fresh upload
    expect(uploading.problems.some((p) => /no heartbeat/.test(p.message))).toBe(true); // the stall is shown

    // truly silent: nothing heard at all — a different, "last heard" message.
    setStale();
    const silent = coverage(st.svc.ctx);
    expect(silent.problems.some((p) => /last heard/.test(p.message))).toBe(true);
    expect(silent.problems.some((p) => /no heartbeat/.test(p.message))).toBe(false);
  });
});
