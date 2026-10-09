import { describe, it, expect } from "vitest";
import {
  encryptChunkedObject,
  decryptChunkedObject,
  generateKeyPair,
  randomBytes,
  blobManifestKey,
  parseChunkHeader,
} from "../src/index.js";

const RECIPIENT = generateKeyPair();

function build(size: number, chunkSize: number) {
  const oid = "01HZZZCHUNKED000000000000A";
  const objectId = randomBytes(16);
  const plaintext = randomBytes(size);
  const res = encryptChunkedObject({
    recipientPublicKey: RECIPIENT.publicKey,
    oid,
    objectId,
    payloadKind: "screenshot",
    plaintext,
    chunkSize,
  });
  return { oid, objectId, plaintext, res };
}

describe("chunked object", () => {
  it("round-trips a multi-chunk object", () => {
    const { oid, plaintext, res } = build(1000, 256);
    expect(res.parts.length).toBe(4);
    const parts = new Map(res.parts.map((p) => [p.index, p.bytes]));
    const out = decryptChunkedObject({
      recipientSecretKey: RECIPIENT.secretKey,
      manifestKey: blobManifestKey(oid),
      manifestEnvelope: res.manifestEnvelope,
      parts,
    });
    expect(Buffer.from(out.plaintext).equals(Buffer.from(plaintext))).toBe(true);
  });

  it("each part is independently parseable and ordered", () => {
    const { res } = build(1000, 256);
    res.parts.forEach((p, i) => {
      const h = parseChunkHeader(p.bytes);
      expect(h.index).toBe(i);
      expect(h.totalChunks).toBe(4);
    });
  });

  it("rejects reordered chunks", () => {
    const { oid, res } = build(1000, 256);
    const parts = new Map(res.parts.map((p) => [p.index, p.bytes]));
    // swap parts 1 and 2 under each other's index
    const p1 = parts.get(1)!;
    const p2 = parts.get(2)!;
    parts.set(1, p2);
    parts.set(2, p1);
    expect(() =>
      decryptChunkedObject({
        recipientSecretKey: RECIPIENT.secretKey,
        manifestKey: blobManifestKey(oid),
        manifestEnvelope: res.manifestEnvelope,
        parts,
      }),
    ).toThrow(/hash mismatch|reordered|index/);
  });

  it("rejects a tampered chunk", () => {
    const { oid, res } = build(1000, 256);
    const parts = new Map(res.parts.map((p) => [p.index, p.bytes]));
    const p = parts.get(2)!.slice();
    p[p.length - 1] ^= 0x01;
    parts.set(2, p);
    expect(() =>
      decryptChunkedObject({
        recipientSecretKey: RECIPIENT.secretKey,
        manifestKey: blobManifestKey(oid),
        manifestEnvelope: res.manifestEnvelope,
        parts,
      }),
    ).toThrow();
  });

  it("rejects a missing chunk", () => {
    const { oid, res } = build(1000, 256);
    const parts = new Map(res.parts.map((p) => [p.index, p.bytes]));
    parts.delete(3);
    expect(() =>
      decryptChunkedObject({
        recipientSecretKey: RECIPIENT.secretKey,
        manifestKey: blobManifestKey(oid),
        manifestEnvelope: res.manifestEnvelope,
        parts,
      }),
    ).toThrow(/not supplied/);
  });

  it("rejects a wrong recipient on the manifest", () => {
    const { oid, res } = build(1000, 256);
    const wrong = generateKeyPair();
    const parts = new Map(res.parts.map((p) => [p.index, p.bytes]));
    expect(() =>
      decryptChunkedObject({
        recipientSecretKey: wrong.secretKey,
        manifestKey: blobManifestKey(oid),
        manifestEnvelope: res.manifestEnvelope,
        parts,
      }),
    ).toThrow();
  });

  it("handles a single-chunk object", () => {
    const { oid, plaintext, res } = build(100, 256);
    expect(res.parts.length).toBe(1);
    const parts = new Map(res.parts.map((p) => [p.index, p.bytes]));
    const out = decryptChunkedObject({
      recipientSecretKey: RECIPIENT.secretKey,
      manifestKey: blobManifestKey(oid),
      manifestEnvelope: res.manifestEnvelope,
      parts,
    });
    expect(Buffer.from(out.plaintext).equals(Buffer.from(plaintext))).toBe(true);
  });
});
