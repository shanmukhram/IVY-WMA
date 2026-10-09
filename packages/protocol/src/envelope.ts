/**
 * The IVY envelope: hybrid public-key encryption of one object.
 *
 * Scheme (single-shot): a fresh random AES-256-GCM content key (CEK) encrypts the
 * payload. The CEK is wrapped to the recipient's X25519 public key using an
 * ephemeral X25519 keypair and HKDF-SHA256. Nobody without the recipient's
 * private key can recover the CEK, hence nothing in R2 is readable.
 *
 * Replay/relocation resistance: the object's storage key and its kind are mixed
 * into the GCM additional authenticated data (AAD) of BOTH the key-wrap and the
 * body. An object copied to a different key, or relabelled as a different kind,
 * fails authentication. The ephemeral public key (epk) is also in the AAD, so the
 * body is bound to the specific wrap.
 *
 * Chunked variant: one CEK encrypts every chunk of a large object, each chunk as
 * an independent AES-256-GCM record with a deterministic nonce (counter from the
 * chunk index) and an AAD binding the object id + index + total. A manifest
 * (itself a single-shot envelope) carries the CEK and a SHA-256 of every chunk,
 * binding the parts together. Reordering, substituting, or dropping a chunk is
 * detected by the per-chunk AAD and the manifest hashes.
 *
 * Byte layout (all integers big-endian):
 *   single-shot:
 *     0  magic "IVY1"        4
 *     4  version (1)         1
 *     5  mode (0x01)         1
 *     6  kind id             1
 *     7  reserved (0x00)     1
 *     8  ephemeral pubkey    32
 *    40  wrap nonce          12
 *    52  wrapped CEK + tag   48
 *   100  body nonce          12
 *   112  body ciphertext+tag rest
 *   chunk part:
 *     0  magic "IVY1"        4
 *     4  version (1)         1
 *     5  mode (0x02)         1
 *     6  kind id (blob_chunk)1
 *     7  reserved (0x00)     1
 *     8  object id           16
 *    24  chunk index (u32)   4
 *    28  total chunks (u32)  4
 *    32  body ciphertext+tag rest   (nonce derived from index, not stored)
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  GCM_NONCE_LEN,
  GCM_TAG_LEN,
  AES_KEY_LEN,
} from "./aesgcm.js";
import { concatBytes, utf8, toBase64, fromBase64, toHex, u32be, u64be, readU32be, timingSafeEqual } from "./bytes.js";
import { randomBytes } from "./random.js";
import { publicKeyFromSecret } from "./keys.js";
import type { Kind } from "./kinds.js";
import { kindId, kindById } from "./kinds.js";

export const MAGIC = utf8("IVY1");
export const VERSION = 1;
export const MODE_SINGLE = 0x01;
export const MODE_CHUNK = 0x02;

const EPK_LEN = 32;
const WRAPPED_CEK_LEN = AES_KEY_LEN + GCM_TAG_LEN; // 48
const SINGLE_HEADER_FIXED = 4 + 1 + 1 + 1 + 1; // 8 up to epk
const SINGLE_BODY_OFFSET = SINGLE_HEADER_FIXED + EPK_LEN + GCM_NONCE_LEN + WRAPPED_CEK_LEN + GCM_NONCE_LEN; // 112

const CHUNK_HEADER_LEN = 4 + 1 + 1 + 1 + 1 + 16 + 4 + 4; // 32

const HKDF_INFO = utf8("IVY1 kek v1");
const AAD_WRAP = utf8("ivy/v1/wrap");
const AAD_BODY = utf8("ivy/v1/body");
const AAD_CHUNK = utf8("ivy/v1/chunk");
const SEP = new Uint8Array([0x00]);

function deriveKek(shared: Uint8Array, epk: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  // salt = epk; info = "IVY1 kek v1" || recipientPub
  return hkdf(sha256, shared, epk, concatBytes(HKDF_INFO, recipientPub), AES_KEY_LEN);
}

function wrapAad(objectKey: string, kind: Kind, epk: Uint8Array): Uint8Array {
  return concatBytes(AAD_WRAP, SEP, utf8(objectKey), SEP, new Uint8Array([kindId(kind)]), SEP, epk);
}

function bodyAad(objectKey: string, kind: Kind, epk: Uint8Array): Uint8Array {
  return concatBytes(AAD_BODY, SEP, utf8(objectKey), SEP, new Uint8Array([kindId(kind)]), SEP, epk);
}

export interface EncryptOptions {
  /** TEST ONLY: fixed ephemeral X25519 secret key (32 bytes). */
  ephemeralSecretKey?: Uint8Array;
  /** TEST ONLY: fixed content key (32 bytes). */
  contentKey?: Uint8Array;
  /** TEST ONLY: fixed wrap nonce (12 bytes). */
  wrapNonce?: Uint8Array;
  /** TEST ONLY: fixed body nonce (12 bytes). */
  bodyNonce?: Uint8Array;
}

