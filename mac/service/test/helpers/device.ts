/**
 * A simulated device written only with @ivy/protocol and the scoped tokens from
 * the pairing string: what the Windows (or Android) app does on the wire.
 */
import { randomUUID, randomBytes } from "node:crypto";
import {
  blobChunkKey, blobManifestKey, concatBytes, decodePairingString, decryptEnvelope, decryptPairingBootstrap,
  encryptChunkedObject, encryptEnvelope, fingerprint, fingerprintFromB64, fromBase64, fromUtf8, generateKeyPair,
  newOid, pairingBootstrapKey, pairingDeviceKey, toBase64, toCrockford, u48be, upKey, utf8, validateRecordKind,
} from "@ivy/protocol";
import type { CommandRecordT, Kind, KeyPair, PairingPayload, PayloadKind } from "@ivy/protocol";
import { Bucket } from "../../src/r2/client.ts";

export const iso = (ms = Date.now()) => new Date(ms).toISOString();

export class SimDevice {
  deviceId = randomUUID();
  readonly keys: KeyPair = generateKeyPair();
  readonly payload: PairingPayload;
  readonly cmd: Bucket;
  up!: Bucket;
  readonly macPub: Uint8Array;

  constructor(pairingString: string, opts: { now?: number } = {}) {
    this.payload = decodePairingString(pairingString, { now: opts.now });
    if (fingerprintFromB64(this.payload.macPublicKey) !== this.payload.macFingerprint) throw new Error("mac fingerprint mismatch");
    this.macPub = fromBase64(this.payload.macPublicKey);
    this.cmd = new Bucket(this.payload.r2Endpoint, this.payload.cmdBucket, this.payload.cmdReadToken);
  }

  get role() { return this.payload.role; }
  get fingerprint() { return fingerprint(this.keys.publicKey); }

  base(kind: string, t = iso()) {
    return { v: 1 as const, kind, deviceId: this.deviceId, eventTime: t, captureTime: t };
  }

  /** PROTOCOL §7 steps 2-4 */
  async pair(): Promise<string> {
    const raw = await this.cmd.get(pairingBootstrapKey(this.payload.pairingId));
    if (!raw) throw new Error("bootstrap missing");
    const boot = decryptPairingBootstrap(JSON.parse(fromUtf8(raw)), fromBase64(this.payload.secret), this.payload.pairingId);
    this.up = new Bucket(this.payload.r2Endpoint, boot.upBucket, boot.upWriteToken);
    return this.putPairingRecord(this.payload.pairingId);
  }

  async putPairingRecord(pairingId: string): Promise<string> {
    const key = pairingDeviceKey(pairingId);
    const rec = { ...this.base("pairing_device"), role: this.role, pairingId, publicKey: toBase64(this.keys.publicKey), fingerprint: this.fingerprint };
    await this.up.put(key, encryptEnvelope({ recipientPublicKey: this.macPub, kind: "pairing_device", objectKey: key, plaintext: utf8(JSON.stringify(validateRecordKind("pairing_device", rec))) }));
    return key;
  }

  /** Encrypt one record; returns key + bytes without uploading. */
  seal(kind: Kind, fields: Record<string, unknown>, opts: { oid?: string; eventTime?: string } = {}) {
    const key = upKey(kind, opts.oid ?? newOid());
    const rec = validateRecordKind(kind as never, { ...this.base(kind, opts.eventTime), ...fields });
    return { key, bytes: encryptEnvelope({ recipientPublicKey: this.macPub, kind, objectKey: key, plaintext: utf8(JSON.stringify(rec)) }) };
  }

  async put(kind: Kind, fields: Record<string, unknown>, opts: { oid?: string; eventTime?: string } = {}): Promise<string> {
    const s = this.seal(kind, fields, opts);
    await this.up.put(s.key, s.bytes);
    return s.key;
  }

  blob(plaintext: Uint8Array, payloadKind: PayloadKind, chunkSize = 256) {
    const objectId = concatBytes(u48be(Date.now()), new Uint8Array(randomBytes(10)));
    const oid = toCrockford(objectId);
    const r = encryptChunkedObject({ recipientPublicKey: this.macPub, oid, objectId, payloadKind, plaintext, chunkSize });
    return {
      oid,
      manifest: { key: blobManifestKey(oid), bytes: r.manifestEnvelope },
      parts: r.parts.map((p) => ({ key: blobChunkKey(oid, p.index), bytes: p.bytes })),
    };
  }

  async putBlob(b: ReturnType<SimDevice["blob"]>) {
    await this.up.put(b.manifest.key, b.manifest.bytes);
    for (const p of b.parts) await this.up.put(p.key, p.bytes);
  }

  async commands(): Promise<Array<{ key: string; record: CommandRecordT }>> {
    const out = [];
    for (const { key } of await this.cmd.list("cmd/")) {
      const env = (await this.cmd.get(key))!;
      const { plaintext } = decryptEnvelope({ recipientSecretKey: this.keys.secretKey, objectKey: key, envelope: env, expectedKind: "command" });
      out.push({ key, record: validateRecordKind("command", JSON.parse(fromUtf8(plaintext))) });
    }
    return out;
  }

  report(collectors: Array<{ name: string; enabled?: boolean; lastRunAt?: string; cursor?: string; queueDepth?: number }>, at = iso()) {
    return this.put("device_report", {
      role: this.role, appVersion: "0.1.0", queueDepthTotal: collectors.reduce((n, c) => n + (c.queueDepth ?? 0), 0), reportedAt: at,
      collectors: collectors.map((c) => ({ name: c.name, enabled: c.enabled ?? true, lastRunAt: c.lastRunAt, cursor: c.cursor, queueDepth: c.queueDepth ?? 0 })),
    }, { eventTime: at });
  }

  close() { this.cmd.close(); this.up?.close(); }
}

/** A tiny valid PNG (1x1). */
export const PNG_1x1 = new Uint8Array(Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex"));
