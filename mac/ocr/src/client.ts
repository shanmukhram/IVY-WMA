import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { ensureBinary } from "./binary.js";
import { OcrError } from "./errors.js";
import type { CreateOcrOptions, OcrClient, OcrResult, OcrStats, RecognizeOptions, ThumbResult } from "./types.js";

type Reply = Record<string, unknown>;

interface Job {
  id: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  attempts: number;
  path: string | undefined;
  resolve: (v: Reply) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

const CRASH_LOOP_LIMIT = 5;

function setRef(c: ChildProcessWithoutNullStreams, on: boolean): void {
  for (const s of [c, c.stdin, c.stdout, c.stderr] as unknown as Array<{ ref?: () => void; unref?: () => void }>) {
    if (on) s.ref?.();
    else s.unref?.();
  }
}

/**
 * Spawns one warm `ivy-ocr` helper (lazily, on first request) and multiplexes requests over it.
 * - at most `concurrency` requests in flight; the rest queue in order
 * - each in-flight request times out after `timeoutMs` (the helper is then killed and restarted,
 *   other in-flight requests are re-sent)
 * - if the helper dies, in-flight requests are retried on a fresh helper up to `maxAttempts`
 * - an idle helper does not keep the Node event loop alive
 */
export function createOcr(options: CreateOcrOptions = {}): OcrClient {
  const concurrency = Math.min(32, Math.max(1, Math.floor(options.concurrency ?? 4)));
  const defaultTimeout = options.timeoutMs ?? 60_000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const log = options.onLog ?? (() => {});

  const queue: Job[] = [];
  const inflight = new Map<string, Job>();
  const dead = new WeakSet<ChildProcessWithoutNullStreams>();
  const stderrTail: string[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  let starting: Promise<void> | undefined;
  let binary: Promise<string> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let seq = 0;
  let spawns = 0;
  let completed = 0;
  let failed = 0;
  let consecutiveCrashes = 0;

  function fail(job: Job, err: Error): void {
    failed++;
    job.reject(err);
  }

  function getBinary(): Promise<string> {
    binary ??= ensureBinary({ binaryPath: options.binaryPath, autoBuild: options.autoBuild, onLog: log }).catch((err) => {
      binary = undefined; // allow a later retry (e.g. toolchain installed meanwhile)
      throw err;
    });
    return binary;
  }

  function updateRef(): void {
    if (child) setRef(child, closed || inflight.size > 0 || queue.length > 0);
  }

  function spawnChild(bin: string): void {
    const c = spawn(bin, ["--workers", String(concurrency)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });
    spawns++;
    child = c;
    if (spawns > 1) log(`[mac-ocr] restarted ivy-ocr (pid ${c.pid ?? "?"}, restart #${spawns - 1})`);
    c.stdin.on("error", () => {
      /* EPIPE when the helper dies; the exit handler deals with it */
    });
    createInterface({ input: c.stdout }).on("line", (line) => onLine(c, line));
    createInterface({ input: c.stderr }).on("line", (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
      log(`[ivy-ocr] ${line}`);
    });
    c.on("error", (err) => retire(c, `failed to run (${err.message})`, true));
    c.on("close", (code, signal) => retire(c, `exited (code ${code ?? "null"}, signal ${signal ?? "none"})`, true));
  }

  function ensureChild(): Promise<void> {
    if (child) return Promise.resolve();
    starting ??= (async () => {
      const bin = await getBinary();
      if (!closed && !child) spawnChild(bin);
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  }

  function pump(): void {
    if (queue.length === 0) {
      updateRef();
      return;
    }
    if (!child) {
      ensureChild().then(pump, (err: unknown) => {
        const e = err instanceof OcrError ? err : new OcrError("internal", String(err));
        for (const j of queue.splice(0)) fail(j, e);
      });
      return;
    }
    const c = child;
    while (inflight.size < concurrency && queue.length > 0) {
      // Requests that were in flight during a crash are suspects: re-send each one alone, so a
      // poison input only burns its own attempts and not those of innocent neighbours.
      if (queue[0]!.attempts > 0 && inflight.size > 0) break;
      if (inflight.size > 0 && [...inflight.values()].some((j) => j.attempts > 0)) break;
      const job = queue.shift()!;
      inflight.set(job.id, job);
      job.timer = setTimeout(() => onTimeout(job), job.timeoutMs);
      c.stdin.write(`${JSON.stringify({ ...job.payload, id: job.id })}\n`);
    }
    updateRef();
  }

  function onLine(c: ChildProcessWithoutNullStreams, line: string): void {
    if (dead.has(c)) return;
    let msg: Reply;
    try {
      msg = JSON.parse(line) as Reply;
    } catch {
      log(`[mac-ocr] ignoring non-JSON helper output: ${line.slice(0, 200)}`);
      return;
    }
    const id = msg.id;
    const job = typeof id === "string" ? inflight.get(id) : undefined;
    if (!job) {
      if (typeof msg.error === "string") log(`[mac-ocr] helper error without request: ${msg.error}`);
      return;
    }
    inflight.delete(job.id);
    clearTimeout(job.timer);
    consecutiveCrashes = 0;
    if (typeof msg.error === "string") {
      fail(job, new OcrError(typeof msg.code === "string" ? msg.code : "internal", msg.error, job.path));
    } else {
      completed++;
      job.resolve(msg);
    }
    pump();
  }

  function onTimeout(job: Job): void {
    if (inflight.get(job.id) !== job) return;
    inflight.delete(job.id);
    fail(job, new OcrError("timeout", `ivy-ocr did not answer within ${job.timeoutMs} ms`, job.path));
    log(`[mac-ocr] request ${job.id} (${job.path ?? "?"}) timed out; restarting helper`);
    // The helper may be wedged on this input: replace it. Other in-flight work is re-sent, uncounted.
    if (child) retire(child, "killed after a request timeout", false);
  }

  /** Takes a helper out of service and re-queues (or fails) whatever it was working on. */
  function retire(c: ChildProcessWithoutNullStreams, reason: string, crashed: boolean): void {
    if (dead.has(c)) return;
    dead.add(c);
    if (child === c) child = undefined;
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");

    const retry: Job[] = [];
    for (const job of inflight.values()) {
      clearTimeout(job.timer);
      if (crashed) job.attempts++;
      if (job.attempts >= maxAttempts || (closed && crashed)) {
        const tail = stderrTail.length ? ` stderr: ${stderrTail.slice(-5).join(" | ")}` : "";
        fail(job, new OcrError("process_crashed", `ivy-ocr ${reason} while processing this request (attempt ${job.attempts}/${maxAttempts}).${tail}`, job.path));
      } else {
        retry.push(job);
      }
    }
    inflight.clear();
    queue.unshift(...retry);

    if (closed) return;
    if (crashed && reason.startsWith("exited")) log(`[mac-ocr] ivy-ocr ${reason}`);
    if (crashed) consecutiveCrashes++;
    if (consecutiveCrashes >= CRASH_LOOP_LIMIT) {
      const e = new OcrError("crash_loop", `ivy-ocr died ${consecutiveCrashes} times in a row without answering; giving up on queued requests (last: ${reason}).`);
      for (const j of queue.splice(0)) fail(j, e);
      consecutiveCrashes = 0;
      return;
    }
    if (queue.length > 0) {
      const delay = consecutiveCrashes > 1 ? 100 * consecutiveCrashes : 0;
      if (delay) setTimeout(pump, delay);
      else pump();
    }
  }

  function request(payload: Record<string, unknown>, path?: string, timeoutMs?: number): Promise<Reply> {
    if (closed) return Promise.reject(new OcrError("closed", "OCR client is closed", path));
    return new Promise<Reply>((resolve, reject) => {
      queue.push({ id: `r${++seq}`, payload, timeoutMs: timeoutMs ?? defaultTimeout, attempts: 0, path, resolve, reject });
      pump();
    });
  }

  function absPath(p: unknown, what: string): string {
    if (typeof p !== "string" || p.length === 0) throw new OcrError("bad_request", `${what} must be a non-empty string`);
    return resolvePath(p);
  }

  return {
    async recognize(path: string, opts: RecognizeOptions = {}): Promise<OcrResult> {
      const abs = absPath(path, "path");
      const payload: Record<string, unknown> = { op: "recognize", path: abs };
      if (opts.languages?.length) payload.languages = opts.languages;
      if (opts.thumb) {
        payload.thumb = {
          path: absPath(opts.thumb.path, "thumb.path"),
          maxEdge: opts.thumb.maxEdge ?? 256,
          ...(opts.thumb.quality !== undefined ? { quality: opts.thumb.quality } : {}),
        };
      }
      const { id: _id, ok: _ok, ...rest } = await request(payload, abs, opts.timeoutMs);
      return rest as unknown as OcrResult;
    },

    async thumbnail(path: string, out: string, maxEdge = 256): Promise<ThumbResult> {
      const abs = absPath(path, "path");
      const r = await request({ op: "recognize", path: abs, ocr: false, thumb: { path: absPath(out, "out"), maxEdge } }, abs);
      if (typeof r.thumbError === "string") throw new OcrError("thumb_failed", r.thumbError, abs);
      return r.thumb as ThumbResult;
    },

    async ping() {
      const r = await request({ op: "ping" });
      return { version: String(r.version), pid: Number(r.pid), readTypes: (r.readTypes as string[]) ?? [] };
    },

    raw(payload, opts) {
      return request(payload, typeof payload.path === "string" ? payload.path : undefined, opts?.timeoutMs);
    },

    close(): Promise<void> {
      closing ??= (async () => {
        closed = true;
        for (const j of queue.splice(0)) fail(j, new OcrError("closed", "OCR client closed before the request was sent", j.path));
        await starting?.catch(() => {});
        const c = child;
        if (!c || dead.has(c)) return;
        setRef(c, true);
        await new Promise<void>((res) => {
          const safety = setTimeout(() => c.kill("SIGKILL"), defaultTimeout + 5_000);
          c.once("close", () => {
            clearTimeout(safety);
            res();
          });
          c.stdin.end(); // helper finishes in-flight work, then exits 0
        });
      })();
      return closing;
    },

    get pid() {
      return child?.pid;
    },

    stats(): OcrStats {
      return {
        pid: child?.pid,
        restarts: Math.max(0, spawns - 1),
        queued: queue.length,
        inFlight: inflight.size,
        completed,
        failed,
      };
    },
  };
}
