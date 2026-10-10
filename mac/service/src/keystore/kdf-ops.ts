/** The Argon2id-backed key store operations, shared by the worker and the in-thread fallback. */
import { deriveMacKeyPair, openPrivateKey, sealPrivateKey } from "@ivy/protocol";
import type { SealedPrivateKey } from "@ivy/protocol";

export type KdfOp =
  | { op: "derive"; passphrase: string; salt: Uint8Array }
  | { op: "seal"; secretKey: Uint8Array; passphrase: string }
  | { op: "open"; sealed: SealedPrivateKey; passphrase: string }
  /** test hook: occupy the worker for `ms` without touching keys */
  | { op: "sleep"; ms: number };

export type KdfResult =
  | { secretKey: Uint8Array; publicKey: Uint8Array }
  | { sealed: SealedPrivateKey }
  | { secretKey: Uint8Array }
  | { slept: number };

/** Runs one operation synchronously. `secrets` are buffers the caller zeroes once the result is copied out. */
export function runKdfOp(op: KdfOp): { result: KdfResult; secrets: Uint8Array[] } {
  switch (op.op) {
    case "derive": {
      const kp = deriveMacKeyPair(op.passphrase, op.salt);
      return { result: { secretKey: kp.secretKey, publicKey: kp.publicKey }, secrets: [kp.secretKey] };
    }
    case "seal":
      return { result: { sealed: sealPrivateKey(op.secretKey, op.passphrase) }, secrets: [op.secretKey] };
    case "open": {
      const sk = openPrivateKey(op.sealed, op.passphrase);
      return { result: { secretKey: sk }, secrets: [sk] };
    }
    case "sleep": {
      const end = Date.now() + op.ms;
      while (Date.now() < end) { /* busy, like Argon2id */ }
      return { result: { slept: op.ms }, secrets: [] };
    }
  }
}
