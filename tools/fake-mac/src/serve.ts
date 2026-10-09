/**
 * `serve`: the S3 mock with the four ivy-* buckets and a scope policy, a
 * persistent Mac identity, a fresh pairing bootstrap, and the ingest loop.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { startMock } from "@ivy/s3-mock";
import type { MockServer, Policy } from "@ivy/s3-mock";
import {
  encodePairingString, encryptPairingBootstrap, newPairingId, newPairingSecret, pairingBootstrapKey, toBase64, utf8,
} from "@ivy/protocol";
import type { PairingPayload } from "@ivy/protocol";
import { Bucket } from "./s3.ts";
import {
  loadOrCreateIdentity, paths, readState, writeState, type MacIdentity, type Role, type State,
} from "./local.ts";
import { Ingestor, type IngestResult } from "./ingest.ts";

export const ROLES: Role[] = ["windows", "android"];
export const ALL_BUCKETS = ["ivy-up-windows", "ivy-up-android", "ivy-cmd-windows", "ivy-cmd-android"];
export const bucketsFor = (role: Role) => ({ up: `ivy-up-${role}`, cmd: `ivy-cmd-${role}` });

const UP_OPS = ["PutObject", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload"] as const;
const CMD_OPS = ["ListObjectsV2", "GetObject", "HeadObject"] as const;

const keyId = (token: string) => token.slice(0, token.indexOf(":"));

/** up: write-only on ivy-up-<role>; cmd: read-only on ivy-cmd-<role>; mac: everything. */
export function scopePolicy(state: State): Policy {
  return {
    [keyId(state.tokens.up)]: { bucket: state.buckets.up, operations: [...UP_OPS] },
    [keyId(state.tokens.cmd)]: { bucket: state.buckets.cmd, operations: [...CMD_OPS] },
    [keyId(state.tokens.mac)]: { bucket: "*", operations: ["*"] },
  };
}

export interface ServeOptions {
  root: string;
  role?: Role;
  passphrase: string;
  port?: number;
  /** bind address; default 127.0.0.1. Use 0.0.0.0 to reach it from another machine. */
  host?: string;
  /** endpoint advertised in the pairing string; default derived from host/port */
  publicUrl?: string;
  /** pairing code lifetime; default 15 min */
  pairTtlMs?: number;
  /** ingest poll interval; 0 disables the timer (call ingestOnce yourself). Default 5000. */
  intervalMs?: number;
  keepObjects?: boolean;
  log?: (line: string) => void;
}

export interface ServeHandle {
  endpoint: string;
  role: Role;
  pairingString: string;
  pairingId: string;
  macFingerprint: string;
  identity: MacIdentity;
  state: State;
  mock: MockServer;
  ingestOnce(): Promise<IngestResult>;
  stop(): Promise<void>;
}

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

const newToken = (id: string) => `${id}:${randomBytes(20).toString("hex")}`;

export async function startServe(o: ServeOptions): Promise<ServeHandle> {
  const role = o.role ?? "windows";
  if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(", ")}`);
  const log = o.log ?? ((l: string) => console.log(l));
  const p = paths(o.root);
  mkdirSync(o.root, { recursive: true });

  const identity = loadOrCreateIdentity(o.root, o.passphrase);
  const prior = readState(o.root);
  if (prior && prior.role !== role) throw new Error(`${o.root} already serves role ${prior.role}; use a separate --root per role`);
  const state: State = prior ?? {
    v: 1, endpoint: "", role, buckets: bucketsFor(role),
    tokens: { up: newToken(`up-${role}`), cmd: newToken(`cmd-${role}`), mac: newToken("mac") },
    pairings: [], devices: [], blobHints: {},
  };

  const host = o.host ?? "127.0.0.1";
  const mock = await startMock({ root: p.s3, port: o.port ?? 9000, host, policy: scopePolicy(state), buckets: ALL_BUCKETS });
  const wildcard = host === "0.0.0.0" || host === "::";
  const endpoint = (o.publicUrl ?? (wildcard ? `http://${lanAddress() ?? "127.0.0.1"}:${mock.port}` : mock.url)).replace(/\/+$/, "");
  state.endpoint = wildcard ? `http://127.0.0.1:${mock.port}` : mock.url; // what the local CLI commands talk to
  state.publicEndpoint = endpoint; // what the device is told
  writeState(o.root, state);

  const up = new Bucket(state.endpoint, state.buckets.up, state.tokens.mac);
  const cmd = new Bucket(state.endpoint, state.buckets.cmd, state.tokens.mac);

  // a fresh code per start; any older code that was never used is invalidated (its bootstrap deleted)
  for (const old of state.pairings.filter((x) => x.status === "pending")) {
    await cmd.delete(pairingBootstrapKey(old.pairingId));
    old.status = "invalidated";
  }
  const pairingId = newPairingId();
  const secret = newPairingSecret();
  const exp = Date.now() + (o.pairTtlMs ?? 15 * 60_000);
  const sealed = encryptPairingBootstrap({ v: 1, upBucket: state.buckets.up, upWriteToken: state.tokens.up, pairingId }, secret);
  await cmd.put(pairingBootstrapKey(pairingId), utf8(JSON.stringify(sealed)));
  state.pairings.push({ pairingId, role, createdAt: new Date().toISOString(), exp, status: "pending" });
  writeState(o.root, state);

  const payload: PairingPayload = {
    v: 1, r2Endpoint: endpoint, role, cmdBucket: state.buckets.cmd, upBucket: state.buckets.up,
    cmdReadToken: state.tokens.cmd, macPublicKey: toBase64(identity.publicKey), macFingerprint: identity.fingerprint,
    pairingId, secret: toBase64(secret), exp,
  };
  const pairingString = encodePairingString(payload);

  const ingestor = new Ingestor({ root: o.root, state, identity, up, cmd, log, keepObjects: o.keepObjects });
  let running: Promise<IngestResult> | null = null;
  const ingestOnce = () => {
    // never overlap passes (a slow blob must not be ingested twice)
    running ??= ingestor.ingestOnce().finally(() => { running = null; });
    return running;
  };

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const interval = o.intervalMs ?? 5000;
  if (interval > 0) {
    const tick = async () => {
      try { await ingestOnce(); } catch (e) { log(`ERROR ingest pass failed: ${(e as Error).message}`); }
      if (!stopped) timer = setTimeout(tick, interval);
    };
    timer = setTimeout(tick, 0);
  }

  return {
    endpoint, role, pairingString, pairingId, macFingerprint: identity.fingerprint, identity, state, mock, ingestOnce,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => undefined);
      up.close(); cmd.close();
      await mock.stop();
    },
  };
}
