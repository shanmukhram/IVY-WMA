/**
 * Worker thread for the Argon2id work of the key store (64 MiB, t=3: ~0.5 s of CPU).
 * Runs one operation from `workerData`, posts the result once and exits, so an
 * unlock never blocks the service's event loop. Secret bytes are zeroed here after
 * they are posted (postMessage copies them).
 */
import { parentPort, workerData } from "node:worker_threads";
import { runKdfOp, type KdfOp } from "./kdf-ops.ts";

const op = workerData as KdfOp;
try {
  const { result, secrets } = runKdfOp(op);
  parentPort!.postMessage({ ok: true, result });
  for (const s of secrets) s.fill(0);
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message });
}
