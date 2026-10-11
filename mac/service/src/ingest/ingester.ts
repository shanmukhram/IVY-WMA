/**
 * The ingest loop (PRD S1-S5).
 *
 * Per pass, for each configured up-bucket:
 *   1. list what is new. Each record prefix has its own position (setting
 *      `pos:<bucket>:<prefix>`, an oid). An idle pass is two ListObjectsV2 calls
 *      whatever the archive size: `up/anotif/` from its position, and `up/`
 *      starting just after the `up/blob/` position, which returns the blobs after
 *      it plus every prefix that sorts after `up/blob/`. Media originals stay in
 *      `up/blob/` for good (PLAN decision 11), so starting there is what keeps the
 *      listing from growing with the archive. `pair/` is listed while a pairing is
 *      open. See listBucket. A full listing of the bucket runs on start and unlock,
 *      hourly, on demand, after an absence and after a device comes back; it also
 *      catches unrecognised keys;
 *   2. per object: check the ledger first; a key already committed or
 *      quarantined whose listing shows the same object the ledger recorded
 *      (same size, not rewritten since) is settled as a replay without a GET.
 *      Otherwise fetch, decrypt with the in-memory key, validate with the
 *      protocol schemas, commit records + ledger row in ONE SQLite transaction,
 *      then delete the object from R2 (media originals stay, PLAN decision 11);
 *   3. advance each prefix's position over what this pass settled (see
 *      advancePositions): a record prefix only past an unbroken run of settled
 *      oids, `up/blob/` only up to just below the oldest blob still assembling.
 * Any per-object failure quarantines that object and moves on (S4). Network
 * failures leave the object in place for the next pass.
 *
 * Cadence: passes start every pollIntervalMs, measured from pass start. A pass
 * that runs longer than the interval is followed straight away by the next one;
 * passes never overlap.
 *
 * Crash safety: the ledger row is written in the commit transaction, before the
 * R2 delete. A crash between them leaves an object that the next pass finds in
 * the ledger and only deletes (PROTOCOL §8 "Rollback"). Positions are written
 * last, after the commits and the delete flush, so a crash can only make the
 * next pass list a little more than it needs to.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  decryptEnvelope, fromUtf8, makeOid, parseKey, validateRecordKind, OID_LEN,
} from "@ivy/protocol";
import type { Kind, PairingDeviceRecordT, RecordKindName } from "@ivy/protocol";
import type { Ctx } from "../context.ts";
import { KeystoreError } from "../keystore/keystore.ts";
import { dirs } from "../config.ts";
import { getSetting, setSetting } from "../db/index.ts";
import { ROLES, bucketName, type Role } from "../r2/config.ts";
import { Bucket, TooLargeError, type ObjectEntry } from "../r2/client.ts";
import { sha256Hex, writeFileAtomic } from "../util/fsx.ts";
import { msOf, nowIso } from "../util/time.ts";
import {
  commitAndroidNotification, commitCall, commitCommandStatus, commitDeviceReport, commitFileCatalog, commitFileMeta, commitLineAccount,
  commitMessageBatch, commitScreenshot, commitUsage, commitWindowsNotification, type CommitResult,
} from "./committers.ts";
import {
  archivesPayload, committedSet, finalizeBlob, getBlob, markPartCommitted, noteAwaitingManifest, openManifest, placeAndLink,
  quarantineBlob, recordManifest, writePart, blobProgress, linkManifestCommand,
} from "./blobs.ts";
import { acceptDeviceRecord, expireStalePairings, finishPairing } from "../pairing/pairing.ts";
import { deleteCommandObject, maintainCommands, sendQueued } from "../commands/commands.ts";

/** Record prefixes listed incrementally (PROTOCOL §5). */
const RECORD_PREFIXES = ["file", "fcat", "scr", "usg", "wnotif", "anotif", "call", "msg", "lineacct", "cstat", "status", "blob"];
const BLOB_PATH = "up/blob/";
// Record prefixes that sort before `up/blob/` (today only `up/anotif/`) get a listing call of their own; all the
// others sort after it and come back in the same `up/` listing that starts at the blob position.
const BEFORE_BLOB = RECORD_PREFIXES.filter((p) => `up/${p}/` < BLOB_PATH);
const AFTER_BLOB = RECORD_PREFIXES.filter((p) => `up/${p}/` > BLOB_PATH);
// Keys the `up/` listing may return in one pass (R2 pages hold 1,000). A pass ingests at most ingestBulkBudget
// file records or blob parts, and a blob costs a manifest key on top of its parts, so a backlog of one-part photos
// needs about two listed keys per unit of budget; the margin leaves room for the small records listed with them.
// The margin can stay small because any prefix the capped listing did not reach gets its own call (FOLLOW_CAP).
const LIST_MARGIN = 100;
const listCap = (budget: number) => 2 * Math.max(1, budget) + LIST_MARGIN;
// One page: the cap for the `up/anotif/` call and for a call to a prefix the capped `up/` listing did not reach.
const FOLLOW_CAP = 1000;
// While a device of the bucket's role still reports a non-empty upload queue, the blob listing also starts no later
// than this far back. A device can upload a newer small blob (an avatar) before an older large one whose manifest
// has not reached R2 yet; once the newer blob settles the position passes the older oid, and this look-back is what
// still finds it. With an empty queue nothing is in flight and the listing starts at the position itself.
const BLOB_RECENT_MS = 10 * 60_000;
const ZERO_RANDOM = new Uint8Array(10);
// A ledger replay is settled from the listing alone when R2 last wrote the object at least this long
// before the Mac ingested it. The margin covers LastModified's one-second precision and clock drift
// between R2 and the Mac; inside it the object is fetched and its hash compared (see unchangedSinceLedger).
const REWRITE_MARGIN_MS = 60_000;
const PREFETCH = 64; // objects fetched from R2 concurrently during a pass; commit stays sequential.
// Fetch latency (the per-object round-trip) is the ingest bottleneck, so a wider window drains a large
// backlog far faster — the whole up-bucket after the PC first syncs, for instance.

// Ingest records in priority order, not plain oid order, so the device heartbeat and the conversations are
// never stuck behind a big file-listing backlog (a full-PC catalogue is hundreds of thousands of records).
// The heartbeat is what keeps a device shown as alive, so it always goes first.
function recordPriority(kind: string): number {
  switch (kind) {
    case "device_report": return 0;   // heartbeat / liveness — always first
    case "command_status": return 1;  // control
    case "message_batch": case "line_account": case "call":
    case "windows_notification": case "android_notification": return 2; // conversations and account
    case "file_meta": case "file_catalog": return 4; // the large file-listing flood — last
    default: return 3;
  }
}
// Within blobs, avatars (profile pictures, tiny) land before thumbnails/screenshots, and large media last.
function blobPriority(payloadKind: string | null | undefined): number {
  return payloadKind === "avatar" ? 0 : (payloadKind === "thumbnail" || payloadKind === "screenshot") ? 1 : 2;
}
// The file listings (file_meta, file_catalog) are the only high-volume kinds; everything else (heartbeat,
// conversations, account, avatars) is small and always processed in full each pass.
const BULK_PRIORITY = 4; // recordPriority of the file listings (the only high-volume kinds)

export interface BucketPassResult {
  bucket: string;
  role: Role;
  listed: number;
  committed: number;
  quarantined: number;
  replayed: number;
  waiting: number;
  errors: number;
  marker: string | null;
  full: boolean;
  error?: string;
}

export interface PollResult {
  at: string;
  skipped?: string;
  buckets: BucketPassResult[];
  durationMs: number;
}

