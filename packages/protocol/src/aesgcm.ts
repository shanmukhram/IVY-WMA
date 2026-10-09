/**
 * AES-256-GCM primitive, backed by Node's built-in crypto. The ciphertext
 * layout produced here is `ciphertext || tag` (16-byte tag appended), matching
 * what the C# (System.Security.Cryptography.AesGcm) and Kotlin
 * (javax.crypto Cipher "AES/GCM/NoPadding") ports produce when they append the
 * tag. Nonces are always 12 bytes; the caller supplies them.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { concatBytes } from "./bytes.js";

export const GCM_NONCE_LEN = 12;
export const GCM_TAG_LEN = 16;
export const AES_KEY_LEN = 32;

export function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== AES_KEY_LEN) throw new Error("AES-256-GCM key must be 32 bytes");
  if (nonce.length !== GCM_NONCE_LEN) throw new Error("GCM nonce must be 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_LEN });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return concatBytes(new Uint8Array(ct), new Uint8Array(tag));
}

/**
 * Decrypts `ciphertext || tag`. Throws on any authentication failure (tampered
 * header/AAD/ciphertext, wrong key). Never returns partial plaintext.
 */
export function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== AES_KEY_LEN) throw new Error("AES-256-GCM key must be 32 bytes");
  if (nonce.length !== GCM_NONCE_LEN) throw new Error("GCM nonce must be 12 bytes");
  if (ciphertextAndTag.length < GCM_TAG_LEN) throw new Error("ciphertext too short");
  const split = ciphertextAndTag.length - GCM_TAG_LEN;
  const ct = ciphertextAndTag.subarray(0, split);
  const tag = ciphertextAndTag.subarray(split);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_LEN });
  decipher.setAAD(aad, { plaintextLength: ct.length });
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return new Uint8Array(pt);
}
