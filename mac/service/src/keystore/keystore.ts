/**
 * Mac identity key store (PRD S8, PROTOCOL §3.1 / §3.3).
 *
 * - The identity is an X25519 keypair DERIVED from the passphrase and a 16-byte
 *   identity salt with Argon2id (64 MiB, t=3, p=1, 32 bytes; the protocol
 *   package's exact parameters). Same passphrase + same salt = same key, so a
 *   restored Mac decrypts everything already wrapped to it and paired devices
 *   keep working.
 * - At rest the private key exists only as the §3.3 sealed blob (AES-256-GCM
 *   under a second Argon2id key with its own salt). `identity.json` holds the
 *   identity salt (not secret), the public key, the fingerprint, and that blob.
 * - After unlock the private key lives in memory only; it is zeroed on lock,
 *   on demand or after the idle period (default 30 minutes).
 * - Changing the passphrase re-seals the SAME key under the new passphrase. The
 *   identity does not change, so devices stay paired. Consequence: after a change
 *   the salt alone re-derives the identity only with the ORIGINAL passphrase;
 *   with the new passphrase you need the whole identity.json. `derivedFrom`
 *   records which case applies so the UI can say so.
 */
import {
  deriveMacKeyPair, fingerprint, fromBase64, generateMacSalt, openPrivateKey, publicKeyFromSecret,
  sealPrivateKey, toBase64, MAC_SALT_LEN, ARGON2ID_PARAMS,
} from "@ivy/protocol";
import type { SealedPrivateKey } from "@ivy/protocol";
import { readJsonFile, writeFileAtomic } from "../util/fsx.ts";
import { nowIso } from "../util/time.ts";

export type KeystoreState = "uninitialized" | "locked" | "unlocked";

export interface IdentityFile {
  v: 1;
  /** base64 16-byte identity salt (PROTOCOL §3.1). Back this up. */
  salt: string;
  kdf?: typeof ARGON2ID_PARAMS & { variant: "argon2id"; version: 19 };
  publicKey?: string;
  fingerprint?: string;
  /** §3.3 sealed private key; absent in a salt-only restore file */
  sealed?: SealedPrivateKey;
  createdAt?: string;
  passphraseChangedAt?: string;
  /** "current-passphrase": salt + current passphrase re-derive the key; "original-passphrase": only the first one does */
  derivedFrom?: "current-passphrase" | "original-passphrase";
}

