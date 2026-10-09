/**
 * Randomness indirection.
 *
 * All protocol randomness (ephemeral X25519 secret keys, content keys, GCM
 * nonces, oids, pairing secrets) flows through `randomBytes` here. Production
 * code uses Node's CSPRNG. Tests and the vector generator install a
 * deterministic source via `setRandomSource` so outputs are byte-for-byte
 * reproducible. This is the ONLY approved test injection point for randomness.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";

export type RandomSource = (n: number) => Uint8Array;

const defaultSource: RandomSource = (n: number) => new Uint8Array(nodeRandomBytes(n));

let current: RandomSource = defaultSource;

export function randomBytes(n: number): Uint8Array {
  const out = current(n);
  if (out.length !== n) {
    throw new Error(`random source returned ${out.length} bytes, expected ${n}`);
  }
  return out;
}

/** Install a deterministic random source (TEST / vector generation ONLY). */
export function setRandomSource(src: RandomSource): void {
  current = src;
}

/** Restore the production CSPRNG source. */
export function resetRandomSource(): void {
  current = defaultSource;
}

/**
 * A deterministic counter-based source for tests: emits bytes derived from a
 * seed so each requested block is distinct and reproducible. NOT for production.
 */
export function makeSequentialSource(seed = 0): RandomSource {
  let counter = seed;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      // simple reproducible LCG byte stream
      counter = (counter * 1103515245 + 12345) & 0x7fffffff;
      out[i] = (counter >>> 16) & 0xff;
    }
    return out;
  };
}

/** A source that replays a fixed queue of byte blocks, then throws. For vectors. */
export function makeScriptedSource(blocks: Uint8Array[]): RandomSource {
  const queue = [...blocks];
  return (n: number) => {
    const next = queue.shift();
    if (!next) throw new Error("scripted random source exhausted");
    if (next.length !== n) {
      throw new Error(`scripted block length ${next.length} != requested ${n}`);
    }
    return next;
  };
}