export interface EncryptParams {
  recipientPublicKey: Uint8Array;
  kind: Kind;
  objectKey: string;
  plaintext: Uint8Array;
  options?: EncryptOptions;
}

/** Encrypt a single object into an IVY envelope. */
export function encryptEnvelope(params: EncryptParams): Uint8Array {
  const { recipientPublicKey, kind, objectKey, plaintext, options } = params;
  if (recipientPublicKey.length !== EPK_LEN) throw new Error("recipient public key must be 32 bytes");

  const ephSk = options?.ephemeralSecretKey ?? randomBytes(EPK_LEN);
  const epk = publicKeyFromSecret(ephSk);
  const cek = options?.contentKey ?? randomBytes(AES_KEY_LEN);
  const wrapNonce = options?.wrapNonce ?? randomBytes(GCM_NONCE_LEN);
  const bodyNonce = options?.bodyNonce ?? randomBytes(GCM_NONCE_LEN);

  const shared = x25519.getSharedSecret(ephSk, recipientPublicKey);
  const kek = deriveKek(shared, epk, recipientPublicKey);

  const wrappedCek = aesGcmEncrypt(kek, wrapNonce, cek, wrapAad(objectKey, kind, epk));
  const body = aesGcmEncrypt(cek, bodyNonce, plaintext, bodyAad(objectKey, kind, epk));

  const header = concatBytes(
    MAGIC,
    new Uint8Array([VERSION, MODE_SINGLE, kindId(kind), 0x00]),
    epk,
    wrapNonce,
    wrappedCek,
    bodyNonce,
  );
  return concatBytes(header, body);
}

export interface DecryptParams {
  recipientSecretKey: Uint8Array;
  objectKey: string;
  envelope: Uint8Array;
  /** Optional assertion: throws if the envelope's declared kind differs. */
  expectedKind?: Kind;
}

export interface DecryptResult {
  kind: Kind;
  plaintext: Uint8Array;
}

/** Decrypt a single IVY envelope. Throws on any tamper, wrong recipient, or bad kind. */
export function decryptEnvelope(params: DecryptParams): DecryptResult {
  const { recipientSecretKey, objectKey, envelope, expectedKind } = params;
  if (envelope.length < SINGLE_BODY_OFFSET + GCM_TAG_LEN) throw new Error("envelope too short");
  if (!timingSafeEqual(envelope.subarray(0, 4), MAGIC)) throw new Error("bad magic");
  if (envelope[4] !== VERSION) throw new Error(`unsupported version ${envelope[4]}`);
  if (envelope[5] !== MODE_SINGLE) throw new Error(`not a single-shot envelope (mode ${envelope[5]})`);
  const kind = kindById(envelope[6]!);
  if (expectedKind && kind !== expectedKind) {
    throw new Error(`kind mismatch: header says ${kind}, expected ${expectedKind}`);
  }

  let off = SINGLE_HEADER_FIXED;
  const epk = envelope.subarray(off, off + EPK_LEN); off += EPK_LEN;
  const wrapNonce = envelope.subarray(off, off + GCM_NONCE_LEN); off += GCM_NONCE_LEN;
  const wrappedCek = envelope.subarray(off, off + WRAPPED_CEK_LEN); off += WRAPPED_CEK_LEN;
  const bodyNonce = envelope.subarray(off, off + GCM_NONCE_LEN); off += GCM_NONCE_LEN;
  const body = envelope.subarray(off);

  const recipientPub = publicKeyFromSecret(recipientSecretKey);
  const shared = x25519.getSharedSecret(recipientSecretKey, epk);
  const kek = deriveKek(shared, epk, recipientPub);

  const cek = aesGcmDecrypt(kek, wrapNonce, wrappedCek, wrapAad(objectKey, kind, epk));
  const plaintext = aesGcmDecrypt(cek, bodyNonce, body, bodyAad(objectKey, kind, epk));
  return { kind, plaintext };
}

