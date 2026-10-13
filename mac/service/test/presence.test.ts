/**
 * Device presence stays honest during a large media backfill (PLAN decision 21). Covers:
 *  - a committed object records when the device made it (devices.last_upload_at, from its oid), not when the
 *    Mac committed it;
 *  - the Mac working through an old backlog does not make a quiet device look alive;
 *  - a long blob flood never starves the heartbeat: the pass caps on wall clock, the report still lands;
 *  - the backlog drains over later passes;
 *  - presence follows the freshest of report/upload, and a stalled heartbeat is surfaced, not hidden.
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
type Row = { last_seen: string; last_report_at: string; last_upload_at: string | null };
const device = () => db().prepare("SELECT last_seen, last_report_at, last_upload_at FROM devices").get() as Row;
const covDevice = () => coverage(st.svc.ctx).devices.find((x) => x.deviceId === dev.deviceId)!;
const blobObjectsInR2 = () => st.s3.mock.listAll("ivy-up-windows").filter((o: { key: string }) => o.key.includes("/blob/")).length;
const ms = (s: string) => new Date(s).getTime();
const OLD_MS = Date.now() - 50 * 60_000; // 50 min ago → amber by the 15-min threshold
const OLD = new Date(OLD_MS).toISOString();

function setStale() {
  db().prepare("UPDATE devices SET last_seen = ?, last_report_at = ?, last_upload_at = ? WHERE id = ?").run(OLD, OLD, OLD, dev.deviceId);
}
async function flood(n: number) { for (let i = 0; i < n; i++) await dev.putBlob(dev.blob(randomBytes(300), "photo", 256, { ms: Date.now() + i })); }

beforeAll(async () => { st = await fullStack(); dev = await pairNew(st.svc); });
afterAll(async () => { dev?.close(); await st.cleanup(); });

describe("device presence during a backfill (PLAN 21)", () => {
  it("a committed blob records when the device made it", async () => {
    setStale();
    const made = Date.now() - 5_000;
    await dev.putBlob(dev.blob(randomBytes(300), "photo", 256, { ms: made }));
    await st.svc.ingester.poll();
    const d = device();
    expect(ms(d.last_upload_at!)).toBe(made);   // the blob's own creation time, not the Mac's commit time
    expect(d.last_report_at).toBe(OLD);          // no report sent: the two are tracked apart
    expect(covDevice().status).toBe("green");
  });

  it("an old backlog committed now does not make a quiet device look alive", async () => {
    setStale();
    // the device made these 50 minutes ago and has sent nothing since; the Mac only now commits them
    await dev.putBlob(dev.blob(randomBytes(300), "photo", 256, { ms: OLD_MS + 1_000 }));
    await st.svc.ingester.poll();
    const d = device();
    expect(ms(d.last_upload_at!)).toBeLessThan(Date.now() - 45 * 60_000); // still the device's old time
    const cd = covDevice();
    expect(cd.status).not.toBe("green");                                   // quiet device shown as stale
    expect(ms(cd.lastHeard!)).toBeLessThan(Date.now() - 45 * 60_000);
    expect(coverage(st.svc.ctx).problems.some((p) => /last heard/.test(p.message))).toBe(true);
  });

  it("an object dated in the future (device clock ahead) is capped at the Mac's clock", async () => {
    setStale();
    await dev.putBlob(dev.blob(randomBytes(300), "photo", 256, { ms: Date.now() + 3_600_000 }));
    await st.svc.ingester.poll();
    expect(ms(device().last_upload_at!)).toBeLessThanOrEqual(Date.now());
  });

  it("a new report refreshes last_report and last-heard", async () => {
    setStale();
    await dev.report([{ name: "files", lastRunAt: iso() }]);
    await st.svc.ingester.poll();
    const d = device();
    expect(ms(d.last_seen)).toBeGreaterThan(ms(OLD));
    expect(ms(d.last_report_at)).toBeGreaterThan(ms(OLD));
    expect(ms(d.last_upload_at!)).toBeGreaterThan(ms(OLD));
    expect(covDevice().status).toBe("green");
  });

  it("a blob flood never starves the heartbeat: the pass caps but the report lands and the device stays green", async () => {
    st.svc.ctx.config.ingestPassBudgetMs = 0; // force the bulk/blob phase to cap immediately
    setStale();
    await flood(20);
    await dev.report([{ name: "files", lastRunAt: iso() }]);
    const r = await st.svc.ingester.poll();

    const wb = r.buckets.find((b) => b.bucket === "ivy-up-windows")!;
    expect(wb.capped).toBe(true);                                  // the pass ended on the time budget
    expect(ms(device().last_report_at)).toBeGreaterThan(ms(OLD));  // the heartbeat committed despite the flood
    expect(covDevice().status).toBe("green");                      // alive: the dot did not go stale
    expect(blobObjectsInR2()).toBeGreaterThan(0);                  // the flood is left in R2 for the next pass
  });

  it("the backlog drains over later passes once there is time budget", async () => {
    st.svc.ctx.config.ingestPassBudgetMs = 60_000;
    await st.svc.ingester.poll();
    await st.svc.ingester.poll();
    // every blob reached a terminal state; none left mid-assembly (media originals stay in R2 by design).
    const inProgress = (db().prepare("SELECT COUNT(*) AS n FROM blobs WHERE status IN ('assembling','awaiting_manifest')").get() as { n: number }).n;
    expect(inProgress).toBe(0);
  });

  it("presence follows last-heard, and a stalled heartbeat is surfaced (not hidden) and distinct from silence", async () => {
    // uploading now, but the heartbeat is behind: last_upload_at fresh, last_report_at old.
    db().prepare("UPDATE devices SET last_report_at = ?, last_upload_at = ? WHERE id = ?").run(OLD, nowIso(), dev.deviceId);
    const uploading = coverage(st.svc.ctx);
    const du = uploading.devices.find((x) => x.deviceId === dev.deviceId)!;
    expect(ms(du.lastHeard!)).toBeGreaterThan(ms(OLD));        // last-heard reflects the fresh upload
    expect(uploading.problems.some((p) => /no heartbeat/.test(p.message))).toBe(true); // the stall is shown

    // the Mac committed something just now, but the device sent nothing recent: still silent
    db().prepare("UPDATE devices SET last_seen = ?, last_report_at = ?, last_upload_at = ? WHERE id = ?").run(nowIso(), OLD, OLD, dev.deviceId);
    const silent = coverage(st.svc.ctx);
    expect(silent.devices.find((x) => x.deviceId === dev.deviceId)!.status).not.toBe("green");
    expect(silent.problems.some((p) => /last heard/.test(p.message))).toBe(true);
    expect(silent.problems.some((p) => /no heartbeat/.test(p.message))).toBe(false);
  });
});