type Outcome = "committed" | "quarantined" | "replayed" | "waiting" | "error";

interface Source {
  bucket: Bucket | null; // null when re-processing quarantined bytes locally
  bucketName: string;
  role: Role;
}

const COMMITTERS: Partial<Record<Kind, (db: Ctx["db"], rec: never) => CommitResult>> = {
  file_meta: commitFileMeta as never,
  screenshot: commitScreenshot as never,
  usage_event: commitUsage as never,
  windows_notification: commitWindowsNotification as never,
  android_notification: commitAndroidNotification as never,
  call: commitCall as never,
  message_batch: commitMessageBatch as never,
  device_report: commitDeviceReport as never,
  command_status: commitCommandStatus as never,
  line_account: commitLineAccount as never,
  file_catalog: commitFileCatalog as never,
};

/** Kinds a device may send in each role's bucket. Android kinds are accepted from Android only, and so on. */
const ALLOWED: Record<Role, Set<string>> = {
  // message_batch from Windows: Telegram Desktop session, LINE for Windows store (PRD WT1-WT4, WL1-WL3)
  windows: new Set(["file_meta", "file_catalog", "screenshot", "usage_event", "windows_notification", "message_batch", "line_account", "device_report", "command_status"]),
  android: new Set(["file_meta", "file_catalog", "screenshot", "usage_event", "android_notification", "call", "message_batch", "device_report", "command_status"]),
};

export class Ingester {
  private readonly ctx: Ctx;
  private running: Promise<PollResult> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private timerGen = 0;
  // per bucket: listed key -> "size|LastModified" of the copy this process committed or replayed. Lets a
  // re-listed object be recognised as the very copy already read, with no GET. Pruned to the current
  // listing at the end of every bucket pass, so it never outgrows one listing.
  private readonly seen = new Map<string, Map<string, string>>();
  private lastFull = new Map<string, number>();
  // buckets whose next pass lists in full because a device came back (see noteDeviceReport)
  private readonly fullNext = new Set<string>();
  // devices that came back with a queue still draining: one more full listing once a report shows it empty
  private readonly draining = new Set<string>();
  private stopped = false;
  private pausedUntil: number | null = null;
  last: PollResult | null = null;

  constructor(ctx: Ctx) { this.ctx = ctx; }

  /** Single flight: concurrent callers share one pass. */
  poll(opts: { full?: boolean } = {}): Promise<PollResult> {
    this.running ??= this.pass(opts).finally(() => { this.running = null; });
    return this.running;
  }

  isRunning(): boolean { return this.running !== null; }

  /** Ingest is allowed to run (not stopped); a pass also needs the key in memory. */
  isActive(): boolean { return !this.stopped; }

  /**
   * The next pass lists every bucket in full (no marker window). Called when the
   * key comes back after a full lock; a fresh service already starts this way.
   * There is no lifecycle expiry on the up-buckets (PLAN decision 6), so objects
   * older than the marker window can be waiting after a long absence.
   */
  requestFull(): void { this.lastFull.clear(); }

  /**
   * Pause ingest without locking: the key stays in memory, nothing is read from or
   * deleted in the up-buckets until resume() or `ms` elapse (a safety net, so a
   * caller that goes away cannot leave ingest off). Gate G1 (d) holds the PC's
   * queue in R2 this way while the bucket audit (c) runs.
   */
  pause(ms: number): string {
    this.pausedUntil = Date.now() + ms;
    const until = new Date(this.pausedUntil).toISOString();
    this.ctx.events.emit("ingest.paused", { until });
    return until;
  }

  /** Resolves when no pass is in flight. */
  async settle(): Promise<void> { await this.running?.catch(() => undefined); }

  resume(): void {
    if (this.pausedUntil === null) return;
    this.pausedUntil = null;
    this.requestFull(); // the pause may have outlasted the marker window
    this.ctx.events.emit("ingest.resumed", {});
  }

  /** ISO time the pause ends, or null when not paused. */
  pausedTill(): string | null {
    if (this.pausedUntil !== null && Date.now() >= this.pausedUntil) this.resume();
    return this.pausedUntil === null ? null : new Date(this.pausedUntil).toISOString();
  }

  /**
   * Poll on a fixed cadence measured from each pass's start: a pass that ends early waits out the rest of
   * the interval; one that overruns is followed by the next pass as soon as it ends (the ticks it ran
   * through are skipped, never queued, and passes never overlap). The first pass runs after 1 s.
   */
  start(): void {
    this.stopped = false;
    if (this.timer) clearTimeout(this.timer);
    const gen = ++this.timerGen; // a pass still running from an earlier start() must not re-arm its chain
    const every = this.ctx.config.pollIntervalMs;
    if (every <= 0) return;
    const arm = (delay: number) => {
      if (this.stopped || gen !== this.timerGen) return;
      this.timer = setTimeout(tick, Math.max(0, delay));
      this.timer.unref?.();
    };
    const tick = async () => {
      const startedAt = Date.now();
      try { if (this.ctx.keystore.isUnlocked()) await this.poll(); }
      catch (e) { this.ctx.events.emit("ingest.error", { error: (e as Error).message }); }
      arm(startedAt + every - Date.now());
    };
    arm(1_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timerGen++;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }

  private async pass(opts: { full?: boolean }): Promise<PollResult> {
    const t0 = Date.now();
    const at = nowIso();
    if (!this.ctx.keystore.isUnlocked()) return { at, skipped: "locked", buckets: [], durationMs: 0 };
    if (this.pausedTill()) return { at, skipped: "paused", buckets: [], durationMs: 0 };
    const r2 = this.ctx.r2();
    if (!r2) return { at, skipped: "r2 not configured", buckets: [], durationMs: 0 };

    await expireStalePairings(this.ctx).catch(() => 0);
    await sendQueued(this.ctx).catch(() => 0);

    const results: BucketPassResult[] = [];
    for (const role of ROLES) {
      const up = r2.bucket("up", role);
      if (!up) continue;
      const name = bucketName(r2.config, "up", role);
      // full listing: on demand, on the first pass after start / unlock (lastFull empty), hourly, and
      // whenever the last successful poll is older than the marker window (the Mac was away)
      const lastOkMs = msOf(this.lastOk(name));
      // a device that came back asks for one full listing; taken here, so a report seen during this pass asks
      // for the pass after it
      const deviceBack = this.fullNext.delete(name);
      const full = !!opts.full || deviceBack
        || Date.now() - (this.lastFull.get(name) ?? 0) >= this.ctx.config.fullSweepEveryMs
        || lastOkMs === null || Date.now() - lastOkMs > this.ctx.config.listLookbackMs;
      const res = await this.pollBucket({ bucket: up, bucketName: name, role }, full);
      if (full && !res.error) this.lastFull.set(name, Date.now());
      if (deviceBack && res.error) this.fullNext.add(name);
      results.push(res);
      setSetting(this.ctx.db, `poll:${name}`, JSON.stringify({
        at, ok: !res.error, error: res.error ?? null, lastOkAt: res.error ? this.lastOk(name) : at,
        committed: res.committed, quarantined: res.quarantined, listed: res.listed, waiting: res.waiting,
      }));
    }
    await maintainCommands(this.ctx).catch(() => undefined);
    const out: PollResult = { at, buckets: results, durationMs: Date.now() - t0 };
    this.last = out;
    this.ctx.events.emit("ingest.poll", {
      buckets: results.map((b) => ({ bucket: b.bucket, committed: b.committed, quarantined: b.quarantined, waiting: b.waiting, error: b.error ?? null })),
      durationMs: out.durationMs,
    });
    if (results.some((b) => b.committed || b.quarantined)) this.ctx.events.emit("coverage.changed", {});
    return out;
  }

  private lastOk(bucket: string): string | null {
    const raw = getSetting(this.ctx.db, `poll:${bucket}`);
    return raw ? (JSON.parse(raw) as { lastOkAt: string | null }).lastOkAt : null;
  }

  /** The bucket's highest listing position (the newest oid any prefix has settled), or null. */
  marker(bucket: string): string | null {
    return highest(this.positions(bucket));
  }

  /**
   * Listing positions per record prefix: settings `pos:<bucket>:<prefix>`, each an oid. An install from before
   * per-prefix positions has only `marker:<bucket>` (the highest oid committed in any prefix); the first read
   * copies it to every prefix. The first pass after a start lists in full anyway, and an unsettled blob below
   * the copied position pulls the blob position back down (advancePositions).
   */
  private positions(bucket: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const p of RECORD_PREFIXES) {
      const v = getSetting(this.ctx.db, `pos:${bucket}:${p}`);
      if (v) m.set(p, v);
    }
    if (m.size === 0) {
      const old = getSetting(this.ctx.db, `marker:${bucket}`);
      if (old && validOid(old)) {
        for (const p of RECORD_PREFIXES) { setSetting(this.ctx.db, `pos:${bucket}:${p}`, old); m.set(p, old); }
      }
    }
    return m;
  }