// ---------------------------------------------------------------------------
// Chunked objects
// ---------------------------------------------------------------------------

/** Deterministic nonce for chunk `index`: 4 zero bytes || u64be(index). */
export function chunkNonce(index: number): Uint8Array {
  return concatBytes(new Uint8Array(4), u64be(index));
}

function chunkAad(objectId: Uint8Array, index: number, totalChunks: number): Uint8Array {
  return concatBytes(
    AAD_CHUNK, SEP, objectId, u32be(index), u32be(totalChunks),
    new Uint8Array([kindId("blob_chunk")]),
  );
}

export interface ManifestChunk {
  index: number;
  /** length in bytes of the full part (header + ciphertext + tag) */
  ctLen: number;
  /** hex SHA-256 of the full part bytes */
  sha256: string;
}

/** Plaintext manifest carried inside the (encrypted) manifest envelope. */
export interface ChunkedManifest {
  v: 1;
  objectId: string; // hex of the 16-byte object id
  payloadKind: Kind; // logical kind of the reconstructed object (e.g. screenshot, file_meta)
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  /** base64 content key used for every chunk */
  cek: string;
  chunks: ManifestChunk[];
}

export interface EncryptChunkedParams {
  recipientPublicKey: Uint8Array;
  /** oid used in the object keys (string form of the object id). */
  oid: string;
  /** 16-byte object id (binary, bound into every chunk's AAD). */
  objectId: Uint8Array;
  payloadKind: Kind;
  plaintext: Uint8Array;
  chunkSize: number;
  options?: {
    /** TEST ONLY: fixed content key for the whole object. */
    contentKey?: Uint8Array;
    /** TEST ONLY: ephemeral secret key for the manifest envelope. */
    manifestEphemeralSecretKey?: Uint8Array;
    /** TEST ONLY: content key for the manifest envelope. */
    manifestContentKey?: Uint8Array;
    /** TEST ONLY: wrap nonce for the manifest envelope. */
    manifestWrapNonce?: Uint8Array;
    /** TEST ONLY: body nonce for the manifest envelope. */
    manifestBodyNonce?: Uint8Array;
  };
}

export interface ChunkPart {
  index: number;
  /** full part bytes (header + ciphertext + tag) to upload */
  bytes: Uint8Array;
}

export interface EncryptChunkedResult {
  manifest: ChunkedManifest;
  /** the encrypted manifest envelope (store at up/blob/<oid>/manifest) */
  manifestEnvelope: Uint8Array;
  /** one entry per chunk (store at up/blob/<oid>/p/<index>) */
  parts: ChunkPart[];
}

function buildChunkPart(
  cek: Uint8Array,
  objectId: Uint8Array,
  index: number,
  totalChunks: number,
  chunkPlain: Uint8Array,
): Uint8Array {
  const header = concatBytes(
    MAGIC,
    new Uint8Array([VERSION, MODE_CHUNK, kindId("blob_chunk"), 0x00]),
    objectId,
    u32be(index),
    u32be(totalChunks),
  );
  const ct = aesGcmEncrypt(cek, chunkNonce(index), chunkPlain, chunkAad(objectId, index, totalChunks));
  return concatBytes(header, ct);
}

