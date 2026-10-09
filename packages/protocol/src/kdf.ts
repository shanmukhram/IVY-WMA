/**
 * Passphrase key derivation (Argon2id) and private-key at-rest encryption.
 *
 * The Mac keypair is DETERMINISTIC in the passphrase and a stored salt: the same
 * passphrase + salt always reproduces the same X25519 keypair. This is what makes
 * "re-pairing from passphrase" after a Mac restore work (Session Sync parity):
 * the restored Mac derives the identical key, so every object already wrapped to
 * the Mac's public key still decrypts.
 *
 * Device keypairs are random (see keys.ts) and live in DPAPI / Android Keystore;
 * they are not derived from a passphrase.
 */
import { argon2id } from "@noble/hashes/argon2.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { aesGcmEncrypt, aesGcmDecrypt } from "./aesgcm.js";
import { utf8, concatBytes, fromUtf8, toBase64, fromBase64 } from "./bytes.js";
import { randomBytes } from "./random.js";
import type { KeyPair } from "./keys.js";

/**
 * Argon2id parameters. Fixed and normative — the C# and Kotlin ports MUST use
 * these exact values or passphrase-derived keys and at-rest blobs will not match.
 *   memory     = 65536 KiB (64 MiB)
 *   iterations = 3
 *   parallelism= 1
 *   salt       = 16 bytes
 *   output     = 32 bytes
 */
export const ARGON2ID_PARAMS = {
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  saltLen: 16,
  outputLen: 32,
} as const;

export const MAC_SALT_LEN = ARGON2ID_PARAMS.saltLen;

function argon2(passphrase: string, salt: Uint8Array, dkLen: number): Uint8Array {
  if (salt.length !== ARGON2ID_PARAMS.saltLen) {
    throw new Error(`salt must be ${ARGON2ID_PARAMS.saltLen} bytes`);
  }
  return argon2id(utf8(passphrase), salt, {
    t: ARGON2ID_PARAMS.iterations,
    m: ARGON2ID_PARAMS.memoryKiB,
    p: ARGON2ID_PARAMS.parallelism,
    dkLen,
  });
}

/** Generate a fresh 16-byte salt for a new Mac identity. Store it (plaintext is fine). */
export function generateMacSalt(): Uint8Array {
  return randomBytes(ARGON2ID_PARAMS.saltLen);
}

/**
 * Derive the Mac's X25519 keypair from passphrase + salt. The 32-byte Argon2id
 * output is used directly as the X25519 secret scalar (clamping is applied inside
 * X25519). Deterministic.
 */
export function deriveMacKeyPair(passphrase: string, salt: Uint8Array): KeyPair {
  const secretKey = argon2(passphrase, salt, 32);
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

// At-rest private-key wrapping. The private key is NEVER serialized in the clear;
// the only on-disk form is this AES-256-GCM blob under an Argon2id-derived key.
// A separate salt from the identity salt is used so the at-rest key is independent.

const ATREST_MAGIC = utf8("IVYK1"); // key-at-rest container magic
const ATREST_AAD = utf8("ivy/v1/keystore");
const ATREST_NONCE_LEN = 12;

export interface SealedPrivateKey {
  /** container format version */
  v: 1;
  /** base64 Argon2id salt for the at-rest wrapping key */
  salt: string;
  /** base64 AES-GCM nonce */
  nonce: string;
  /** base64 (magic || ciphertext || tag) */
  blob: string;
}

/**
 * Encrypt a private key at rest under a passphrase. Returns a JSON-serializable
 * container. Uses its own fresh salt (independent of the identity salt).
 */
export function sealPrivateKey(secretKey: Uint8Array, passphrase: string): SealedPrivateKey {
  if (secretKey.length !== 32) throw new Error("secret key must be 32 bytes");
  const salt = randomBytes(ARGON2ID_PARAMS.saltLen);
  const key = argon2(passphrase, salt, 32);
  const nonce = randomBytes(ATREST_NONCE_LEN);
  const ct = aesGcmEncrypt(key, nonce, secretKey, ATREST_AAD);
  const blob = concatBytes(ATREST_MAGIC, ct);
  return { v: 1, salt: toBase64(salt), nonce: toBase64(nonce), blob: toBase64(blob) };
}

/** Decrypt a sealed private key. Throws on wrong passphrase or tampering. */
export function openPrivateKey(sealed: SealedPrivateKey, passphrase: string): Uint8Array {
  if (sealed.v !== 1) throw new Error(`unsupported keystore version ${sealed.v}`);
  const salt = fromBase64(sealed.salt);
  const nonce = fromBase64(sealed.nonce);
  const blob = fromBase64(sealed.blob);
  const magic = blob.subarray(0, ATREST_MAGIC.length);
  if (fromUtf8(magic) !== fromUtf8(ATREST_MAGIC)) throw new Error("bad keystore magic");
  const ct = blob.subarray(ATREST_MAGIC.length);
  const key = argon2(passphrase, salt, 32);
  return aesGcmDecrypt(key, nonce, ct, ATREST_AAD);
}