export class KeystoreError extends Error {
  readonly code: "locked" | "uninitialized" | "already_initialized" | "wrong_passphrase" | "weak_passphrase" | "bad_salt" | "cooldown" | "corrupt";
  constructor(code: KeystoreError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface KeystoreOptions {
  path: string;
  autoLockMinutes: number;
  onEvent?: (type: "keystore.initialized" | "keystore.unlocked" | "keystore.locked" | "keystore.passphrase_changed", data: Record<string, unknown>) => void;
  /** injectable clock (tests) */
  now?: () => number;
  minPassphraseLength?: number;
}

const MAX_FAILS_BEFORE_COOLDOWN = 5;
const COOLDOWN_MS = 30_000;

export class Keystore {
  private readonly o: KeystoreOptions;
  private secret: Uint8Array | null = null;
  private publicKey: Uint8Array | null = null;
  private lastActivity = 0;
  private autoLockMinutes: number;
  private timer: NodeJS.Timeout | undefined;
  private fails = 0;
  private cooldownUntil = 0;
  private lockedAt: string | null = null;
  private lockReason: string | null = null;

  constructor(o: KeystoreOptions) {
    this.o = o;
    this.autoLockMinutes = o.autoLockMinutes;
  }

  private now(): number { return this.o.now?.() ?? Date.now(); }
  private file(): IdentityFile | undefined { return readJsonFile<IdentityFile>(this.o.path); }

  state(): KeystoreState {
    if (this.secret) return "unlocked";
    return this.file()?.sealed ? "locked" : "uninitialized";
  }

  status() {
    const f = this.file();
    return {
      state: this.state(),
      fingerprint: f?.fingerprint ?? null,
      publicKey: f?.publicKey ?? null,
      saltPresent: !!f?.salt,
      derivedFrom: f?.derivedFrom ?? null,
      autoLockMinutes: this.autoLockMinutes,
      idleMs: this.secret ? this.now() - this.lastActivity : null,
      lockedAt: this.lockedAt,
      lockReason: this.lockReason,
      identityFile: this.o.path,
    };
  }

  isUnlocked(): boolean { return this.secret !== null; }

  /** The in-memory private key. Throws when locked. */
  secretKey(): Uint8Array {
    if (!this.secret) throw new KeystoreError("locked", "the vault is locked");
    return this.secret;
  }

  macPublicKey(): Uint8Array {
    if (this.publicKey) return this.publicKey;
    const f = this.file();
    if (!f?.publicKey) throw new KeystoreError("uninitialized", "no Mac identity yet");
    return fromBase64(f.publicKey);
  }

  macFingerprint(): string { return fingerprint(this.macPublicKey()); }

  /**
   * Create the identity. `saltB64` restores a Mac: the same passphrase and the
   * saved salt re-derive the same key. A salt-only identity.json (from a
   * backup) is used automatically.
   */
  initialize(passphrase: string, saltB64?: string): { fingerprint: string; restored: boolean } {
    this.checkPassphrase(passphrase);
    const existing = this.file();
    if (existing?.sealed) throw new KeystoreError("already_initialized", "the Mac identity already exists; unlock it instead");
    let salt: Uint8Array;
    let restored = false;
    const given = saltB64 ?? existing?.salt;
    if (given) {
      salt = decodeSalt(given);
      restored = true;
    } else {
      salt = generateMacSalt();
    }
    const kp = deriveMacKeyPair(passphrase, salt);
    const f: IdentityFile = {
      v: 1,
      salt: toBase64(salt),
      kdf: { ...ARGON2ID_PARAMS, variant: "argon2id", version: 19 },
      publicKey: toBase64(kp.publicKey),
      fingerprint: fingerprint(kp.publicKey),
      sealed: sealPrivateKey(kp.secretKey, passphrase),
      createdAt: nowIso(),
      derivedFrom: "current-passphrase",
    };
    writeFileAtomic(this.o.path, JSON.stringify(f, null, 2) + "\n");
    this.setUnlocked(kp.secretKey, kp.publicKey);
    this.o.onEvent?.("keystore.initialized", { fingerprint: f.fingerprint, restored });
    return { fingerprint: f.fingerprint!, restored };
  }

  unlock(passphrase: string): { fingerprint: string } {
    const f = this.file();
    if (!f?.sealed) throw new KeystoreError("uninitialized", "no Mac identity yet; initialize first");
    if (this.secret) return { fingerprint: f.fingerprint! };
    if (this.now() < this.cooldownUntil) throw new KeystoreError("cooldown", "too many wrong passphrases; wait a moment");
    let sk: Uint8Array;
    try {
      sk = openPrivateKey(f.sealed, passphrase);
    } catch {
      this.fails++;
      if (this.fails >= MAX_FAILS_BEFORE_COOLDOWN) { this.cooldownUntil = this.now() + COOLDOWN_MS; this.fails = 0; }
      throw new KeystoreError("wrong_passphrase", "wrong passphrase");
    }
    const pk = publicKeyFromSecret(sk);
    if (f.publicKey && toBase64(pk) !== f.publicKey) {
      sk.fill(0);
      throw new KeystoreError("corrupt", "identity.json: sealed key does not match the stored public key");
    }
    this.fails = 0;
    this.setUnlocked(sk, pk);
    this.o.onEvent?.("keystore.unlocked", { fingerprint: fingerprint(pk) });
    return { fingerprint: fingerprint(pk) };
  }

  lock(reason = "manual"): void {
    if (!this.secret) return;
    this.secret.fill(0);
    this.secret = null;
    this.lockedAt = nowIso();
    this.lockReason = reason;
    this.o.onEvent?.("keystore.locked", { reason });
  }

  /** Re-seal the same identity key under a new passphrase. Devices stay paired. */
  changePassphrase(current: string, next: string): { fingerprint: string } {
    this.checkPassphrase(next);
    const f = this.file();
    if (!f?.sealed) throw new KeystoreError("uninitialized", "no Mac identity yet");
    let sk: Uint8Array;
    try { sk = openPrivateKey(f.sealed, current); } catch { throw new KeystoreError("wrong_passphrase", "current passphrase is wrong"); }
    const updated: IdentityFile = {
      ...f,
      sealed: sealPrivateKey(sk, next),
      passphraseChangedAt: nowIso(),
      derivedFrom: "original-passphrase",
    };
    writeFileAtomic(this.o.path, JSON.stringify(updated, null, 2) + "\n");
    sk.fill(0); // the copy opened for the check; the unlocked key (if any) is a separate buffer
    this.touch();
    this.o.onEvent?.("keystore.passphrase_changed", { fingerprint: f.fingerprint });
    return { fingerprint: f.fingerprint! };
  }

  /** Record user activity (resets the idle timer). */
  touch(): void { this.lastActivity = this.now(); }

  setAutoLockMinutes(m: number): void {
    if (!Number.isFinite(m) || m < 0) throw new Error("autoLockMinutes must be >= 0");
    this.autoLockMinutes = m;
  }

  getAutoLockMinutes(): number { return this.autoLockMinutes; }

  /** Lock if idle longer than the auto-lock period. Returns true when it locked. */
  checkIdle(): boolean {
    if (!this.secret || this.autoLockMinutes <= 0) return false;
    if (this.now() - this.lastActivity >= this.autoLockMinutes * 60_000) {
      this.lock("idle");
      return true;
    }
    return false;
  }

  startAutoLock(everyMs = 15_000): void {
    this.stopAutoLock();
    this.timer = setInterval(() => this.checkIdle(), everyMs);
    this.timer.unref();
  }

  stopAutoLock(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private setUnlocked(sk: Uint8Array, pk: Uint8Array) {
    this.secret = sk;
    this.publicKey = pk;
    this.lockedAt = null;
    this.lockReason = null;
    this.touch();
  }

  private checkPassphrase(p: string) {
    const min = this.o.minPassphraseLength ?? 8;
    if (typeof p !== "string" || [...p].length < min) throw new KeystoreError("weak_passphrase", `passphrase must be at least ${min} characters`);
  }
}

function decodeSalt(s: string): Uint8Array {
  let b: Uint8Array;
  if (/^[0-9a-fA-F]{32}$/.test(s)) b = new Uint8Array(Buffer.from(s, "hex"));
  else b = fromBase64(s);
  if (b.length !== MAC_SALT_LEN) throw new KeystoreError("bad_salt", `identity salt must be ${MAC_SALT_LEN} bytes`);
  return b;
}
