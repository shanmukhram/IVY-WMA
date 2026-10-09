/**
 * The ingest loop: list the device's up-bucket, decrypt with the Mac key,
 * validate, commit to the local ledger, then delete from the bucket.
 *
 * Commit order per object: decrypt + validate -> write any plaintext output ->
 * append to ledger.json -> delete from the bucket. A crash between the ledger
 * write and the delete leaves the object in the bucket; the next pass sees it in
 * the ledger and only deletes it (idempotent, PROTOCOL §8 "Rollback").
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, win32 } from "node:path";
import {
  decryptChunkedObject, decryptEnvelope, fingerprintFromB64, fromHex, fromUtf8, parseChunkHeader, parseKey,
  pairingBootstrapKey, toCrockford, validateManifest, validateRecordKind,
} from "@ivy/protocol";
import type {
  CommandStatusRecordT, DeviceReportRecordT, FileMetaRecordT, Kind, MessageBatchRecordT, PairingDeviceRecordT,
  RecordKindName, ScreenshotRecordT,
} from "@ivy/protocol";
import type { Bucket } from "./s3.ts";
import {
  paths, readCommands, readLedger, writeCommand, writeLedger, writeState,
  type LedgerEntry, type MacIdentity, type State,
} from "./local.ts";
import { bytes, compactJson, coverageTable } from "./format.ts";

export interface IngestorOptions {
  root: string;
  state: State;
  identity: MacIdentity;
  up: Bucket;
  cmd: Bucket;
  log?: (line: string) => void;
  /** keep objects in the bucket after commit (the ledger prevents re-ingest); for audits */
  keepObjects?: boolean;
}

export interface IngestResult { committed: number; quarantined: number; rejected: number; waiting: number; replayed: number }

/** File extension (no dot, lowercase) of a device path; Windows and POSIX separators both work. */
export function extOf(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const e = win32.extname(p).replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(e) ? e : undefined;
}

const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const safeName = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);

/**
 * Receiver-side blob open (PROTOCOL §2.2, §4.1): the manifest objectId and every
 * part header's object id must be the 16 bytes of the key's oid, then the
 * protocol's per-part hash/index/AEAD verification runs.
 */
export function openBlobAtKey(secret: Uint8Array, oid: string, manifestKey: string, manifestEnvelope: Uint8Array, parts: Map<number, Uint8Array>) {
  for (const [i, part] of parts) {
    if (toCrockford(parseChunkHeader(part).objectId) !== oid) throw new Error(`part ${i} object id does not match key oid ${oid}`);
  }
  const res = decryptChunkedObject({ recipientSecretKey: secret, manifestKey, manifestEnvelope, parts });
  if (toCrockford(fromHex(res.manifest.objectId)) !== oid) throw new Error(`manifest objectId ${res.manifest.objectId} does not match key oid ${oid}`);
  return res;
}

interface BlobGroup { oid: string; manifest?: string; parts: Map<number, string>; extra: string[] }

export class Ingestor {
  readonly state: State;
  private readonly o: IngestorOptions;
  private readonly log: (line: string) => void;
  private ledger: LedgerEntry[];
  private readonly waitingNoted = new Map<string, string>();

  constructor(o: IngestorOptions) {
    this.o = o;
    this.state = o.state;
    this.log = o.log ?? ((l) => console.log(l));
    this.ledger = readLedger(o.root);
  }

  private get secret() { return this.o.identity.secretKey; }
  private saveState() { writeState(this.o.root, this.state); }

  private commit(...e: LedgerEntry[]) {
    this.ledger.push(...e);
    writeLedger(this.o.root, this.ledger);
  }

  private async remove(keys: string[]) {
    if (this.o.keepObjects) return;
    for (const k of keys) await this.o.up.delete(k);
  }

  private deviceTag(deviceId: string): string {
    return this.state.devices.some((d) => d.deviceId === deviceId) ? `device=${deviceId}` : `device=${deviceId} (NOT A PAIRED DEVICE)`;
  }

