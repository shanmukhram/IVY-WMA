/**
 * The ingest loop (PRD S1-S5).
 *
 * Per pass, for each configured up-bucket:
 *   1. list `up/` once, keeping per record prefix only keys after
 *      (marker - lookback), and `pair/` while a pairing is open; a full listing of
 *      the bucket runs hourly, on demand and after an absence, and catches
 *      unrecognised keys (about one ListObjectsV2 per bucket per poll);
 *   2. per object: fetch, check the ledger, decrypt with the in-memory key,
 *      validate with the protocol schemas, commit records + ledger row in ONE
 *      SQLite transaction, then delete the object from R2;
 *   3. advance the bucket's marker (highest committed oid).
 * Any per-object failure quarantines that object and moves on (S4). Network
 * failures leave the object in place for the next pass.
 *
 * Crash safety: the ledger row is written in the commit transaction, before the
 * R2 delete. A crash between them leaves an object that the next pass finds in
 * the ledger and only deletes (PROTOCOL §8 "Rollback").
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
  commitAndroidNotification, commitCall, commitCommandStatus, commitDeviceReport, commitFileMeta, commitMessageBatch,
  commitScreenshot, commitUsage, commitWindowsNotification, type CommitResult,
} from "./committers.ts";
import {
  committedSet, finalizeBlob, getBlob, markPartCommitted, noteAwaitingManifest, openManifest, placeAndLink,
  quarantineBlob, recordManifest, writePart, blobProgress, linkManifestCommand,
} from "./blobs.ts";
import { acceptDeviceRecord, expireStalePairings, finishPairing } from "../pairing/pairing.ts";
import { deleteCommandObject, maintainCommands, sendQueued } from "../commands/commands.ts";

/** Record prefixes listed incrementally (PROTOCOL §5). */
const RECORD_PREFIXES = ["file", "scr", "usg", "wnotif", "anotif", "call", "msg", "cstat", "status", "blob"];
const RECORD_PREFIX_PATHS = RECORD_PREFIXES.map((p) => `up/${p}/`);

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
};

/** Kinds a device may send in each role's bucket. Android kinds are accepted from Android only, and so on. */
const ALLOWED: Record<Role, Set<string>> = {
  windows: new Set(["file_meta", "screenshot", "usage_event", "windows_notification", "device_report", "command_status"]),
  android: new Set(["file_meta", "screenshot", "usage_event", "android_notification", "call", "message_batch", "device_report", "command_status"]),
};

export class Ingester {
  private readonly ctx: Ctx;
  private running: Promise<PollResult> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private lastFull = new Map<string, number>();
  private stopped = false;
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

