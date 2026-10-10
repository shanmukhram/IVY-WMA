/**
 * Settings sealed under the Mac identity key (R2 endpoint and tokens). The key is
 * HKDF-SHA256(identity secret, salt "ivy/mac/settings", info "IVY1 settings v1"),
 * so the values are unreadable while the vault is locked and need no extra
 * passphrase. Stored in the `settings` table as JSON { v, nonce, ct }.
 */
import { hkdfSync, randomBytes } from "node:crypto";
import { aesGcmDecrypt, aesGcmEncrypt, fromBase64, toBase64, utf8, fromUtf8 } from "@ivy/protocol";
import type { DB } from "../db/index.ts";
import { getSetting, setSetting } from "../db/index.ts";

function settingsKey(secret: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, utf8("ivy/mac/settings"), utf8("IVY1 settings v1"), 32));
}

export function writeSealed(db: DB, secret: Uint8Array, name: string, value: unknown): void {
  const nonce = new Uint8Array(randomBytes(12));
  const ct = aesGcmEncrypt(settingsKey(secret), nonce, utf8(JSON.stringify(value)), utf8(`ivy/v1/settings/${name}`));
  setSetting(db, `sealed:${name}`, JSON.stringify({ v: 1, nonce: toBase64(nonce), ct: toBase64(ct) }));
}

export function readSealed<T>(db: DB, secret: Uint8Array, name: string): T | undefined {
  const raw = getSetting(db, `sealed:${name}`);
  if (!raw) return undefined;
  const s = JSON.parse(raw) as { v: number; nonce: string; ct: string };
  if (s.v !== 1) throw new Error(`unsupported sealed setting version ${s.v}`);
  const pt = aesGcmDecrypt(settingsKey(secret), fromBase64(s.nonce), fromBase64(s.ct), utf8(`ivy/v1/settings/${name}`));
  return JSON.parse(fromUtf8(pt)) as T;
}

export function hasSealed(db: DB, name: string): boolean {
  return getSetting(db, `sealed:${name}`) !== undefined;
}