  // ------------------------------------------------------------------ listing

  /**
   * What to ingest this pass. R2 bills each ListObjectsV2 page as a Class A operation and the poll runs every
   * 5 s, so the incremental listing must not grow with the archive. Media originals stay under `up/blob/` for
   * good (PLAN decision 11); every other prefix is deleted after commit and is near empty when idle. So:
   *
   *   - one call per record prefix that sorts before `up/blob/` (only `up/anotif/`), from its position minus
   *     listLookbackMs (cheap: those objects are deleted after commit);
   *   - one `up/` call starting just after the blob position, capped at listCap keys. It returns the blobs
   *     after the position, then every prefix that sorts after `up/blob/` (call, cstat, fcat, file, lineacct,
   *     msg, scr, status, usg, wnotif). Keys of those prefixes at or below (position - listLookbackMs) are
   *     dropped, as before;
   *   - only when that call hit its cap: one capped call per record prefix that sorts after its last key, so
   *     a flood of file listings or media never hides a status report or a message;
   *   - `pair/` while a pairing for this role is open.
   *
   * Idle that is two calls per bucket. A flood adds a handful of small calls and never pages the whole backlog.
   * Keys under `up/` with an unknown prefix are left to the full listing. `blobCut` is the oid of the last blob
   * the capped `up/` call returned when it stopped inside `up/blob/`; that blob may be only partly listed.
   */
  private async listBucket(src: Source, full: boolean, pos: Map<string, string>): Promise<{ listing: ObjectEntry[]; blobCut: string | null }> {
    const b = src.bucket!;
    if (full) return { listing: await b.list(), blobCut: null };
    const out: ObjectEntry[] = [];
    if (this.pairingOpen(src.role)) out.push(...(await b.list("pair/")));
    // start of a record prefix's listing: (position - lookback), as an oid with a zero random part
    const lookbackKey = (p: string): string | undefined => {
      const ms = oidTime(pos.get(p) ?? "");
      return ms === null ? undefined : `up/${p}/${makeOid(Math.max(0, ms - this.ctx.config.listLookbackMs), ZERO_RANDOM)}`;
    };
    for (const p of BEFORE_BLOB) out.push(...(await b.list(`up/${p}/`, lookbackKey(p), FOLLOW_CAP)));

    const cap = listCap(this.ctx.config.ingestBulkBudget);
    const main = await b.list("up/", this.blobStartAfter(src, pos.get("blob")), cap);
    for (const o of main) {
      const p = prefixOf(o.key);
      if (!p) continue;
      if (p !== "blob") { const lk = lookbackKey(p); if (lk && o.key <= lk) continue; }
      out.push(o);
    }
    let blobCut: string | null = null;
    const last = main.length >= cap ? main[main.length - 1]!.key : null;
    if (last) {
      if (last.startsWith(BLOB_PATH)) blobCut = last.slice(BLOB_PATH.length).split("/")[0] ?? null;
      for (const p of AFTER_BLOB) {
        if (`up/${p}/` > last) out.push(...(await b.list(`up/${p}/`, lookbackKey(p), FOLLOW_CAP)));
      }
    }
    return { listing: out, blobCut };
  }

  /**
   * StartAfter for the `up/` listing. Every key under a blob's folder is `manifest` or `p/<index>`, both below
   * "~", so `up/blob/<position>/~` skips the blob at the position and everything before it. With no position
   * yet the listing starts at `up/blob/`. While a device of this role reports a non-empty upload queue, the
   * start is moved back to at most BLOB_RECENT_MS ago.
   */
  private blobStartAfter(src: Source, blobPos: string | undefined): string {
    if (!blobPos) return BLOB_PATH;
    const at = `${BLOB_PATH}${blobPos}/~`;
    const queued = this.ctx.db.prepare("SELECT 1 FROM devices WHERE role = ? AND queue_depth_total > 0 LIMIT 1").get(src.role);
    if (!queued) return at;
    const recent = `${BLOB_PATH}${makeOid(Math.max(0, Date.now() - BLOB_RECENT_MS), ZERO_RANDOM)}`;
    return recent < at ? recent : at;
  }

  /**
   * A pairing for `role` is pending, or was created or consumed within its lifetime
   * plus grace (so a second or late device answer is still seen and refused promptly).
   * Anything else under `pair/` is picked up by the hourly full listing.
   */
  private pairingOpen(role: Role): boolean {
    const since = new Date(Date.now() - this.ctx.config.pairingTtlMs - this.ctx.config.pairingGraceMs).toISOString();
    return !!this.ctx.db.prepare("SELECT 1 FROM pairings WHERE role = ? AND (status = 'pending' OR created_at >= ? OR consumed_at >= ?) LIMIT 1").get(role, since, since);
  }

