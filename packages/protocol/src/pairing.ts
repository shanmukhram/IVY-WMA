/**
 * Pairing bootstrap (PLAN decision 1).
 *
 * A fresh device has no R2 credentials, so the one-time code must carry a
 * bootstrap. Flow:
 *   1. Mac generates a pairing id + one-time secret, and writes `pair/<id>` into
 *      the device's cmd-bucket: a bootstrap payload (the up-bucket WRITE token)
 *      encrypted with a key DERIVED FROM THE SECRET (symmetric; the device has no
 *      keypair exchanged yet).
 *   2. Mac shows a pairing string (and the same payload as a QR). It holds the R2
 *      endpoint, the device's cmd-bucket READ token, the Mac's public key, the
 *      Mac's fingerprint, the pairing id, the one-time secret, and an expiry.
 *   3. Device decodes the string, checks version + expiry, verifies the Mac
 *      fingerprint matches the Mac public key, fetches `pair/<id>`, and decrypts
 *      the bootstrap with the secret-derived key to obtain the up-bucket write
 *      token.
 *   4. Device generates its own X25519 keypair, and writes `pair/<id>/device` to
 *      its up-bucket: a normal envelope (kind pairing_device) encrypted to the
 *      Mac's public key, carrying the device public key + fingerprint.
 *   5. Mac ingests it, stores the device, and both screens display the matching
 *      fingerprints to confirm.
 *
 * Single-use: the Mac deletes `pair/<id>` once consumed and refuses a second
 * `pair/<id>/device`. Expiry is a backstop. Re-pairing after a Mac restore works
 * because the Mac key is re-derived from the passphrase (see kdf.ts).
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { aesGcmEncrypt, aesGcmDecrypt, GCM_NONCE_LEN, AES_KEY_LEN } from "./aesgcm.js";
import {
  utf8, fromUtf8, concatBytes, toBase64, fromBase64, toBase64url, fromBase64url,
} from "./bytes.js";
import { randomBytes } from "./random.js";

export const PAIRING_STRING_PREFIX = "IVYPAIR1";
export const PAIRING_SECRET_LEN = 32;

const BOOTSTRAP_INFO = utf8("IVY1 pair v1");
const BOOTSTRAP_AAD_PREFIX = utf8("ivy/v1/pair");
const SEP = new Uint8Array([0x00]);

/** The decoded contents of a pairing string / QR. */
export interface PairingPayload {
  /** format version */
  v: 1;
  /** R2 S3-compatible endpoint, e.g. https://<acct>.r2.cloudflarestorage.com */
  r2Endpoint: string;
  /** device role this code is for */
  role: "windows" | "android";
  /** bucket the device reads commands from */
  cmdBucket: string;
  /** bucket the device writes captures to */
  upBucket: string;
  /** device's cmd-bucket READ token (scoped) */
  cmdReadToken: string;
  /** base64 Mac X25519 public key */
  macPublicKey: string;
  /** Mac fingerprint (must equal fingerprint(macPublicKey)) */
  macFingerprint: string;
  /** pairing id (also the object-key segment) */
  pairingId: string;
  /** base64 one-time secret */
  secret: string;
  /** expiry, unix epoch ms */
  exp: number;
}

/** Generate a pairing id (16 random bytes, hex). */
export function newPairingId(): string {
  return Buffer.from(randomBytes(16)).toString("hex");
}

/** Generate a one-time pairing secret (32 bytes). */
export function newPairingSecret(): Uint8Array {
  return randomBytes(PAIRING_SECRET_LEN);
}

/**
 * Encode a pairing payload as a compact, pasteable, QR-friendly string:
 * `IVYPAIR1.<base64url(JSON)>`. The dot separates the magic from the body.
 */
export function encodePairingString(payload: PairingPayload): string {
  return `${PAIRING_STRING_PREFIX}.${toBase64url(utf8(JSON.stringify(payload)))}`;
}

export interface DecodeOptions {
  /** current time (ms) for expiry checking; defaults to Date.now() */
  now?: number;
}

/** Decode and validate a pairing string. Throws on bad format or expiry. */
export function decodePairingString(s: string, opts: DecodeOptions = {}): PairingPayload {
  const dot = s.indexOf(".");
  if (dot < 0 || s.slice(0, dot) !== PAIRING_STRING_PREFIX) {
    throw new Error("not an IVY pairing string");
  }
  const payload = JSON.parse(fromUtf8(fromBase64url(s.slice(dot + 1)))) as PairingPayload;
  if (payload.v !== 1) throw new Error(`unsupported pairing version ${payload.v}`);
  const now = opts.now ?? Date.now();
  if (typeof payload.exp !== "number" || now > payload.exp) {
    throw new Error("pairing code expired");
  }
  return payload;
}

// --- bootstrap payload (the up-bucket write token), encrypted to the secret ---

function bootstrapKey(secret: Uint8Array, pairingId: string): Uint8Array {
  // salt = pairingId utf8; info = "IVY1 pair v1"
  return hkdf(sha256, secret, utf8(pairingId), BOOTSTRAP_INFO, AES_KEY_LEN);
}

function bootstrapAad(pairingId: string): Uint8Array {
  return concatBytes(BOOTSTRAP_AAD_PREFIX, SEP, utf8(pairingId));
}

/** Contents the Mac places in `pair/<id>` for the device to read. */
export interface BootstrapPayload {
  v: 1;
  upBucket: string;
  /** device's up-bucket WRITE token (scoped) */
  upWriteToken: string;
  pairingId: string;
}

export interface EncryptBootstrapOptions {
  /** TEST ONLY: fixed nonce (12 bytes). */
  nonce?: Uint8Array;
}

/**
 * Encrypt the bootstrap payload under the one-time secret. Output is a
 * JSON-serializable container stored at `pair/<id>` in the device's cmd-bucket.
 */
export interface SealedBootstrap {
  v: 1;
  nonce: string; // base64
  ct: string; // base64 ciphertext+tag
}

export function encryptPairingBootstrap(
  payload: BootstrapPayload,
  secret: Uint8Array,
  opts: EncryptBootstrapOptions = {},
): SealedBootstrap {
  if (secret.length !== PAIRING_SECRET_LEN) throw new Error("secret must be 32 bytes");
  const key = bootstrapKey(secret, payload.pairingId);
  const nonce = opts.nonce ?? randomBytes(GCM_NONCE_LEN);
  const ct = aesGcmEncrypt(key, nonce, utf8(JSON.stringify(payload)), bootstrapAad(payload.pairingId));
  return { v: 1, nonce: toBase64(nonce), ct: toBase64(ct) };
}

/** Decrypt the bootstrap payload using the one-time secret and pairing id. */
export function decryptPairingBootstrap(
  sealed: SealedBootstrap,
  secret: Uint8Array,
  pairingId: string,
): BootstrapPayload {
  if (sealed.v !== 1) throw new Error(`unsupported bootstrap version ${sealed.v}`);
  if (secret.length !== PAIRING_SECRET_LEN) throw new Error("secret must be 32 bytes");
  const key = bootstrapKey(secret, pairingId);
  const pt = aesGcmDecrypt(key, fromBase64(sealed.nonce), fromBase64(sealed.ct), bootstrapAad(pairingId));
  const payload = JSON.parse(fromUtf8(pt)) as BootstrapPayload;
  if (payload.pairingId !== pairingId) throw new Error("bootstrap pairing id mismatch");
  return payload;
}
