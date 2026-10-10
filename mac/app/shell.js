/**
 * Plain-Node helpers for the Electron shell (no Electron imports, so they are unit-testable):
 * resolve the configuration, start the service child process, wait for health, stop it.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..", "..");

/**
 * IVY_DATA_DIR    data directory (default <repo>/data)
 * IVY_PORT        service port (default 4777)
 * IVY_NODE        node binary used to run the service from source (default "node" on PATH)
 * IVY_SERVICE_CMD a prebuilt service executable to run instead of `node mac/service/src/main.ts`
 * IVY_STATIC_DIR  UI directory (default mac/ui/dist)
 */
export function config(env = process.env) {
  const port = Number(env.IVY_PORT ?? 4777);
  const dataDir = resolve(env.IVY_DATA_DIR ?? join(REPO, "data"));
  const staticDir = resolve(env.IVY_STATIC_DIR ?? join(REPO, "mac", "ui", "dist"));
  const args = ["--data", dataDir, "--port", String(port), "--static", staticDir];
  const command = env.IVY_SERVICE_CMD
    ? { cmd: env.IVY_SERVICE_CMD, args }
    : { cmd: env.IVY_NODE ?? "node", args: [join(REPO, "mac", "service", "src", "main.ts"), ...args] };
  return { port, dataDir, staticDir, url: `http://127.0.0.1:${port}`, tokenPath: join(dataDir, "session.token"), command };
}

export async function healthy(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.service === "@ivy/mac-service";
  } catch { return false; }
}

export async function waitForHealth(url, child, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await healthy(url)) return;
    if (child && child.exitCode !== null) throw new Error(`the service exited with code ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the service did not become healthy at ${url} within ${timeoutMs} ms`);
}

export function startService(cfg, log = (s) => process.stdout.write(s)) {
  const child = spawn(cfg.command.cmd, cfg.command.args, { cwd: REPO, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b) => log(`[service] ${b}`));
  child.stderr.on("data", (b) => log(`[service] ${b}`));
  return child;
}

/** SIGTERM, then SIGKILL after `graceMs`. Resolves when the child has exited. */
export function stopService(child, graceMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => { clearTimeout(t); res(); });
    child.kill("SIGTERM");
  });
}

export const readToken = (cfg) => readFileSync(cfg.tokenPath, "utf8").trim();