  /** Copy an object's bytes to quarantine/, record it, delete it from the bucket. Never throws on the copy. */
  private async quarantine(objects: Array<{ key: string; bytes: Uint8Array | null }>, kind: string, reason: string, status: "quarantined" | "rejected" = "quarantined") {
    const dir = paths(this.o.root).quarantine;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const { key, bytes: b } of objects) {
      const file = join(dir, `${stamp}_${safeName(key)}`);
      if (b) writeFileSync(file + ".bin", b);
      writeFileSync(file + ".json", JSON.stringify({ key, kind, reason, size: b?.length ?? null, at: new Date().toISOString() }, null, 2));
      this.commit({ key, kind, status, ingestedAt: new Date().toISOString(), size: b?.length, ctSha256: b ? sha256hex(b) : undefined, detail: reason });
      this.log(`${status.toUpperCase()} ${key} kind=${kind} size=${b ? bytes(b.length) : "?"} reason: ${reason}`);
    }
    // quarantined objects are always removed so a garbage object cannot stall the loop
    for (const { key } of objects) await this.o.up.delete(key);
  }

  async ingestOnce(): Promise<IngestResult> {
    const res: IngestResult = { committed: 0, quarantined: 0, rejected: 0, waiting: 0, replayed: 0 };
    const listing = await this.o.up.list();
    const done = new Map(this.ledger.map((e) => [e.key, e] as const));

    const invalid: string[] = [];
    const pairs: string[] = [];
    const singles: Array<{ key: string; kind: Kind }> = [];
    const blobs = new Map<string, BlobGroup>();
    for (const { key } of listing) {
      const prev = done.get(key);
      if (prev) {
        if (this.o.keepObjects) continue;
        const b = await this.o.up.get(key);
        if (!b) continue;
        if (!prev.ctSha256 || prev.ctSha256 === sha256hex(b)) {
          // same bytes as already committed (crash before delete, or a replay): just finish the delete
          await this.o.up.delete(key); res.replayed++;
          this.log(`REPLAY ${key} already in ledger (${prev.status}); deleted`);
        } else {
          await this.quarantine([{ key, bytes: b }], prev.kind, `key already ${prev.status} with different content (overwrite or replay)`, "rejected");
          res.rejected++;
        }
        continue;
      }
      let pk;
      try { pk = parseKey(key); } catch { invalid.push(key); continue; }
      if (pk.area === "pair" && pk.kind === "pairing_device") pairs.push(key);
      else if (pk.area === "up" && (pk.kind === "manifest" || pk.kind === "blob_chunk") && pk.oid) {
        const g: BlobGroup = blobs.get(pk.oid) ?? { oid: pk.oid, parts: new Map(), extra: [] };
        if (pk.blobPart === "manifest") g.manifest = key;
        else if (pk.chunkIndex !== undefined && Number.isInteger(pk.chunkIndex) && !g.parts.has(pk.chunkIndex)) g.parts.set(pk.chunkIndex, key);
        else g.extra.push(key);
        blobs.set(pk.oid, g);
      } else if (pk.area === "up" && pk.kind) singles.push({ key, kind: pk.kind });
      else invalid.push(key);
    }

    for (const key of invalid) {
      await this.quarantine([{ key, bytes: await this.o.up.get(key) }], "unknown", "unrecognised object key");
      res.quarantined++;
    }
    for (const key of pairs) this.bump(res, await this.ingestPairing(key));
    // single records before blobs, so a command_status naming a blob sets its file extension first
    for (const s of singles) this.bump(res, await this.ingestSingle(s.key, s.kind));
    for (const g of blobs.values()) this.bump(res, await this.ingestBlob(g));
    return res;
  }

  private bump(res: IngestResult, r: keyof IngestResult) { res[r]++; }

  private async open(key: string, kind: Kind): Promise<{ bytes: Uint8Array; record: unknown } | { bytes: Uint8Array | null; error: string }> {
    const b = await this.o.up.get(key);
    if (!b) return { bytes: null, error: "vanished" };
    let pt: Uint8Array;
    try { pt = decryptEnvelope({ recipientSecretKey: this.secret, objectKey: key, envelope: b, expectedKind: kind }).plaintext; }
    catch (e) { return { bytes: b, error: `undecryptable: ${(e as Error).message}` }; }
    try { return { bytes: b, record: validateRecordKind(kind as RecordKindName, JSON.parse(fromUtf8(pt))) }; }
    catch (e) { return { bytes: b, error: `schema invalid: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 300)}` }; }
  }

  private async ingestPairing(key: string): Promise<keyof IngestResult> {
    const r = await this.open(key, "pairing_device");
    if ("error" in r) {
      if (!r.bytes) return "waiting";
      await this.quarantine([{ key, bytes: r.bytes }], "pairing_device", r.error);
      return "quarantined";
    }
    const rec = r.record as PairingDeviceRecordT;
    const keyPairingId = key.split("/")[1]!;
    const pairing = this.state.pairings.find((p) => p.pairingId === keyPairingId);
    const reject = async (why: string) => { await this.quarantine([{ key, bytes: r.bytes }], "pairing_device", why, "rejected"); return "rejected" as const; };
    if (rec.pairingId !== keyPairingId) return reject(`record pairingId ${rec.pairingId} does not match key`);
    if (!pairing) return reject("unknown pairing id");
    if (pairing.status !== "pending") return reject(`pairing id already ${pairing.status} (single-use)`);
    if (rec.role !== pairing.role) return reject(`role ${rec.role} does not match pairing role ${pairing.role}`);
    let fp: string;
    try { fp = fingerprintFromB64(rec.publicKey); } catch { return reject("bad device public key"); }
    if (fp !== rec.fingerprint) return reject(`device fingerprint ${rec.fingerprint} does not match its public key (${fp})`);

    const now = new Date().toISOString();
    this.state.devices = this.state.devices.filter((d) => d.deviceId !== rec.deviceId);
    this.state.devices.push({ deviceId: rec.deviceId, role: rec.role, pairingId: rec.pairingId, publicKey: rec.publicKey, fingerprint: fp, pairedAt: now });
    pairing.status = "consumed";
    pairing.deviceId = rec.deviceId;
    this.saveState();
    await this.o.cmd.delete(pairingBootstrapKey(rec.pairingId)); // single-use: the bootstrap is gone once consumed
    this.commit({ key, kind: "pairing_device", status: "committed", ingestedAt: now, size: r.bytes.length, ctSha256: sha256hex(r.bytes), deviceId: rec.deviceId, detail: `fingerprint ${fp}` });
    await this.remove([key]);
    this.log(`PAIRED ${key} role=${rec.role} device=${rec.deviceId}`);
    this.log(`  device fingerprint ${fp}`);
    this.log(`  mac fingerprint    ${this.o.identity.fingerprint}`);
    return "committed";
  }

  private async ingestSingle(key: string, kind: Kind): Promise<keyof IngestResult> {
    const r = await this.open(key, kind);
    if ("error" in r) {
      if (!r.bytes) return "waiting";
      await this.quarantine([{ key, bytes: r.bytes }], kind, r.error);
      return "quarantined";
    }
    const rec = r.record as { deviceId: string } & Record<string, unknown>;
    const now = new Date().toISOString();
    let detail: string | undefined;
    const lines: string[] = [];

    switch (kind) {
      case "device_report": {
        const d = rec as unknown as DeviceReportRecordT;
        const dev = this.state.devices.find((x) => x.deviceId === d.deviceId);
        if (dev) { dev.lastReportAt = d.reportedAt; this.saveState(); }
        lines.push(`REPORT ${key} ${this.deviceTag(d.deviceId)} role=${d.role} app=${d.appVersion ?? "-"} queueDepthTotal=${d.queueDepthTotal} reportedAt=${d.reportedAt}`);
        lines.push(...coverageTable(d));
        break;
      }
      case "command_status": {
        const s = rec as unknown as CommandStatusRecordT;
        detail = `${s.commandId} ${s.status}${s.resultOid ? ` result=${s.resultOid}` : ""}`;
        lines.push(`STATUS ${key} ${this.deviceTag(s.deviceId)} command=${s.commandId} status=${s.status}${s.resultOid ? ` resultOid=${s.resultOid}` : ""}${s.detail ? ` detail=${JSON.stringify(s.detail)}` : ""}`);
        const c = readCommands(this.o.root).find((x) => x.commandId === s.commandId);
        if (!c) { lines.push("  (no matching command issued from this root)"); break; }
        // PLAN decision 4: the device token is read-only, so the Mac deletes the command on its status
        await this.o.cmd.delete(c.key);
        Object.assign(c, { status: s.status, detail: s.detail, resultOid: s.resultOid, statusAt: s.reportedAt, deletedFromBucket: true });
        writeCommand(this.o.root, c);
        lines.push(`  deleted ${c.key} from ${this.o.cmd.name} (${c.params.type}${c.params.path ? ` ${c.params.path}` : ""})`);
        if (s.resultOid) {
          const ext = extOf(typeof c.params.path === "string" ? c.params.path : undefined);
          if (ext) this.hint(s.resultOid, ext, lines);
        }
        break;
      }
      case "screenshot": {
        const s = rec as unknown as ScreenshotRecordT;
        this.hint(s.blobOid, extOf(s.sourcePath) ?? "png", lines);
        break;
      }
      case "message_batch": {
        for (const m of (rec as unknown as MessageBatchRecordT).messages)
          for (const a of m.attachments) if (a.blobOid) { const e = extOf(a.filename); if (e) this.hint(a.blobOid, e, lines); }
        break;
      }
      case "file_meta": {
        const f = rec as unknown as FileMetaRecordT;
        if (f.thumbBlobOid) this.hint(f.thumbBlobOid, "thumb", lines);
        break;
      }
    }
    if (kind !== "device_report") lines.unshift(`RECORD ${key} kind=${kind} size=${bytes(r.bytes.length)} ${this.deviceTag(rec.deviceId)} ${compactJson(rec)}`);

    this.commit({ key, kind, status: "committed", ingestedAt: now, size: r.bytes.length, ctSha256: sha256hex(r.bytes), deviceId: rec.deviceId, detail, record: rec });
    await this.remove([key]);
    for (const l of lines) this.log(l);
    return "committed";
  }

  /** Remember the extension for a blob; if it already landed as .bin, rename it. */
  private hint(oid: string, ext: string, lines: string[]) {
    this.state.blobHints[oid] = ext;
    this.saveState();
    const dir = paths(this.o.root).received;
    const bin = join(dir, `${oid}.bin`);
    if (ext !== "bin" && existsSync(bin)) {
      renameSync(bin, join(dir, `${oid}.${ext}`));
      lines.push(`  renamed received/${oid}.bin -> ${oid}.${ext}`);
    }
  }

  private async ingestBlob(g: BlobGroup): Promise<keyof IngestResult> {
    const allKeys = () => [...(g.manifest ? [g.manifest] : []), ...[...g.parts.values()], ...g.extra];
    const waiting = (why: string): keyof IngestResult => {
      if (this.waitingNoted.get(g.oid) !== why) { this.waitingNoted.set(g.oid, why); this.log(`WAIT up/blob/${g.oid}/ ${why}`); }
      return "waiting";
    };
    if (!g.manifest) return waiting(`${g.parts.size} part(s), no manifest yet`);

    const mb = await this.o.up.get(g.manifest);
    if (!mb) return "waiting";
    let manifest;
    try {
      const pt = decryptEnvelope({ recipientSecretKey: this.secret, objectKey: g.manifest, envelope: mb, expectedKind: "manifest" }).plaintext;
      manifest = validateManifest(JSON.parse(fromUtf8(pt)));
    } catch (e) {
      await this.quarantine(await this.fetchAll(allKeys()), "manifest", `manifest undecryptable or invalid: ${(e as Error).message.slice(0, 200)}`);
      return "quarantined";
    }
    const missing: number[] = [];
    for (let i = 0; i < manifest.totalChunks; i++) if (!g.parts.has(i)) missing.push(i);
    const beyond = [...g.parts.keys()].filter((i) => i >= manifest.totalChunks);
    if (missing.length) return waiting(`${manifest.totalChunks - missing.length}/${manifest.totalChunks} parts present`);

    const parts = new Map<number, Uint8Array>();
    for (let i = 0; i < manifest.totalChunks; i++) {
      const b = await this.o.up.get(g.parts.get(i)!);
      if (!b) return "waiting";
      parts.set(i, b);
    }
    let plaintext: Uint8Array;
    try {
      ({ plaintext } = openBlobAtKey(this.secret, g.oid, g.manifest, mb, parts));
    } catch (e) {
      await this.quarantine(await this.fetchAll(allKeys()), "manifest", `blob verification failed: ${(e as Error).message}`);
      return "quarantined";
    }
    this.waitingNoted.delete(g.oid);
    const ext = this.state.blobHints[g.oid] ?? "bin";
    const dir = paths(this.o.root).received;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${g.oid}.${ext}`);
    writeFileSync(file, plaintext);
    const sha = sha256hex(plaintext);
    const ctBytes = mb.length + [...parts.values()].reduce((n, p) => n + p.length, 0);
    const at = new Date().toISOString();
    const partKeys = Array.from({ length: manifest.totalChunks }, (_, i) => g.parts.get(i)!);
    this.commit(
      {
        key: g.manifest, kind: "manifest", status: "committed", ingestedAt: at, size: ctBytes, ctSha256: sha256hex(mb),
        detail: `payloadKind=${manifest.payloadKind}`, parts: manifest.totalChunks, sha256: sha, file: relative(this.o.root, file),
      },
      ...partKeys.map((k, i): LedgerEntry => ({ key: k, kind: "blob_chunk", status: "committed", ingestedAt: at, size: parts.get(i)!.length, ctSha256: sha256hex(parts.get(i)!), detail: `part of ${g.manifest}` })),
    );
    await this.remove([...partKeys, g.manifest]);
    if (beyond.length || g.extra.length) {
      await this.quarantine(await this.fetchAll([...beyond.map((i) => g.parts.get(i)!), ...g.extra]), "blob_chunk", "part outside the manifest's range");
    }
    this.log(`BLOB ${g.manifest} payloadKind=${manifest.payloadKind} parts=${manifest.totalChunks} size=${plaintext.length} sha256=${sha} -> ${relative(this.o.root, file)}`);
    return "committed";
  }

  private async fetchAll(keys: string[]) {
    const out: Array<{ key: string; bytes: Uint8Array | null }> = [];
    for (const key of keys) out.push({ key, bytes: await this.o.up.get(key) });
    return out;
  }
}
