/**
 * A media backlog the incremental listing no longer reaches must still drain (Oct 14 2026, live Mac):
 * 1,042 Telegram photos had their manifests ingested, their data parts arrived in R2 later, and by then the
 * blob listing position had moved past them (a blob unsettled for over an hour stops holding it back). Only
 * the hourly full listing still lists their parts, and in that pass everything before the blob-part phase
 * (file listings, a forgotten PC's leftover objects, every manifest) shared one wall-clock budget; the part
 * phase checked the budget before fetching anything, so it fetched nothing, every hour.
 *
 * Now the part phase always makes progress (at least one window of parts per pass), and a full listing
 * that ran out of time with listed parts still waiting asks for another full listing on the next pass,
 * until they are all in. A full listing asked for while a pass is running is no longer dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { makeOid } from "@ivy/protocol";
import { fullStack, pairNew } from "./helpers/harness.ts";
import type { SimDevice } from "./helpers/device.ts";
import { setSetting } from "../src/db/index.ts";
import type { PollResult } from "../src/ingest/ingester.ts";

const BUCKET = "ivy-up-windows";
let st: Awaited<ReturnType<typeof fullStack>>;
let dev: SimDevice;
const db = () => st.svc.ctx.db;
const win = (r: PollResult) => r.buckets.find((b) => b.bucket === BUCKET)!;

beforeEach(async () => {
  st = await fullStack();
  dev = await pairNew(st.svc, "windows");
});
afterEach(async () => { dev.close(); await st.cleanup(); });

/** N single-part photos created `agoMs` ago whose manifests were ingested but whose data part came later. */
async function stuckBacklog(n: number, agoMs: number) {
  const made = Date.now() - agoMs;
  const blobs = Array.from({ length: n }, (_, i) => dev.blob(new Uint8Array(randomBytes(200)), "photo", 256, { ms: made + i }));
  for (const b of blobs) await dev.up.put(b.manifest.key, b.manifest.bytes);
  await st.svc.ingester.poll(); // the first pass lists in full: every manifest is opened, the blobs wait for data
  const oids = blobs.map((b) => b.oid);
  const assembling = () => (db().prepare(`SELECT COUNT(*) AS n FROM blobs WHERE status = 'assembling' AND oid IN (${oids.map(() => "?").join(",")})`)
    .get(...oids) as { n: number }).n;
  expect(assembling()).toBe(n);
  // as on the live Mac: first seen over an hour ago, so they no longer hold the listing position back,
  // and the position has moved past them; then the data parts land in R2
  db().prepare(`UPDATE blobs SET first_seen_at = ? WHERE oid IN (${oids.map(() => "?").join(",")})`).run(new Date(Date.now() - 2 * 3_600_000).toISOString(), ...oids);
  setSetting(db(), `pos:${BUCKET}:blob`, makeOid(Date.now() - 60_000, new Uint8Array(10)));
  for (const b of blobs) await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
  return { oids, assembling };
}

describe("a media backlog below the listing position", () => {
  it("is not reached by the incremental listing (the condition the live Mac was in)", async () => {
    const { assembling } = await stuckBacklog(20, 3 * 3_600_000);
    const r = win(await st.svc.ingester.poll());
    expect(r.full).toBe(false);
    expect(assembling()).toBe(20);
  });

  it("drains through full listings even when the pass's time budget is already spent before the part phase", async () => {
    const N = 150;
    const { assembling } = await stuckBacklog(N, 3 * 3_600_000);
    st.svc.ctx.config.ingestPassBudgetMs = 0; // everything before the part phase used up the budget
    st.svc.ingester.requestFull();             // the hourly full listing comes round

    let passes = 0;
    const fulls: boolean[] = [];
    while (assembling() > 0 && passes < 10) {
      const r = win(await st.svc.ingester.poll());
      fulls.push(r.full);
      passes++;
    }
    expect(assembling()).toBe(0);
    expect(passes).toBeLessThanOrEqual(Math.ceil(N / 64) + 1); // at least one window of parts per pass
    expect(fulls.every(Boolean)).toBe(true);                   // each capped full pass asked for the next to be full
    expect(db().prepare("SELECT COUNT(*) AS n FROM blobs WHERE status = 'complete' AND payload_kind = 'photo'").get()).toEqual({ n: N });

    // the pass that took the last of them left nothing behind, so the listing goes back to incremental:
    // a pass that only ran long (budget 0 here) does not keep asking for full listings
    expect(win(await st.svc.ingester.poll()).full).toBe(false);
    expect(win(await st.svc.ingester.poll()).full).toBe(false);
  });

  it("with a normal budget, one full listing brings the whole backlog in", async () => {
    const { assembling } = await stuckBacklog(120, 3 * 3_600_000);
    st.svc.ingester.requestFull();
    const r = win(await st.svc.ingester.poll());
    expect(r.full).toBe(true);
    expect(r.errors).toBe(0);
    expect(assembling()).toBe(0);
  });
});

describe("asking for a full listing while a pass is running", () => {
  it("is not dropped: the caller gets a full pass", async () => {
    const { assembling } = await stuckBacklog(10, 3 * 3_600_000);
    const running = st.svc.ingester.poll();          // an ordinary pass is in flight
    const full = st.svc.ingester.poll({ full: true }); // a sync-now arrives meanwhile
    expect(win(await running).full).toBe(false);
    expect(win(await full).full).toBe(true);
    expect(assembling()).toBe(0);
  });
});
