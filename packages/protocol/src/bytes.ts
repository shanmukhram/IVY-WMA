/**
 * Byte and encoding helpers. All multi-byte integers in the IVY wire format are
 * big-endian. Strings are UTF-8. Binary blobs that must travel inside JSON use
 * standard base64; pairing strings and object ids use URL-safe / Crockford
 * alphabets as noted at each site.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new RangeError(`u32be out of range: ${n}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

export function readU32be(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset + offset, 4).getUint32(0, false);
}

export function u64be(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`u64be out of range: ${n}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, false);
  return out;
}

export function u48be(n: number): Uint8Array {
  // 48-bit big-endian (used for the timestamp half of an oid).
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff_ffff) {
    throw new RangeError(`u48be out of range: ${n}`);
  }
  const out = new Uint8Array(6);
  let v = n;
  for (let i = 5; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function toBase64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

export function fromBase64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Constant-time equality for fixed-length comparisons (tags, fingerprints). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// Crockford base32 alphabet (no I, L, O, U) — used for oid/ULID encoding.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode bytes as Crockford base32 (big-endian bit order), no padding. */
export function toCrockford(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Decode Crockford base32 (big-endian bit order) back to bytes. Reads 5 bits per
 * character, most-significant first, and emits whole bytes; trailing pad bits
 * that do not complete a byte are discarded. A 26-char oid yields its 16 bytes.
 */
export function fromCrockford(s: string): Uint8Array {
  let value = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase()) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new Error(`invalid Crockford character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
