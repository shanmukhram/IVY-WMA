/** The test plays the Windows device using only @ivy/protocol and the scoped tokens from the pairing string. */
import { randomUUID, randomBytes } from "node:crypto";
import {
  blobChunkKey, blobManifestKey, concatBytes, decodePairingString, decryptEnvelope, decryptPairingBootstrap,
  encryptChunkedObject, encryptEnvelope, fingerprint, fingerprintFromB64, fromBase64, fromUtf8, generateKeyPair,
  newOid, pairingBootstrapKey, pairingDeviceKey, toBase64, toCrockford, u48be, upKey, utf8, validateRecordKind,
} from "@ivy/protocol";
import type { CommandRecordT, Kind, KeyPair, PairingPayload } from "@ivy/protocol";
import { Bucket } from "../src/s3.ts";

export const iso = () => new Date().toISOString();

export class FakeDevice {
  readonly deviceId = randomUUID();
  readonly keys: KeyPair = generateKeyPair();
  readonly payload: PairingPayload;
  readonly cmd: Bucket;
  up!: Bucket;
  private readonly macPub: Uint8Array;

  constructor(pairingString: string) {
    this.payload = decodePairingString(pairingString);
    if (fingerprintFromB64(this.payload.macPublicKey) !== this.payload.macFingerprint) throw new Error("mac fingerprint mismatch");
    this.macPub = fromBase64(this.payload.macPublicKey);
    this.cmd = new Bucket(this.payload.r2Endpoint, this.payload.cmdBucket, this.payload.cmdReadToken);
  }

  get fingerprint() { return fingerprint(this.keys.publicKey); }

  base(kind: string) {
    const t = iso();
    return { v: 1 as const, kind, deviceId: this.deviceId, eventTime: t, captureTime: t };
  }

  /** PROTOCOL §7 steps 2-4. */
  async pair(): Promise<string> {
    const { pairingId } = this.payload;
    const raw = await this.cmd.get(pairingBootstrapKey(pairingId));
    if (!raw) throw new Error("bootstrap missing");
    const boot = decryptPairingBootstrap(JSON.parse(fromUtf8(raw)), fromBase64(this.payload.secret), pairingId);
    this.up = new Bucket(this.payload.r2Endpoint, boot.upBucket, boot.upWriteToken);
    return this.putPairingRecord(pairingId);
  }

  async putPairingRecord(pairingId: string): Promise<string> {
    const key = pairingDeviceKey(pairingId);
    const rec = { ...this.base("pairing_device"), role: "windows", pairingId, publicKey: toBase64(this.keys.publicKey), fingerprint: this.fingerprint };
    await this.up.put(key, encryptEnvelope({ recipientPublicKey: this.macPub, kind: "pairing_device", objectKey: key, plaintext: utf8(JSON.stringify(validateRecordKind("pairing_device", rec))) }));
    return key;
  }

  async putRecord(kind: Kind, fields: Record<string, unknown>): Promise<string> {
    const key = upKey(kind, newOid());
    const rec = validateRecordKind(kind as never, { ...this.base(kind), ...fields });
    await this.up.put(key, encryptEnvelope({ recipientPublicKey: this.macPub, kind, objectKey: key, plaintext: utf8(JSON.stringify(rec)) }));
    return key;
  }

  /** Encrypt a blob; returns its oid and the objects, so the test can upload them in any order. */
  blob(plaintext: Uint8Array, payloadKind: string, chunkSize = 256) {
    const objectId = concatBytes(u48be(Date.now()), new Uint8Array(randomBytes(10)));
    const oid = toCrockford(objectId);
    const r = encryptChunkedObject({ recipientPublicKey: this.macPub, oid, objectId, payloadKind: payloadKind as never, plaintext, chunkSize });
    return {
      oid,
      manifest: { key: blobManifestKey(oid), bytes: r.manifestEnvelope },
      parts: r.parts.map((p) => ({ key: blobChunkKey(oid, p.index), bytes: p.bytes })),
    };
  }

  async putBlob(b: ReturnType<FakeDevice["blob"]>) {
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

  close() { this.cmd.close(); this.up?.close(); }
}
