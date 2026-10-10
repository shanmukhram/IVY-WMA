/**
 * Runs key-store Argon2id work on a worker thread (one short-lived worker per
 * operation), so deriving or opening the Mac key never blocks HTTP, WebSocket or
 * ingest work on the main thread. If a worker cannot be started at all, the
 * operation runs in-thread instead (slower to respond, same result).
 */
import { Worker } from "node:worker_threads";
import { runKdfOp, type KdfOp, type KdfResult } from "./kdf-ops.ts";

const WORKER_URL = new URL("./kdf-worker.ts", import.meta.url);

export class KdfFailure extends Error {}

export function runKdf<T extends KdfResult>(op: KdfOp): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, { workerData: op });
    } catch {
      try { resolve(runKdfOp(op).result as T); } catch (e) { reject(new KdfFailure((e as Error).message)); }
      return;
    }
    let settled = false;
    worker.once("message", (m: { ok: boolean; result?: T; error?: string }) => {
      settled = true;
      if (m.ok) resolve(m.result as T);
      else reject(new KdfFailure(m.error ?? "key derivation failed"));
    });
    worker.once("error", (e: Error) => {
      if (settled) return;
      settled = true;
      // the worker could not load (no module support for workers here): do the work in-thread
      try { resolve(runKdfOp(op).result as T); } catch (e2) { reject(new KdfFailure((e2 as Error).message || e.message)); }
    });
    worker.once("exit", (code) => {
      if (!settled) { settled = true; reject(new KdfFailure(`key derivation worker exited (${code})`)); }
    });
  });
}