  private async pollBucket(src: Source, full: boolean): Promise<BucketPassResult> {
    const pos = this.positions(src.bucketName);
    const res: BucketPassResult = {
      bucket: src.bucketName, role: src.role, listed: 0, committed: 0, quarantined: 0, replayed: 0, waiting: 0, errors: 0,
      marker: highest(pos), full,
    };
    let listing: ObjectEntry[];
    let blobCut: string | null;
    try { ({ listing, blobCut } = await this.listBucket(src, full, pos)); }
    catch (e) { res.error = `list failed: ${(e as Error).message || (e as Error).name}`; return res; }
    res.listed = listing.length;

    const pairs: ObjectEntry[] = [];
    const singles: Array<ObjectEntry & { kind: Kind; oid: string }> = [];
    const blobs = new Map<string, { manifest?: ObjectEntry; parts: Array<ObjectEntry & { index: number }> }>();
    const invalid: ObjectEntry[] = [];
    for (const o of listing) {
      let pk;
      try { pk = parseKey(o.key); } catch { invalid.push(o); continue; }
      if (pk.area === "pair" && pk.kind === "pairing_device") pairs.push(o);
      else if (pk.area === "up" && pk.kind === "manifest" && pk.oid && validOid(pk.oid)) {
        const g = blobs.get(pk.oid) ?? { parts: [] }; g.manifest = o; blobs.set(pk.oid, g);
      } else if (pk.area === "up" && pk.kind === "blob_chunk" && pk.oid && validOid(pk.oid) && Number.isInteger(pk.chunkIndex) && /\/p\/\d{8}$/.test(o.key)) {
        const g = blobs.get(pk.oid) ?? { parts: [] }; g.parts.push({ ...o, index: pk.chunkIndex! }); blobs.set(pk.oid, g);
      } else if (pk.area === "up" && pk.kind && pk.oid && validOid(pk.oid)) singles.push({ ...o, kind: pk.kind, oid: pk.oid });
      else invalid.push(o);
    }

    const tally = (o: Outcome) => {
      if (o === "committed") res.committed++;
      else if (o === "quarantined") res.quarantined++;
      else if (o === "replayed") res.replayed++;
      else if (o === "waiting") res.waiting++;
      else res.errors++;
    };
    const seen = this.seenFor(src.bucketName);
    const note = (o: ObjectEntry, out: Outcome) => { if (out === "committed" || out === "replayed") seen.set(o.key, stampOf(o)); };
    const singleOutcome = new Map<string, Outcome>(); // per single record key processed this pass, for its prefix position

    for (const o of invalid) tally(await this.quarantine(src, o.key, "unknown", "unrecognised object key", await this.fetchQuiet(src, o.key)));
    for (const o of pairs) {
      const out = await this.guard(src, o.key, "pairing_device", () => this.ingestPairing(src, o));
      tally(out); note(o, out);
    }
    // Process the small high-priority records first and in full (heartbeat, control, conversations, account),
    // then the file listings up to a per-pass budget. Fetching a window concurrently is the catch-up
    // bottleneck; commits stay in order so the ledger is sequential. A bounded pass returns promptly, so the
    // next poll re-lists and catches new arrivals (the next heartbeat, new messages, avatars) even while a
    // large backlog is still draining this many per pass in the background. A re-listed already-committed
    // object is a delete that had not flushed; it is handled as a replay and does not count against the budget.
    const byOid = (a: { oid: string }, b: { oid: string }) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0);
    const prioritySingles = singles.filter((o) => recordPriority(o.kind) < BULK_PRIORITY)
      .sort((a, b) => recordPriority(a.kind) - recordPriority(b.kind) || byOid(a, b));
    const bulkSingles = singles.filter((o) => recordPriority(o.kind) >= BULK_PRIORITY).sort(byOid);

    const runWindow = async (window: typeof singles): Promise<number> => {
      // a key the ledger already settles (a replay) is not prefetched: it costs no GET
      const fetched = await Promise.all(window.map((o) => (this.settledByLedger(src, o)
        ? Promise.resolve({ o, bytes: undefined })
        : this.prefetch(src, o.key).then((bytes) => ({ o, bytes })))));
      let committed = 0;
      for (const { o, bytes } of fetched) {
        const out = await this.guard(src, o.key, o.kind, () => this.ingestSingle(src, o.key, o.kind, bytes, false, o));
        tally(out); note(o, out); singleOutcome.set(o.key, out);
        if (out === "committed") committed++;
      }
      await this.flushDeletes(src.bucketName);
      return committed;
    };

    for (let i = 0; i < prioritySingles.length; i += PREFETCH) await runWindow(prioritySingles.slice(i, i + PREFETCH));
    let budget = this.ctx.config.ingestBulkBudget;
    for (let i = 0; i < bulkSingles.length && budget > 0; i += PREFETCH) {
      budget -= await runWindow(bulkSingles.slice(i, i + PREFETCH));
    }
    // a completed media original is kept in R2 (PLAN decision 6): its manifest and parts are committed in the
    // ledger and recognised here by oid before any fetch, so they are never re-assembled or deleted later.
    const blobEntries = [...blobs.entries()].filter(([oid, g]) => {
      void g;
      const known = getBlob(this.ctx, src.bucketName, oid);
      return !(known && known.status === "complete" && archivesPayload(this.ctx, known.payload_kind));
    });
    // Phase 1: ingest every manifest first (they are tiny), which records each blob's payload kind so the
    // chunks can then be fetched avatars-first. A blob whose parts arrived before its manifest waits as before.
    for (const [oid, g] of blobEntries) {
      if (!g.manifest) continue;
      const out = await this.guard(src, g.manifest.key, "manifest", () => this.ingestManifest(src, oid, g.manifest!.key, g.parts, undefined, false, g.manifest));
      tally(out); note(g.manifest, out);
    }
    await this.flushDeletes(src.bucketName);
    // Phase 2: fetch the chunks, avatars before thumbnails before large media, so pictures land first.
    blobEntries.sort(([a], [b]) =>
      blobPriority(getBlob(this.ctx, src.bucketName, a)?.payload_kind) - blobPriority(getBlob(this.ctx, src.bucketName, b)?.payload_kind)
      || (a < b ? -1 : a > b ? 1 : 0));
    for (const [oid, g] of blobEntries) {
      const mrow = getBlob(this.ctx, src.bucketName, oid);
      if (mrow?.status === "quarantined") continue; // the manifest was quarantined with its parts
      const isBulkBlob = blobPriority(mrow?.payload_kind) > 0; // avatars (0) always; thumbnails and media share the budget
      if (isBulkBlob && budget <= 0) break; // avatars done; the rest of the media continues next pass
      if (isBulkBlob) budget -= g.parts.length;
      // a blob with no manifest yet still runs its parts: ingestPart leaves them waiting, or quarantines orphans
      g.parts.sort((a, b) => a.index - b.index);
      for (let i = 0; i < g.parts.length; i += PREFETCH) {
        const window = g.parts.slice(i, i + PREFETCH);
        // only parts ingestPart will actually read are prefetched; waiting, replayed and already-committed
        // parts cost no GET (ingestPart still fetches on its own if the blob's state changed meanwhile)
        const fetched = await Promise.all(window.map((p) => (this.partNeedsBytes(src, oid, p)
          ? this.prefetch(src, p.key).then((bytes) => ({ p, bytes }))
          : Promise.resolve({ p, bytes: undefined }))));
        for (const { p, bytes } of fetched) {
          const out = await this.guard(src, p.key, "blob_chunk", () => this.ingestPart(src, oid, p.key, p.index, bytes));
          tally(out); note(p, out);
        }
        await this.flushDeletes(src.bucketName);
      }
    }
    // finish blobs whose last part was committed just before a crash
    for (const row of this.ctx.db.prepare("SELECT oid FROM blobs WHERE bucket = ? AND status = 'assembling'").all(src.bucketName) as Array<{ oid: string }>) {
      const b = getBlob(this.ctx, src.bucketName, row.oid)!;
      if (committedSet(b).size === b.total_chunks) await this.finalize(src, row.oid);
    }

    await this.flushDeletes(src.bucketName); // blob parts and any stragglers committed since the last window flush

    // keep only keys still listed: the rest were deleted or fell out of the listing window
    const listed = new Set(listing.map((o) => o.key));
    for (const k of seen.keys()) if (!listed.has(k)) seen.delete(k);

