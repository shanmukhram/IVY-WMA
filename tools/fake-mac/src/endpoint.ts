/**
 * Run against the endpoint `serve` recorded in state.json. If nothing answers
 * there (serve is not running), open the same on-disk mock store in-process for
 * the duration of the call. Never do this while serve is running: the mock keeps
 * an in-memory index, so two processes on one store would diverge.
 */
import { startMock } from "@ivy/s3-mock";
import { paths, type State } from "./local.ts";
import { scopePolicy, ALL_BUCKETS } from "./serve.ts";

export async function reachable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch(url + "/", { signal: AbortSignal.timeout(timeoutMs) });
    return true; // any HTTP answer (even 403/501) means a server is there
  } catch {
    return false;
  }
}

export async function withEndpoint<T>(root: string, state: State, fn: (endpoint: string, live: boolean) => Promise<T>): Promise<T> {
  if (await reachable(state.endpoint)) return fn(state.endpoint, true);
  const mock = await startMock({ root: paths(root).s3, port: 0, policy: scopePolicy(state), buckets: ALL_BUCKETS });
  try { return await fn(mock.url, false); } finally { await mock.stop(); }
}
