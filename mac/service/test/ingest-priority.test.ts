/**
 * A fresh device heartbeat (and new conversations/avatars) must reach the Mac promptly even while a large
 * file-listing backlog is still draining. The ingester processes the small high-priority records in full each
 * pass and the file listings up to a per-pass budget, so liveness stays current regardless of backlog size.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fullStack, pairNew } from "./helpers/harness.ts";
import { iso, type SimDevice } from "./helpers/device.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
afterEach(async () => { await st?.cleanup(); st = undefined; });

const fileCount = () => (st!.svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;

describe("bounded, priority ingest", () => {
  it("stores a fresh heartbeat in one poll even behind a large file backlog, and drains the backlog over passes", async () => {
    st = await fullStack({ ingestBulkBudget: 10 }); // tiny budget so the backlog spans several passes
    const dev = await pairNew(st.svc, "windows");

    // a file-listing backlog larger than one prefetch window, plus one fresh heartbeat
    const BACKLOG = 150;
    for (let i = 0; i < BACKLOG; i++) {
      await dev.put("file_meta", { path: `C:\\big\\f${i}.txt`, name: `f${i}.txt`, ext: "txt", size: 1, mtime: iso(), quickHash: `h${i}` });
    }
    await dev.report([{ name: "files", lastRunAt: iso() }], "2026-10-11T12:00:00.000Z");

    // one poll: the heartbeat lands even though the whole backlog can't
    await st.svc.ingester.poll();
    expect(st.svc.ctx.db.prepare("SELECT last_report_at FROM devices WHERE id = ?").get(dev.deviceId))
      .toEqual({ last_report_at: "2026-10-11T12:00:00.000Z" });
    const afterOne = fileCount();
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan(BACKLOG); // the file backlog is bounded per pass

    // further polls drain the rest
    for (let i = 0; i < 6 && fileCount() < BACKLOG; i++) await st.svc.ingester.poll();
    expect(fileCount()).toBe(BACKLOG);
    dev.close();
  });
});
