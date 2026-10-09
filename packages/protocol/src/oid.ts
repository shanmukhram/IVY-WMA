/**
 * Object id (oid): a 128-bit, lexicographically time-ordered identifier, encoded
 * as 26 Crockford-base32 characters (ULID layout). The first 48 bits are the
 * capture time in milliseconds since the Unix epoch (big-endian); the remaining
 * 80 bits are random. Because the time is the high-order part and Crockford
 * base32 preserves byte order, sorting oids as strings sorts them by time — this
 * is what makes "list objects since the last marker" a simple key comparison.
 */
import { randomBytes } from "./random.js";
import { toCrockford, u48be, concatBytes } from "./bytes.js";

export const OID_LEN = 26;

/** Build an oid from an explicit time (ms) and 10 random bytes (injectable for vectors). */
export function makeOid(timeMs: number, random80: Uint8Array): string {
  if (random80.length !== 10) throw new Error("oid random part must be 10 bytes");
  const bytes = concatBytes(u48be(timeMs), random80); // 6 + 10 = 16 bytes
  return toCrockford(bytes); // 128 bits -> 26 chars
}

/** Generate a fresh oid for the current (or supplied) time. */
export function newOid(timeMs: number = Date.now()): string {
  return makeOid(timeMs, randomBytes(10));
}
