/**
 * X25519 key material and human-comparable fingerprints.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "./random.js";
import { toHex, fromBase64 } from "./bytes.js";

export const X25519_KEY_LEN = 32;

export interface KeyPair {
  /** 32-byte X25519 secret scalar. Never serialize this unencrypted. */
  secretKey: Uint8Array;
  /** 32-byte X25519 public key. */
  publicKey: Uint8Array;
}

/** Generate a random X25519 keypair (used for device keys: Windows DPAPI / Android Keystore). */
export function generateKeyPair(): KeyPair {
  const secretKey = randomBytes(X25519_KEY_LEN);
  const publicKey = publicKeyFromSecret(secretKey);
  return { secretKey, publicKey };
}

/** Derive the public key for a given 32-byte secret scalar. */
export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== X25519_KEY_LEN) throw new Error("secret key must be 32 bytes");
  return x25519.getPublicKey(secretKey);
}

/**
 * Fingerprint of a public key: SHA-256(publicKey), first 8 bytes, uppercase hex,
 * grouped as XXXX-XXXX-XXXX-XXXX. Short enough to read aloud and compare on both
 * screens during pairing. Deterministic and identical across all ports.
 */
export function fingerprint(publicKey: Uint8Array): string {
  if (publicKey.length !== X25519_KEY_LEN) throw new Error("public key must be 32 bytes");
  const digest = sha256(publicKey);
  const hex = toHex(digest.subarray(0, 8)).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

/** Fingerprint from a base64-encoded public key (as carried in pairing payloads). */
export function fingerprintFromB64(publicKeyB64: string): string {
  return fingerprint(fromBase64(publicKeyB64));
}