  start(): void {
    this.stopped = false;
    const every = this.ctx.config.pollIntervalMs;
    if (every <= 0) return;
    const tick = async () => {
      try { if (this.ctx.keystore.isUnlocked()) await this.poll(); }
      catch (e) { this.ctx.events.emit("ingest.error", { error: (e as Error).message }); }
      if (!this.stopped) { this.timer = setTimeout(tick, every); this.timer.unref?.(); }
    };
    this.timer = setTimeout(tick, 1_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }

  private async pass(opts: { full?: boolean }): Promise<PollResult> {
    const t0 = Date.now();
    const at = nowIso();
    if (!this.ctx.keystore.isUnlocked()) return { at, skipped: "locked", buckets: [], durationMs: 0 };
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
      const full = !!opts.full
        || Date.now() - (this.lastFull.get(name) ?? 0) >= this.ctx.config.fullSweepEveryMs
        || lastOkMs === null || Date.now() - lastOkMs > this.ctx.config.listLookbackMs;
      const res = await this.pollBucket({ bucket: up, bucketName: name, role }, full);
      if (full && !res.error) this.lastFull.set(name, Date.now());
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

  marker(bucket: string): string | null {
    return getSetting(this.ctx.db, `marker:${bucket}`) ?? null;
  }

  // ------------------------------------------------------------------ listing

  /**
   * One ListObjectsV2 pass per bucket and poll (R2 bills lists as Class A operations):
   * a full listing, or a single `up/` listing with the marker window applied per
   * record prefix (oids are time-ordered within a prefix, not across prefixes), plus
   * `pair/` only while a pairing for this role is open. Keys under `up/` with an
   * unknown prefix are left to the full listing, as before.
   */
  private async listBucket(src: Source, full: boolean): Promise<ObjectEntry[]> {
    const b = src.bucket!;
    if (full) return b.list();
    const out: ObjectEntry[] = [];
    if (this.pairingOpen(src.role)) out.push(...(await b.list("pair/")));
    const marker = this.marker(src.bucketName);
    let startOid: string | undefined;
    const ms = marker ? oidTime(marker) : null;
    if (ms !== null) startOid = makeOid(Math.max(0, ms - this.ctx.config.listLookbackMs), new Uint8Array(10));
    for (const o of await b.list("up/")) {
      const p = RECORD_PREFIX_PATHS.find((x) => o.key.startsWith(x));
      if (!p) continue;
      // same rule the old per-prefix StartAfter applied: strictly after up/<prefix>/<marker - window>
      if (startOid && o.key <= p + startOid) continue;
      out.push(o);
    }
    return out;
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
    const res: BucketPassResult = {
      bucket: src.bucketName, role: src.role, listed: 0, committed: 0, quarantined: 0, replayed: 0, waiting: 0, errors: 0,
      marker: this.marker(src.bucketName), full,
    };
    let listing: ObjectEntry[];
    try { listing = await this.listBucket(src, full); }
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
    let maxOid = res.marker ?? "";
    const seeOid = (oid: string) => { if (oid > maxOid) maxOid = oid; };

    for (const o of invalid) tally(await this.quarantine(src, o.key, "unknown", "unrecognised object key", await this.fetchQuiet(src, o.key)));
    for (const o of pairs) tally(await this.guard(src, o.key, "pairing_device", () => this.ingestPairing(src, o)));
    singles.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
    for (const o of singles) {
      const out = await this.guard(src, o.key, o.kind, () => this.ingestSingle(src, o.key, o.kind));
      tally(out);
      if (out === "committed" || out === "replayed") seeOid(o.oid);
    }
    for (const [oid, g] of [...blobs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (g.manifest) {
        const out = await this.guard(src, g.manifest.key, "manifest", () => this.ingestManifest(src, oid, g.manifest!.key, g.parts));
        tally(out);
        if (out === "quarantined") continue; // its parts were quarantined with it
      }
      g.parts.sort((a, b) => a.index - b.index);
      for (const p of g.parts) {
        const out = await this.guard(src, p.key, "blob_chunk", () => this.ingestPart(src, oid, p.key, p.index));
        tally(out);
      }
      const row = getBlob(this.ctx, src.bucketName, oid);
      if (row?.status === "complete") seeOid(oid);
    }
    // finish blobs whose last part was committed just before a crash
    for (const row of this.ctx.db.prepare("SELECT oid FROM blobs WHERE bucket = ? AND status = 'assembling'").all(src.bucketName) as Array<{ oid: string }>) {
      const b = getBlob(this.ctx, src.bucketName, row.oid)!;
      if (committedSet(b).size === b.total_chunks) await this.finalize(src, row.oid);
    }

    if (maxOid && maxOid !== (res.marker ?? "")) {
      setSetting(this.ctx.db, `marker:${src.bucketName}`, maxOid);
      res.marker = maxOid;
    }
    return res;
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

  private async fetchQuiet(src: Source, key: string): Promise<Uint8Array | null> {
    if (!src.bucket) return null;
    try { return await src.bucket.get(key, this.ctx.config.maxQuarantineBytes); } catch { return null; }
  }

  private async fetch(src: Source, key: string): Promise<Uint8Array | null | "too_large"> {
    try { return await src.bucket!.get(key, this.ctx.config.maxPartBytes); }
    catch (e) { if (e instanceof TooLargeError) return "too_large"; throw e; }
  }

  private async remove(src: Source, key: string): Promise<void> {
    if (!src.bucket) return;
    try { await src.bucket.delete(key); }
    catch (e) { this.ctx.events.emit("ingest.error", { bucket: src.bucketName, key, error: `delete failed (retried next pass): ${(e as Error).message}` }); }
  }

  private ledger(bucket: string, key: string) {
    return this.ctx.db.prepare("SELECT id, status, ct_sha256, kind FROM sync_objects WHERE bucket = ? AND object_key = ?").get(bucket, key) as
      { id: string; status: string; ct_sha256: string | null; kind: string } | undefined;
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
  private async handleKnown(src: Source, key: string, kind: string, bytes: Uint8Array, prior: { status: string; ct_sha256: string | null }): Promise<Outcome> {
    if (!prior.ct_sha256 || prior.ct_sha256 === sha256Hex(bytes)) {
      // same bytes: a crash before the delete, a failed delete, or a straight re-upload
      await this.remove(src, key);
      this.ctx.events.emit("ingest.replayed", { bucket: src.bucketName, key, ledgerStatus: prior.status });
      return "replayed";
    }
    const why = prior.status === "committed" ? "key already committed with different content (overwrite)" : "key was quarantined before and was uploaded again with different content";
    return this.quarantine(src, key, kind, why, bytes, null, true);
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

  private async ingestSingle(src: Source, key: string, kind: Kind, bytesIn?: Uint8Array): Promise<Outcome> {
    const got = bytesIn ?? (await this.fetch(src, key));
    if (got === null) return "waiting";
    if (got === "too_large") return this.quarantine(src, key, kind, "object too large for a record", null);
    const bytes = got;
    const prior = this.ledger(src.bucketName, key);
    if (prior && !bytesIn) return this.handleKnown(src, key, kind, bytes, prior);

    if (!ALLOWED[src.role].has(kind)) return this.quarantine(src, key, kind, `kind ${kind} is not accepted from a ${src.role} device`, bytes);
    const d = this.decrypt(key, kind, bytes);
    if ("error" in d) return this.quarantine(src, key, kind, d.error, bytes);
    const rec = d.record as { deviceId: string; kind: Kind };
    const dev = this.ctx.db.prepare("SELECT role FROM devices WHERE id = ?").get(rec.deviceId) as { role: Role } | undefined;
    if (!dev) return this.quarantine(src, key, kind, `record from unknown or revoked device ${rec.deviceId}`, bytes, rec.deviceId);
    if (dev.role !== src.role) return this.quarantine(src, key, kind, `device ${rec.deviceId} is ${dev.role} but wrote to the ${src.role} bucket`, bytes, rec.deviceId);

    const committer = COMMITTERS[kind];
    if (!committer) return this.quarantine(src, key, kind, `no committer for kind ${kind}`, bytes, rec.deviceId);
    let result: CommitResult | undefined;
    this.ctx.db.transaction(() => {
      result = committer(this.ctx.db, rec as never);
      this.insertLedger(src.bucketName, key, kind, "committed", bytes, rec.deviceId, null);
      this.ctx.db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(nowIso(), rec.deviceId);
    })();
    await this.remove(src, key);
    for (const c of result!.deleteCommands ?? []) await deleteCommandObject(this.ctx, c.commandId);
    for (const oid of result!.blobs ?? []) placeAndLink(this.ctx, oid);
    this.ctx.events.emit(kind === "command_status" ? "command.status" : "ingest.committed", { bucket: src.bucketName, key, kind, deviceId: rec.deviceId, ...result!.summary });
    if (result!.coverageChanged) this.ctx.events.emit("coverage.changed", { deviceId: rec.deviceId });
    return "committed";
  }

  // ------------------------------------------------------------------ blobs

  private async ingestManifest(src: Source, oid: string, key: string, listedParts: ObjectEntry[], bytesIn?: Uint8Array): Promise<Outcome> {
    const got = bytesIn ?? (await this.fetch(src, key));
    if (got === null) return "waiting";
    if (got === "too_large") return this.quarantine(src, key, "manifest", "manifest too large", null);
    const bytes = got;
    const prior = this.ledger(src.bucketName, key);
    if (prior && !bytesIn) return this.handleKnown(src, key, "manifest", bytes, prior);
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
    await this.remove(src, key);
    const prog = blobProgress(getBlob(this.ctx, src.bucketName, oid)!);
    this.ctx.events.emit("blob.progress", { ...prog });
    if (commandId) this.ctx.events.emit("command.transferring", { commandId, ...transferOf(prog) });
    return "committed";
  }

  private async ingestPart(src: Source, oid: string, key: string, index: number, bytesIn?: Uint8Array): Promise<Outcome> {
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
    if (row.status === "quarantined") {
      if (prior?.status === "quarantined" && !bytesIn) { await this.remove(src, key); return "replayed"; }
      return this.quarantine(src, key, "blob_chunk", `its blob is quarantined: ${row.detail ?? ""}`.trim(), bytesIn ?? (await this.fetchQuiet(src, key)));
    }
    if (row.status === "complete" || committedSet(row).has(index)) {
      // committed before (resume after restart, or a re-upload): finish the delete
      if (!bytesIn) await this.remove(src, key);
      return "replayed";
    }
    const got = bytesIn ?? (await this.fetch(src, key));
    if (got === null) return "waiting";
    if (got === "too_large") {
      quarantineBlob(this.ctx, row, `part ${index} too large`);
      return this.quarantine(src, key, "blob_chunk", "part too large", null);
    }
    const bytes = got;
    if (prior && prior.status === "committed" && !bytesIn) return this.handleKnown(src, key, "blob_chunk", bytes, prior);

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
    await this.remove(src, key);
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
    else if (pk.kind === "manifest") outcome = await this.ingestManifest(src, pk.oid!, q.object_key, [], bytes);
    else if (pk.kind === "blob_chunk") outcome = await this.ingestPart(src, pk.oid!, q.object_key, pk.chunkIndex!, bytes);
    else outcome = await this.ingestSingle(src, q.object_key, pk.kind, bytes);
    this.ctx.db.prepare("UPDATE quarantine SET resolved_at = ?, resolution = ? WHERE id = ?").run(nowIso(), `retried: ${outcome}`, id);
    return { outcome };
  }
}

function transferOf(p: ReturnType<typeof blobProgress>) {
  return { resultOid: p.oid, committedParts: p.committedParts, totalChunks: p.totalChunks, committedBytes: p.committedBytes, totalSize: p.totalSize };
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