/** Encrypt a large object as independent chunks plus a binding manifest envelope. */
export function encryptChunkedObject(params: EncryptChunkedParams): EncryptChunkedResult {
  const { recipientPublicKey, oid, objectId, payloadKind, plaintext, chunkSize, options } = params;
  if (objectId.length !== 16) throw new Error("objectId must be 16 bytes");
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");

  const cek = options?.contentKey ?? randomBytes(AES_KEY_LEN);
  const totalChunks = Math.max(1, Math.ceil(plaintext.length / chunkSize));
  const parts: ChunkPart[] = [];
  const chunks: ManifestChunk[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const slice = plaintext.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, plaintext.length));
    const bytes = buildChunkPart(cek, objectId, i, totalChunks, slice);
    parts.push({ index: i, bytes });
    chunks.push({ index: i, ctLen: bytes.length, sha256: toHex(sha256(bytes)) });
  }

  const manifest: ChunkedManifest = {
    v: 1,
    objectId: toHex(objectId),
    payloadKind,
    totalSize: plaintext.length,
    chunkSize,
    totalChunks,
    cek: toBase64(cek),
    chunks,
  };

  const manifestKey = `up/blob/${oid}/manifest`;
  const manifestEnvelope = encryptEnvelope({
    recipientPublicKey,
    kind: "manifest",
    objectKey: manifestKey,
    plaintext: utf8(JSON.stringify(manifest)),
    options: {
      ephemeralSecretKey: options?.manifestEphemeralSecretKey,
      contentKey: options?.manifestContentKey,
      wrapNonce: options?.manifestWrapNonce,
      bodyNonce: options?.manifestBodyNonce,
    },
  });

  return { manifest, manifestEnvelope, parts };
}

/** Parse (without decrypting) a chunk part's header. */
export function parseChunkHeader(bytes: Uint8Array): {
  objectId: Uint8Array;
  index: number;
  totalChunks: number;
} {
  if (bytes.length < CHUNK_HEADER_LEN + GCM_TAG_LEN) throw new Error("chunk part too short");
  if (!timingSafeEqual(bytes.subarray(0, 4), MAGIC)) throw new Error("bad magic");
  if (bytes[4] !== VERSION) throw new Error(`unsupported version ${bytes[4]}`);
  if (bytes[5] !== MODE_CHUNK) throw new Error(`not a chunk part (mode ${bytes[5]})`);
  const objectId = bytes.subarray(8, 24);
  const index = readU32be(bytes, 24);
  const totalChunks = readU32be(bytes, 28);
  return { objectId, index, totalChunks };
}

export interface DecryptChunkedParams {
  recipientSecretKey: Uint8Array;
  manifestKey: string;
  manifestEnvelope: Uint8Array;
  /** full part bytes keyed by chunk index (as uploaded) */
  parts: Map<number, Uint8Array>;
}

/**
 * Verify and decrypt a chunked object. Each part is checked against the manifest
 * SHA-256 (fast tamper check), then its header index is checked against the
 * expected position, then AES-GCM-decrypted with the per-index AAD. Any mismatch
 * — a reordered, substituted, truncated, or tampered part, or a missing one —
 * throws. Returns the reassembled plaintext.
 */
export function decryptChunkedObject(params: DecryptChunkedParams): {
  manifest: ChunkedManifest;
  plaintext: Uint8Array;
} {
  const { recipientSecretKey, manifestKey, manifestEnvelope, parts } = params;
  const { plaintext: manifestJson } = decryptEnvelope({
    recipientSecretKey,
    objectKey: manifestKey,
    envelope: manifestEnvelope,
    expectedKind: "manifest",
  });
  const manifest = JSON.parse(Buffer.from(manifestJson).toString("utf8")) as ChunkedManifest;
  const cek = fromBase64(manifest.cek);
  if (cek.length !== AES_KEY_LEN) throw new Error("manifest cek must be 32 bytes");

  const out: Uint8Array[] = [];
  for (let i = 0; i < manifest.totalChunks; i++) {
    const entry = manifest.chunks[i];
    if (!entry || entry.index !== i) throw new Error(`manifest chunk ${i} missing or misordered`);
    const part = parts.get(i);
    if (!part) throw new Error(`chunk part ${i} not supplied`);
    if (part.length !== entry.ctLen) throw new Error(`chunk ${i} length mismatch`);
    if (toHex(sha256(part)) !== entry.sha256) throw new Error(`chunk ${i} hash mismatch (tampered or reordered)`);

    const h = parseChunkHeader(part);
    if (h.index !== i) throw new Error(`chunk ${i} header index is ${h.index} (reordered)`);
    if (h.totalChunks !== manifest.totalChunks) throw new Error(`chunk ${i} total mismatch`);

    const ct = part.subarray(CHUNK_HEADER_LEN);
    const plain = aesGcmDecrypt(cek, chunkNonce(i), ct, chunkAad(h.objectId, i, manifest.totalChunks));
    out.push(plain);
  }
  const plaintext = concatBytes(...out);
  if (plaintext.length !== manifest.totalSize) throw new Error("reassembled size mismatch");
  return { manifest, plaintext };
}
