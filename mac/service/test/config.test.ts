/**
 * Paths from flags and env resolve against the working directory (an absolute
 * root for @fastify/static), and the default UI is located relative to the package.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, defaultStaticDir } from "../src/config.ts";
import { tempDir, rm } from "./helpers/harness.ts";
import { abs } from "./helpers/paths.ts";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = ["IVY_DATA_DIR", "IVY_DB_PATH", "IVY_STATIC_DIR"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const clearEnv = () => { for (const k of ENV) delete process.env[k]; };

describe("poll interval", () => {
  it("defaults to 5 seconds and IVY_POLL_INTERVAL_MS overrides it", () => {
    const saved = process.env.IVY_POLL_INTERVAL_MS;
    try {
      delete process.env.IVY_POLL_INTERVAL_MS;
      expect(loadConfig({}, abs("/w")).pollIntervalMs).toBe(5000);
      process.env.IVY_POLL_INTERVAL_MS = "120000";
      expect(loadConfig({}, abs("/w")).pollIntervalMs).toBe(120000);
    } finally { if (saved === undefined) delete process.env.IVY_POLL_INTERVAL_MS; else process.env.IVY_POLL_INTERVAL_MS = saved; }
  });
});

describe("path resolution", () => {
  it("resolves relative --data, --db and --static against the working directory", () => {
    clearEnv();
    const cwd = abs("/tmp/ivy/mac/service");
    const c = loadConfig({ dataDir: "./data", dbPath: "db/v.db", staticDir: "../ui/dist" }, cwd);
    expect(c.dataDir).toBe(join(cwd, "data"));
    expect(c.dbPath).toBe(join(cwd, "db", "v.db"));
    expect(c.staticDir).toBe(join(cwd, "..", "ui", "dist"));
    expect(c.identityPath).toBe(join(cwd, "data", "identity.json"));
    expect(c.tokenPath).toBe(join(cwd, "data", "session.token"));
  });

  it("resolves the environment equivalents the same way", () => {
    process.env.IVY_DATA_DIR = "rel-data";
    process.env.IVY_DB_PATH = "./x/vault.db";
    process.env.IVY_STATIC_DIR = "../ui/dist";
    const cwd = abs("/srv/a/b");
    const c = loadConfig({}, cwd);
    expect(c).toMatchObject({ dataDir: join(cwd, "rel-data"), dbPath: join(cwd, "x", "vault.db"), staticDir: join(cwd, "..", "ui", "dist"), tokenPath: join(cwd, "rel-data", "session.token") });
  });

  it("flags beat env; derived paths follow the data directory; absolute paths are kept", () => {
    clearEnv();
    process.env.IVY_DATA_DIR = "/env/data";
    process.env.IVY_STATIC_DIR = "/env/ui";
    const w = abs("/w");
    const c = loadConfig({ dataDir: "d", staticDir: abs("/abs/ui") }, w);
    expect(c).toMatchObject({ dataDir: join(w, "d"), dbPath: join(w, "d", "vault.db"), staticDir: abs("/abs/ui") });
    delete process.env.IVY_DATA_DIR;
    expect(loadConfig({}, w).dataDir).toBe(join(w, "data"));
  });

  it("defaults to the built UI next to the package when mac/ui/dist/index.html exists, else the placeholder", () => {
    clearEnv();
    const root = tempDir("ivy-cfg-");
    try {
      const svcDir = join(root, "mac", "service");
      mkdirSync(svcDir, { recursive: true });
      expect(defaultStaticDir(svcDir)).toBe(join(svcDir, "public"));
      mkdirSync(join(root, "mac", "ui", "dist"), { recursive: true });
      writeFileSync(join(root, "mac", "ui", "dist", "index.html"), "<!doctype html>");
      expect(defaultStaticDir(svcDir)).toBe(join(root, "mac", "ui", "dist"));
      // the real package: whichever exists, always absolute and independent of cwd
      const d = loadConfig({}, "/somewhere/else").staticDir;
      expect(isAbsolute(d)).toBe(true);
      expect([join(pkg, "public"), resolve(pkg, "..", "ui", "dist")]).toContain(d);
    } finally { rm(root); }
  });
});

describe("README example: node src/main.ts --data ./data --static ../ui/dist", () => {
  it("starts from a relative cwd and serves the UI", async () => {
    const root = tempDir("ivy-main-");
    const cwd = join(root, "service");
    mkdirSync(join(root, "ui", "dist"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(root, "ui", "dist", "index.html"), "<!doctype html><title>relative ok</title>");
    const child = spawn(process.execPath, [join(pkg, "src", "main.ts"), "--data", "./data", "--port", "0", "--static", "../ui/dist", "--poll-ms", "0"], {
      cwd, env: { ...process.env, IVY_OCR: "0", IVY_THUMBNAILS: "0", IVY_STATIC_DIR: "", IVY_DATA_DIR: "", IVY_DB_PATH: "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      let out = "";
      const url = await new Promise<string>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`no listen line: ${out}`)), 30_000);
        child.stdout.on("data", (b) => { out += b; const m = /listening on (\S+)/.exec(out); if (m) { clearTimeout(t); res(m[1]!); } });
        child.stderr.on("data", (b) => { out += b; });
        child.on("exit", (code) => { clearTimeout(t); rej(new Error(`exited ${code}: ${out}`)); });
      });
      expect(existsSync(join(cwd, "data", "session.token"))).toBe(true);
      const r = await fetch(url + "/", { headers: { host: "127.0.0.1" } });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("relative ok");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      rm(root);
    }
  });
});
