/**
 * Local (Mac-side) files under <root>. Plaintext is allowed here: this directory
 * stands in for the Mac, the only place that holds the private key.
 *
 *   mac-identity.json   Mac X25519 identity; secret sealed per PROTOCOL §3.3
 *   state.json          endpoint, tokens, pairings, paired devices (owned by `serve`)
 *   ledger.json         ingest ledger (owned by `serve`)
 *   commands/<oid>.json commands issued (written by request-file/rescan/config, updated by `serve`)
 *   received/<oid>.<ext> reassembled blob plaintext
 *   quarantine/         undecryptable / rejected objects
 *   s3/                 the S3 mock's storage root
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes as nodeRandom } from "node:crypto";
import {
  fingerprint, fromBase64, generateKeyPair, openPrivateKey, publicKeyFromSecret, sealPrivateKey, toBase64,
} from "@ivy/protocol";
import type { SealedPrivateKey } from "@ivy/protocol";

export type Role = "windows" | "android";

export const paths = (root: string) => ({
  root,
  identity: join(root, "mac-identity.json"),
  state: join(root, "state.json"),
  ledger: join(root, "ledger.json"),
  commands: join(root, "commands"),
  received: join(root, "received"),
  quarantine: join(root, "quarantine"),
  s3: join(root, "s3"),
});

/** Write JSON atomically (tmp + rename; rename replaces the target on Windows too). */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${nodeRandom(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

// ---------------------------------------------------------------- identity

export interface IdentityFile {
  v: 1;
  publicKey: string; // base64
  fingerprint: string;
  sealedSecret: SealedPrivateKey;
  createdAt: string;
}

export interface MacIdentity {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  fingerprint: string;
  created: boolean;
}

export function passphraseFrom(explicit: string | undefined): string {
  const p = explicit ?? process.env.IVY_FAKE_MAC_PASSPHRASE;
  if (!p) throw new Error("a passphrase is required: pass --passphrase or set IVY_FAKE_MAC_PASSPHRASE");
  return p;
}

/** Load the persistent Mac identity, or create one. Argon2id (64 MiB) runs once either way. */
export function loadOrCreateIdentity(root: string, passphrase: string): MacIdentity {
  const p = paths(root);
  const existing = readJson<IdentityFile>(p.identity);
  if (existing) {
    let secretKey: Uint8Array;
    try { secretKey = openPrivateKey(existing.sealedSecret, passphrase); }
    catch { throw new Error(`cannot unlock ${p.identity}: wrong passphrase or damaged file`); }
    const publicKey = publicKeyFromSecret(secretKey);
    if (toBase64(publicKey) !== existing.publicKey) throw new Error(`${p.identity}: public key does not match sealed secret`);
    return { publicKey, secretKey, fingerprint: fingerprint(publicKey), created: false };
  }
  const kp = generateKeyPair();
  const file: IdentityFile = {
    v: 1, publicKey: toBase64(kp.publicKey), fingerprint: fingerprint(kp.publicKey),
    sealedSecret: sealPrivateKey(kp.secretKey, passphrase), createdAt: new Date().toISOString(),
  };
  writeJson(p.identity, file);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey, fingerprint: file.fingerprint, created: true };
}

/** Public half only (no passphrase needed). */
export function readPublicIdentity(root: string): { publicKey: Uint8Array; fingerprint: string } {
  const f = readJson<IdentityFile>(paths(root).identity);
  if (!f) throw new Error(`no Mac identity under ${root}; run \`serve --root ${root}\` first`);
  return { publicKey: fromBase64(f.publicKey), fingerprint: f.fingerprint };
}

// ---------------------------------------------------------------- state

export interface Tokens { up: string; cmd: string; mac: string }

export interface PairingEntry {
  pairingId: string;
  role: Role;
  createdAt: string;
  exp: number;
  status: "pending" | "consumed" | "invalidated";
  deviceId?: string;
}

export interface DeviceEntry {
  deviceId: string;
  role: Role;
  pairingId: string;
  publicKey: string; // base64
  fingerprint: string;
  pairedAt: string;
  lastReportAt?: string;
}

export interface State {
  v: 1;
  /** endpoint the local CLI commands use (loopback) */
  endpoint: string;
  /** endpoint advertised to the device in the pairing string */
  publicEndpoint?: string;
  role: Role;
  buckets: { up: string; cmd: string };
  tokens: Tokens;
  pairings: PairingEntry[];
  devices: DeviceEntry[];
  /** blob oid -> file extension, learned from records that reference the blob */
  blobHints: Record<string, string>;
}

export function readState(root: string): State | undefined {
  return readJson<State>(paths(root).state);
}

export function requireState(root: string): State {
  const s = readState(root);
  if (!s) throw new Error(`no state under ${root}; run \`serve --root ${root}\` first`);
  return s;
}

export function writeState(root: string, s: State): void {
  writeJson(paths(root).state, s);
}

// ---------------------------------------------------------------- ledger

export type LedgerStatus = "committed" | "quarantined" | "rejected";

export interface LedgerEntry {
  key: string;
  kind: string;
  status: LedgerStatus;
  ingestedAt: string;
  size?: number;
  /** SHA-256 of the ciphertext as fetched; tells a harmless replay from an overwrite */
  ctSha256?: string;
  deviceId?: string;
  detail?: string;
  /** blobs: number of parts and where the plaintext went */
  parts?: number;
  sha256?: string;
  file?: string;
  /** single records: the decrypted, schema-validated record (Mac-side plaintext) */
  record?: unknown;
}

export function readLedger(root: string): LedgerEntry[] {
  return readJson<LedgerEntry[]>(paths(root).ledger) ?? [];
}

export function writeLedger(root: string, entries: LedgerEntry[]): void {
  writeJson(paths(root).ledger, entries);
}

// ---------------------------------------------------------------- commands

export interface CommandFile {
  oid: string;
  key: string;
  commandId: string;
  deviceId: string;
  role: Role;
  issuedAt: string;
  params: Record<string, unknown> & { type: string };
  status?: string;
  detail?: string;
  resultOid?: string;
  statusAt?: string;
  deletedFromBucket?: boolean;
}

export function writeCommand(root: string, c: CommandFile): void {
  writeJson(join(paths(root).commands, `${c.oid}.json`), c);
}

export function readCommands(root: string): CommandFile[] {
  const dir = paths(root).commands;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as CommandFile);
}