    // positions last: after the commits and the delete flush above (crash safety)
    this.advancePositions(src, pos, singles, singleOutcome, [...blobs.keys()], blobCut);
    res.marker = highest(pos);
    // kept for the coverage view, which shows it per bucket
    if (res.marker && res.marker !== getSetting(this.ctx.db, `marker:${src.bucketName}`)) setSetting(this.ctx.db, `marker:${src.bucketName}`, res.marker);
    return res;
  }

  /**
   * Move each prefix's listing position over what this pass settled, and write the ones that changed.
   *
   * A record prefix moves past an unbroken run of its listed oids, oldest first, that were committed, replayed
   * or quarantined. It stops at the first one left in R2 (a network error, or file listings beyond this pass's
   * bulk budget), so the position never passes an object that was listed but not processed.
   *
   * `up/blob/` moves only up to just below the oldest blob still unsettled: a blob listed but not finished, or
   * a `blobs` row for this bucket still assembling or awaiting its manifest. So a large upload whose parts are
   * still arriving is never skipped because a newer avatar committed first. A blob unsettled for longer than
   * one full-sweep interval (fullSweepEveryMs) no longer holds the position back: the hourly full listing sees
   * every blob whatever the position, so it keeps picking up that blob's late parts, and the orphan policy
   * (parts with no manifest quarantined after orphanPartMs) is unchanged. Complete, kept and quarantined blobs
   * are settled. The position also stays below a blob the capped listing returned only in part (`blobCut`). It
   * can move down: when a blob below it is unsettled.
   */
  private advancePositions(src: Source, pos: Map<string, string>, singles: Array<ObjectEntry & { oid: string }>,
    outcome: Map<string, Outcome>, blobOids: string[], blobCut: string | null): void {
    const set = (p: string, v: string) => {
      if (pos.get(p) === v) return;
      pos.set(p, v);
      setSetting(this.ctx.db, `pos:${src.bucketName}:${p}`, v);
    };
    const settled = (o: Outcome | undefined) => o === "committed" || o === "replayed" || o === "quarantined";

    const byPrefix = new Map<string, Array<ObjectEntry & { oid: string }>>();
    for (const o of singles) {
      const p = prefixOf(o.key);
      if (!p || p === "blob") continue;
      const a = byPrefix.get(p) ?? [];
      a.push(o);
      byPrefix.set(p, a);
    }
    for (const [p, list] of byPrefix) {
      const from = pos.get(p) ?? "";
      let to = from;
      for (const o of list.filter((x) => x.oid > from).sort((x, y) => (x.oid < y.oid ? -1 : 1))) {
        if (!settled(outcome.get(o.key))) break;
        to = o.oid;
      }
      if (to) set(p, to);
    }

    const cutoff = new Date(Date.now() - this.ctx.config.fullSweepEveryMs).toISOString();
    const pinned = (row: { status: string; first_seen_at: string } | undefined) =>
      !row || ((row.status === "assembling" || row.status === "awaiting_manifest") && row.first_seen_at >= cutoff);
    let lowest = (this.ctx.db.prepare(`SELECT MIN(oid) AS oid FROM blobs
                                        WHERE bucket = ? AND status IN ('assembling', 'awaiting_manifest') AND first_seen_at >= ?`)
      .get(src.bucketName, cutoff) as { oid: string | null }).oid;
    for (const oid of blobOids) {
      if ((!lowest || oid < lowest) && pinned(getBlob(this.ctx, src.bucketName, oid))) lowest = oid;
    }
    const old = pos.get("blob") ?? "";
    // how far this pass saw: to the end of up/blob/, or to just below a blob the capped listing cut through
    let to = blobCut ? (validOid(blobCut) ? oidBefore(blobCut) ?? old : old) : [old, ...blobOids].reduce((a, b) => (b > a ? b : a), "");
    if (to < old) to = old;
    if (lowest) { const below = oidBefore(lowest); if (below !== null && below < to) to = below; }
    if (to) set("blob", to);
  }

  /** Never let one object stall the pass: unexpected errors become quarantine; network errors wait. */
  private async guard(src: Source, key: string, kind: string, fn: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await fn();
    } catch (e) {
      // locked mid-pass, or the network failed: leave the object for the next pass, never quarantine for that
      if (e instanceof KeystoreError || isNetworkError(e)) {
        this.ctx.events.emit("ingest.error", { bucket: src.bucketName, key, error: (e as Error).message || (e as Error).name });
        return "error";
      }
      return this.quarantine(src, key, kind, `processing failed: ${(e as Error).message}`, await this.fetchQuiet(src, key));
    }
  }

  private seenFor(bucket: string): Map<string, string> {
    let m = this.seen.get(bucket);
    if (!m) { m = new Map(); this.seen.set(bucket, m); }
    return m;
  }

  /**
   * True when a listed key is already in the ledger and the listing shows the same object the ledger
   * recorded, so the replay can be decided without downloading it. The bytes are only needed to tell a
   * harmless replay from an overwrite (different bytes under a settled key, which is quarantined): that
   * needs the content hash, so an object that may have been rewritten since it was ingested is fetched.
   * "Same object" means: same size as recorded, and either this process already read exactly this copy
   * (same size and LastModified) or R2 last wrote it well before the Mac ingested it.
   */
  private unchangedSinceLedger(src: Source, o: ObjectEntry, prior: LedgerRow): boolean {
    if (prior.status !== "committed" && prior.status !== "quarantined") return false;
    if (!prior.ct_sha256) return true; // nothing to compare against: handleKnown replays whatever the bytes
    if (prior.size !== null && o.size !== prior.size) return false;
    if (!o.lastModified) return false; // no way to tell a re-upload from the copy already read
    if (this.seen.get(src.bucketName)?.get(o.key) === stampOf(o)) return true;
    const written = Date.parse(o.lastModified);
    const ingested = Date.parse(prior.ingested_at);
    return Number.isFinite(written) && Number.isFinite(ingested) && written + REWRITE_MARGIN_MS < ingested;
  }

  private settledByLedger(src: Source, o: ObjectEntry): boolean {
    const prior = this.ledger(src.bucketName, o.key);
    return !!prior && this.unchangedSinceLedger(src, o, prior);
  }

  /** Whether ingestPart will read this part's bytes (mirrors its early returns), so the window prefetches it. */
  private partNeedsBytes(src: Source, oid: string, p: ObjectEntry & { index: number }): boolean {
    const row = getBlob(this.ctx, src.bucketName, oid);
    if (!row || row.status === "awaiting_manifest" || row.status === "quarantined" || row.status === "complete") return false;
    if (committedSet(row).has(p.index)) return false;
    return !this.settledByLedger(src, p);
  }

  private async fetchQuiet(src: Source, key: string): Promise<Uint8Array | null> {
    if (!src.bucket) return null;
    try { return await src.bucket.get(key, this.ctx.config.maxQuarantineBytes); } catch { return null; }
  }

  private async fetch(src: Source, key: string): Promise<Uint8Array | null | "too_large"> {
    try { return await src.bucket!.get(key, this.ctx.config.maxPartBytes); }
    catch (e) { if (e instanceof TooLargeError) return "too_large"; throw e; }
  }

  // Fetch bytes for one object, returning undefined on any problem so the committer falls back to its own
  // fetch (which handles too-large and missing correctly). Used to prefetch a window concurrently.
  private async prefetch(src: Source, key: string): Promise<Uint8Array | undefined> {
    try { const b = await this.fetch(src, key); return b instanceof Uint8Array ? b : undefined; }
    catch { return undefined; }
  }

  // committed/quarantined objects are deleted from R2 in batches, not one round-trip each: a single
  // DeleteObjects call removes up to 1000, which is what lets a large first sync drain fast instead of
  // being gated by one delete latency per object. A deferred delete is safe — the ledger marks the object
  // committed, so if the process stops before the batch flush the next pass recognises and removes it.
  private readonly pendingDeletes = new Map<string, { src: Source; keys: string[] }>();

  private async remove(src: Source, key: string): Promise<void> {
    if (!src.bucket) return;
    const e = this.pendingDeletes.get(src.bucketName);
    if (e) e.keys.push(key);
    else this.pendingDeletes.set(src.bucketName, { src, keys: [key] });
  }

  /** Flush buffered deletes for a bucket (or all) in batched DeleteObjects calls. */
  private async flushDeletes(bucketName?: string): Promise<void> {
    const entries = bucketName
      ? (this.pendingDeletes.has(bucketName) ? [[bucketName, this.pendingDeletes.get(bucketName)!] as const] : [])
      : [...this.pendingDeletes.entries()];
    for (const [name, { src, keys }] of entries) {
      this.pendingDeletes.delete(name);
      if (!src.bucket || keys.length === 0) continue;
      try {
        const failed = await src.bucket.deleteMany(keys);
        if (failed.length) this.ctx.events.emit("ingest.error", { bucket: name, error: `delete of ${failed.length} object(s) failed (retried next pass)` });
      } catch (e) {
        this.ctx.events.emit("ingest.error", { bucket: name, error: `batch delete failed (retried next pass): ${(e as Error).message}` });
      }
    }
  }

  private ledger(bucket: string, key: string): LedgerRow | undefined {
    return this.ctx.db.prepare("SELECT id, status, ct_sha256, kind, size, ingested_at FROM sync_objects WHERE bucket = ? AND object_key = ?").get(bucket, key) as
      LedgerRow | undefined;
  }

  private insertLedger(bucket: string, key: string, kind: string, status: "committed" | "quarantined", bytes: Uint8Array | null, deviceId: string | null, detail: string | null) {
    this.ctx.db.prepare(`INSERT INTO sync_objects(id, device_id, bucket, object_key, kind, status, ingested_at, size, ct_sha256, detail)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(bucket, object_key) DO UPDATE SET status = excluded.status, ingested_at = excluded.ingested_at,
                           device_id = excluded.device_id, detail = excluded.detail, ct_sha256 = excluded.ct_sha256, size = excluded.size
                         WHERE sync_objects.status != 'committed'`)
      .run(randomUUID(), deviceId, bucket, key, kind, status, nowIso(), bytes?.length ?? null, bytes ? sha256Hex(bytes) : null, detail);
  }

  /**
   * An object whose key is already in the ledger: the same bytes are a harmless
   * replay (crash before delete, or a re-upload) and are only deleted; different
   * bytes under a committed key are an overwrite and are quarantined.
   */
  private async handleKnown(src: Source, key: string, kind: string, bytes: Uint8Array, prior: { status: string; ct_sha256: string | null }, keep = false): Promise<Outcome> {
    if (!prior.ct_sha256 || prior.ct_sha256 === sha256Hex(bytes)) return this.replay(src, key, prior, keep);
    const why = prior.status === "committed" ? "key already committed with different content (overwrite)" : "key was quarantined before and was uploaded again with different content";
    return this.quarantine(src, key, kind, why, bytes, null, true);
  }

  /**
   * Same object as the ledger recorded: a crash before the delete, a failed delete, or a straight re-upload.
   * `keep` is set for a media original we persist in R2: recognise the replay but do not delete it.
   */
  private async replay(src: Source, key: string, prior: { status: string }, keep: boolean): Promise<Outcome> {
    if (!keep) await this.remove(src, key);
    this.ctx.events.emit("ingest.replayed", { bucket: src.bucketName, key, ledgerStatus: prior.status, kept: keep });
    return "replayed";
  }

  async quarantine(src: Source, key: string, kind: string, reason: string, bytes: Uint8Array | null, deviceId: string | null = null, keepLedger = false): Promise<Outcome> {
    const id = randomUUID();
    let stored: string | null = null;
    if (bytes && bytes.length <= this.ctx.config.maxQuarantineBytes) {
      stored = join(dirs(this.ctx.config).quarantine, `${id}.bin`); // still ciphertext
      writeFileAtomic(stored, bytes);
    }
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare(`INSERT INTO quarantine(id, bucket, role, object_key, kind, device_id, reason, size, ct_sha256, stored_path, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, src.bucketName, src.role, key, kind, deviceId, reason, bytes?.length ?? null, bytes ? sha256Hex(bytes) : null, stored, nowIso());
      if (!keepLedger) this.insertLedger(src.bucketName, key, kind, "quarantined", bytes, deviceId, reason);
    })();
    await this.remove(src, key); // quarantined objects always leave the bucket: the queue never stalls on them
    this.ctx.events.emit("ingest.quarantined", { bucket: src.bucketName, key, kind, reason, quarantineId: id });
    return "quarantined";
  }

  private decrypt(key: string, kind: Kind, bytes: Uint8Array): { record: unknown } | { error: string } {
    const sk = this.ctx.keystore.secretKey(); // throws when locked: handled by guard(), not a quarantine
    let pt: Uint8Array;
    try { pt = decryptEnvelope({ recipientSecretKey: sk, objectKey: key, envelope: bytes, expectedKind: kind }).plaintext; }
    catch (e) { return { error: `undecryptable: ${(e as Error).message}` }; }
    let json: unknown;
    try { json = JSON.parse(fromUtf8(pt)); } catch { return { error: "plaintext is not JSON" }; }
    try { return { record: validateRecordKind(kind as RecordKindName, json) }; }
    catch (e) { return { error: `schema invalid: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 300)}` }; }
  }

  // ------------------------------------------------------------------ pairing

  private async ingestPairing(src: Source, o: ObjectEntry, bytesIn?: Uint8Array): Promise<Outcome> {
    if (!bytesIn) {
      const known = this.ledger(src.bucketName, o.key);
      if (known && this.unchangedSinceLedger(src, o, known)) return this.replay(src, o.key, known, false);
    }
    const got = bytesIn ?? (await this.fetch(src, o.key));
    if (got === null) return "waiting";
    if (got === "too_large") return this.quarantine(src, o.key, "pairing_device", "object too large", null);
    const bytes = got;
    const prior = this.ledger(src.bucketName, o.key);
    if (prior && !bytesIn) return this.handleKnown(src, o.key, "pairing_device", bytes, prior);
    const d = this.decrypt(o.key, "pairing_device", bytes);
    if ("error" in d) return this.quarantine(src, o.key, "pairing_device", d.error, bytes);
    const rec = d.record as PairingDeviceRecordT;
    const keyPairingId = o.key.split("/")[1]!;
    let accepted: ReturnType<typeof acceptDeviceRecord> | undefined;
    this.ctx.db.transaction(() => {
      accepted = acceptDeviceRecord(this.ctx, rec, { keyPairingId, bucketRole: src.role, writtenAt: o.lastModified });
      if (accepted.ok) this.insertLedger(src.bucketName, o.key, "pairing_device", "committed", bytes, rec.deviceId, `fingerprint ${accepted.fingerprint}`);
    })();
    if (!accepted!.ok) {
      this.ctx.events.emit("pairing.rejected", { pairingId: keyPairingId, reason: accepted!.reason });
      return this.quarantine(src, o.key, "pairing_device", `pairing refused: ${accepted!.reason}`, bytes, rec.deviceId);
    }
    await this.remove(src, o.key);
    await finishPairing(this.ctx, accepted!.pairingId, accepted!.role);
    this.ctx.events.emit("pairing.completed", {
      pairingId: accepted!.pairingId, deviceId: accepted!.deviceId, role: accepted!.role,
      deviceFingerprint: accepted!.fingerprint, macFingerprint: this.ctx.keystore.macFingerprint(),
    });
    return "committed";
  }

  // ------------------------------------------------------------------ single records

  private async ingestSingle(src: Source, key: string, kind: Kind, bytesIn?: Uint8Array, force = false, listed?: ObjectEntry): Promise<Outcome> {
    if (!bytesIn && !force && listed) {
      const known = this.ledger(src.bucketName, key);
      if (known && this.unchangedSinceLedger(src, listed, known)) return this.replay(src, key, known, false);
    }
    const got = bytesIn ?? (await this.fetch(src, key));
    if (got === null) return "waiting";
    if (got === "too_large") return this.quarantine(src, key, kind, "object too large for a record", null);
    const bytes = got;
    const prior = this.ledger(src.bucketName, key);
    if (prior && !force) return this.handleKnown(src, key, kind, bytes, prior);

    if (!ALLOWED[src.role].has(kind)) return this.quarantine(src, key, kind, `kind ${kind} is not accepted from a ${src.role} device`, bytes);
    const d = this.decrypt(key, kind, bytes);
    if ("error" in d) return this.quarantine(src, key, kind, d.error, bytes);
    const rec = d.record as { deviceId: string; kind: Kind };
    const dev = this.ctx.db.prepare("SELECT role, last_seen FROM devices WHERE id = ?").get(rec.deviceId) as { role: Role; last_seen: string | null } | undefined;
    if (!dev) return this.quarantine(src, key, kind, `record from unknown or revoked device ${rec.deviceId}`, bytes, rec.deviceId);
    if (dev.role !== src.role) return this.quarantine(src, key, kind, `device ${rec.deviceId} is ${dev.role} but wrote to the ${src.role} bucket`, bytes, rec.deviceId);
    if (kind === "message_batch") {
      const session = (rec as unknown as { sourceSession: string }).sourceSession;
      if (!session.startsWith(`${dev.role}:`)) return this.quarantine(src, key, kind, `sourceSession ${session} does not belong to a ${dev.role} device`, bytes, rec.deviceId);
    }

    const committer = COMMITTERS[kind];
    if (!committer) return this.quarantine(src, key, kind, `no committer for kind ${kind}`, bytes, rec.deviceId);
    let result: CommitResult | undefined;
    this.ctx.db.transaction(() => {
      result = committer(this.ctx.db, rec as never);
      this.insertLedger(src.bucketName, key, kind, "committed", bytes, rec.deviceId, null);
      this.ctx.db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(nowIso(), rec.deviceId);
    })();
    await this.remove(src, key);
    if (kind === "device_report") this.noteDeviceReport(src, rec.deviceId, dev.last_seen, (rec as unknown as { queueDepthTotal: number }).queueDepthTotal);
    for (const c of result!.deleteCommands ?? []) await deleteCommandObject(this.ctx, c.commandId);
    for (const oid of result!.blobs ?? []) placeAndLink(this.ctx, oid);
    this.ctx.events.emit(kind === "command_status" ? "command.status" : "ingest.committed", { bucket: src.bucketName, key, kind, deviceId: rec.deviceId, ...result!.summary });
    if (result!.coverageChanged) this.ctx.events.emit("coverage.changed", { deviceId: rec.deviceId });
    return "committed";
  }

  /**
   * A device that comes back after a gap may upload records from its offline queue whose oids are older than
   * the listing positions. When a device_report arrives and the Mac had committed nothing from that device for
   * longer than deviceReturnFullMs (measured on the Mac's clock, from the device's last_seen before this
   * record), the next pass lists the bucket in full. If that report still shows a queue, the first later report
   * showing it empty asks for one more full listing, for whatever drained in between.
   */
  private noteDeviceReport(src: Source, deviceId: string, lastSeen: string | null, queueDepthTotal: number): void {
    const seenMs = msOf(lastSeen);
    if (seenMs !== null && Date.now() - seenMs > this.ctx.config.deviceReturnFullMs) {
      this.fullNext.add(src.bucketName);
      if (queueDepthTotal > 0) this.draining.add(deviceId);
    } else if (queueDepthTotal === 0 && this.draining.delete(deviceId)) {
      this.fullNext.add(src.bucketName);
    }
  }

  // ------------------------------------------------------------------ blobs

  private async ingestManifest(src: Source, oid: string, key: string, listedParts: ObjectEntry[], bytesIn?: Uint8Array, force = false, listed?: ObjectEntry): Promise<Outcome> {
    if (!bytesIn && !force && listed) {
      const known = this.ledger(src.bucketName, key);
      // a media original's manifest stays in R2 while the blob assembles and after it completes
      if (known && this.unchangedSinceLedger(src, listed, known)) {
        return this.replay(src, key, known, archivesPayload(this.ctx, getBlob(this.ctx, src.bucketName, oid)?.payload_kind));
      }
    }
    const got = bytesIn ?? (await this.fetch(src, key));
    if (got === null) return "waiting";
    if (got === "too_large") return this.quarantine(src, key, "manifest", "manifest too large", null);
    const bytes = got;
    const prior = this.ledger(src.bucketName, key);
    if (prior && !force) {
      // a media original's manifest stays in R2 while the blob assembles and after it completes
      const existing = getBlob(this.ctx, src.bucketName, oid);
      return this.handleKnown(src, key, "manifest", bytes, prior, archivesPayload(this.ctx, existing?.payload_kind));
    }
    const sk = this.ctx.keystore.secretKey();
    let m;
    try { m = openManifest(sk, oid, bytes); }
    catch (e) {
      const reason = `manifest undecryptable or invalid: ${(e as Error).message.slice(0, 200)}`;
      const row = getBlob(this.ctx, src.bucketName, oid);
      if (row) quarantineBlob(this.ctx, row, reason);
      else this.ctx.db.prepare("INSERT INTO blobs(oid, bucket, role, status, first_seen_at, updated_at, detail) VALUES (?, ?, ?, 'quarantined', ?, ?, ?)").run(oid, src.bucketName, src.role, nowIso(), nowIso(), reason);
      const out = await this.quarantine(src, key, "manifest", reason, bytes);
      for (const p of listedParts) await this.quarantine(src, p.key, "blob_chunk", "its manifest was quarantined", await this.fetchQuiet(src, p.key));
      return out;
    }
    const existing = getBlob(this.ctx, src.bucketName, oid);
    if (existing && existing.status !== "awaiting_manifest") {
      return this.quarantine(src, key, "manifest", `a manifest for this blob was already recorded (${existing.status})`, bytes);
    }
    let commandId: string | null = null;
    this.ctx.db.transaction(() => {
      recordManifest(this.ctx, src.bucketName, src.role, oid, bytes, m);
      commandId = linkManifestCommand(this.ctx, src.bucketName, src.role, oid, m);
      this.insertLedger(src.bucketName, key, "manifest", "committed", bytes, null, `payloadKind=${m.payloadKind} parts=${m.totalChunks} size=${m.totalSize}${commandId ? ` command=${commandId}` : ""}`);
    })();
    // a media original is kept in R2 for on-demand full-quality fetch; everything else is deleted after commit
    if (!archivesPayload(this.ctx, m.payloadKind)) await this.remove(src, key);
    const prog = blobProgress(getBlob(this.ctx, src.bucketName, oid)!);
    this.ctx.events.emit("blob.progress", { ...prog });
    if (commandId) this.ctx.events.emit("command.transferring", { commandId, ...transferOf(prog) });
    return "committed";
  }

  private async ingestPart(src: Source, oid: string, key: string, index: number, bytesIn?: Uint8Array, force = false): Promise<Outcome> {
    let row = getBlob(this.ctx, src.bucketName, oid);
    if (!row || row.status === "awaiting_manifest") {
      row ??= noteAwaitingManifest(this.ctx, src.bucketName, src.role, oid);
      const age = Date.now() - (msOf(row.first_seen_at) ?? Date.now());
      if (age >= this.ctx.config.orphanPartMs) {
        quarantineBlob(this.ctx, row, "orphan parts: no manifest within 7 days");
        return this.quarantine(src, key, "blob_chunk", "orphan part: no manifest within 7 days", bytesIn ?? (await this.fetchQuiet(src, key)));
      }
      return "waiting"; // left in R2 until the manifest arrives
    }
    const prior = this.ledger(src.bucketName, key);
    // a media original's parts stay in R2 (PLAN decision 6), so replays of them are recognised but not deleted
    const keep = archivesPayload(this.ctx, row.payload_kind);
    if (row.status === "quarantined") {
      if (prior?.status === "quarantined" && !force) { await this.remove(src, key); return "replayed"; }
      return this.quarantine(src, key, "blob_chunk", `its blob is quarantined: ${row.detail ?? ""}`.trim(), bytesIn ?? (await this.fetchQuiet(src, key)));
    }
    if (row.status === "complete" || committedSet(row).has(index)) {
      // committed before (resume after restart, or a re-upload): finish the delete, unless it is a kept original
      if (!force && !keep) await this.remove(src, key);
      return "replayed";
    }
    const got = bytesIn ?? (await this.fetch(src, key));
    if (got === null) return "waiting";
    if (got === "too_large") {
      quarantineBlob(this.ctx, row, `part ${index} too large`);
      return this.quarantine(src, key, "blob_chunk", "part too large", null);
    }
    const bytes = got;
    if (prior && prior.status === "committed" && !force) return this.handleKnown(src, key, "blob_chunk", bytes, prior, keep);

    const w = writePart(this.ctx, row, index, bytes);
    if (w.kind === "reject") {
      quarantineBlob(this.ctx, row, w.reason);
      return this.quarantine(src, key, "blob_chunk", w.reason, bytes);
    }
    let count = 0;
    this.ctx.db.transaction(() => {
      count = markPartCommitted(this.ctx, row!, index, w.bytes);
      this.insertLedger(src.bucketName, key, "blob_chunk", "committed", bytes, null, `part ${index} of ${oid}`);
    })();
    if (!keep) await this.remove(src, key); // a kept media original's part stays in R2
    else this.ctx.events.emit("ingest.archived", { bucket: src.bucketName, oid, part: index });
    const fresh = getBlob(this.ctx, src.bucketName, oid)!;
    const prog = blobProgress(fresh);
    this.ctx.events.emit("blob.progress", { ...prog });
    if (fresh.command_id) this.ctx.events.emit("command.progress", { commandId: fresh.command_id, ...transferOf(prog) });
    if (count === fresh.total_chunks) await this.finalize(src, oid);
    return "committed";
  }

  private async finalize(src: Source, oid: string): Promise<void> {
    const r = await finalizeBlob(this.ctx, src.bucketName, oid);
    const row = getBlob(this.ctx, src.bucketName, oid)!;
    if (r.ok) this.ctx.events.emit("blob.complete", { ...blobProgress(row), sha256: row.sha256 });
    else if (row.status === "quarantined") this.ctx.events.emit("ingest.quarantined", { bucket: src.bucketName, key: `up/blob/${oid}/`, kind: "manifest", reason: row.detail });
  }

  // ------------------------------------------------------------------ quarantine retry

  /**
   * Re-run a quarantined object's stored ciphertext through the pipeline (e.g.
   * after pairing the device it came from, or a fixed bug). Nothing is fetched
   * from or deleted in R2.
   */
  async retryQuarantined(id: string): Promise<{ outcome: Outcome | "not_found" | "no_bytes" }> {
    const q = this.ctx.db.prepare("SELECT * FROM quarantine WHERE id = ? AND resolved_at IS NULL").get(id) as
      { id: string; bucket: string; role: Role; object_key: string; stored_path: string | null } | undefined;
    if (!q) return { outcome: "not_found" };
    if (!q.stored_path) return { outcome: "no_bytes" };
    const { readFileSync } = await import("node:fs");
    const bytes = new Uint8Array(readFileSync(q.stored_path));
    const src: Source = { bucket: null, bucketName: q.bucket, role: q.role };
    // let the ledger accept the key again
    this.ctx.db.prepare("DELETE FROM sync_objects WHERE bucket = ? AND object_key = ? AND status = 'quarantined'").run(q.bucket, q.object_key);
    let outcome: Outcome;
    const pk = (() => { try { return parseKey(q.object_key); } catch { return null; } })();
    if (!pk || !pk.kind) outcome = "quarantined";
    else if (pk.kind === "pairing_device") outcome = await this.ingestPairing(src, { key: q.object_key, size: bytes.length }, bytes);
    else if (pk.kind === "manifest") outcome = await this.ingestManifest(src, pk.oid!, q.object_key, [], bytes, true);
    else if (pk.kind === "blob_chunk") outcome = await this.ingestPart(src, pk.oid!, q.object_key, pk.chunkIndex!, bytes, true);
    else outcome = await this.ingestSingle(src, q.object_key, pk.kind, bytes, true);
    this.ctx.db.prepare("UPDATE quarantine SET resolved_at = ?, resolution = ? WHERE id = ?").run(nowIso(), `retried: ${outcome}`, id);
    return { outcome };
  }
}

interface LedgerRow { id: string; status: string; ct_sha256: string | null; kind: string; size: number | null; ingested_at: string }

/** What a listing says about one copy of an object; a re-upload changes LastModified. */
function stampOf(o: ObjectEntry): string {
  return `${o.size}|${o.lastModified ?? ""}`;
}

function transferOf(p: ReturnType<typeof blobProgress>) {
  return { resultOid: p.oid, committedParts: p.committedParts, totalChunks: p.totalChunks, committedBytes: p.committedBytes, totalSize: p.totalSize };
}

/** The record prefix (e.g. "msg", "blob") a key under `up/` belongs to, or undefined. */
function prefixOf(key: string): string | undefined {
  return RECORD_PREFIXES.find((p) => key.startsWith(`up/${p}/`));
}

/** The highest of a bucket's positions, or null when it has none. */
function highest(pos: Map<string, string>): string | null {
  let h: string | null = null;
  for (const v of pos.values()) if (h === null || v > h) h = v;
  return h;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The oid just below `oid` in sort order (no oid lies between them), or null for the lowest. */
function oidBefore(oid: string): string | null {
  const c = oid.split("");
  for (let i = c.length - 1; i >= 0; i--) {
    const k = CROCKFORD.indexOf(c[i]!);
    if (k > 0) { c[i] = CROCKFORD[k - 1]!; return c.join(""); }
    c[i] = CROCKFORD[CROCKFORD.length - 1]!;
  }
  return null;
}

function validOid(oid: string): boolean {
  return oid.length === OID_LEN && /^[0-9A-HJKMNP-TV-Z]+$/.test(oid);
}

/** Milliseconds encoded in an oid's first 48 bits. */
export function oidTime(oid: string): number | null {
  if (!validOid(oid)) return null;
  const ALPH = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = 0n;
  for (const ch of oid.slice(0, 10)) bits = (bits << 5n) | BigInt(ALPH.indexOf(ch)); // 50 bits
  return Number(bits >> 2n); // top 48 bits
}

function isNetworkError(e: unknown): boolean {
  const err = e as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = err?.$metadata?.httpStatusCode;
  if (status !== undefined && (status >= 500 || status === 429 || status === 403 || status === 401)) return true;
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(err?.code ?? "")
    || ["TimeoutError", "RequestTimeout", "NetworkingError", "AbortError"].includes(err?.name ?? "");
}
