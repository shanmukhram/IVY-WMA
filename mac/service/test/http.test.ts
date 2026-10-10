import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { makeService, tempDir, rm, api, PASS, TOKEN } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";

let svc: Service;
let dir: string;

beforeAll(async () => {
  dir = tempDir();
  const staticDir = join(dir, "ui");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>IVY UI</title>");
  writeFileSync(join(staticDir, "app.js"), "console.log(1)");
  svc = await makeService(dir, { staticDir, port: 0 });
});
afterAll(async () => { await svc.close(); rm(dir); });

describe("HTTP API guards", () => {
  it("health is open; everything else needs the session token", async () => {
    expect((await svc.app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1" } })).statusCode).toBe(200);
    expect((await svc.app.inject({ method: "GET", url: "/api/keystore", headers: { host: "127.0.0.1" } })).statusCode).toBe(401);
    expect((await api(svc, "GET", "/api/keystore", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await api(svc, "GET", "/api/keystore")).status).toBe(200);
  });

  it("refuses non-loopback Host headers (DNS rebinding) and cross-site origins", async () => {
    expect((await api(svc, "GET", "/api/health", undefined, { host: "evil.example:4777" })).status).toBe(421);
    expect((await api(svc, "GET", "/api/keystore", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await api(svc, "GET", "/api/keystore", undefined, { origin: "http://localhost:5173" })).status).toBe(200);
  });

  it("writes the token to data/session.token with owner-only permissions", async () => {
    const { statSync, readFileSync } = await import("node:fs");
    const d2 = tempDir();
    const s2 = await makeService(d2, {}, { token: undefined });
    try {
      const t = readFileSync(join(d2, "session.token"), "utf8").trim();
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      expect(t).toBe(s2.token);
      expect(statSync(join(d2, "session.token")).mode & 0o077).toBe(0);
    } finally { await s2.close(); rm(d2); }
  });

  it("while uninitialized or locked, data routes answer 423 and keystore routes work", async () => {
    expect((await api(svc, "GET", "/api/search?q=abc")).status).toBe(423);
    expect((await api(svc, "POST", "/api/keystore/initialize", { passphrase: "short" })).status).toBe(400);
    const init = await api(svc, "POST", "/api/keystore/initialize", { passphrase: PASS });
    expect(init.status).toBe(200);
    expect(init.json).toMatchObject({ state: "unlocked", fingerprint: expect.stringMatching(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/) });
    expect(init.json.saltBackup).toMatch(/identity\.json/);
    expect((await api(svc, "GET", "/api/coverage")).status).toBe(200);
    expect((await api(svc, "POST", "/api/keystore/lock")).json).toMatchObject({ state: "locked", locked: true, uiLocked: true, ingestRunning: true });
    expect((await api(svc, "GET", "/api/coverage")).status).toBe(423);
    expect((await api(svc, "POST", "/api/keystore/unlock", { passphrase: "wrong passphrase" })).status).toBe(401);
    expect((await api(svc, "POST", "/api/keystore/unlock", { passphrase: PASS })).json).toMatchObject({ state: "unlocked" });
  });

  it("changes the passphrase over the API without changing the fingerprint", async () => {
    const before = (await api(svc, "GET", "/api/keystore")).json.fingerprint;
    expect((await api(svc, "POST", "/api/keystore/change-passphrase", { current: PASS, next: "another long passphrase" })).json.fingerprint).toBe(before);
    await api(svc, "POST", "/api/keystore/lock");
    expect((await api(svc, "POST", "/api/keystore/unlock", { passphrase: "another long passphrase" })).json.fingerprint).toBe(before);
    expect((await api(svc, "PUT", "/api/keystore/settings", { autoLockMinutes: 5 })).json.autoLockMinutes).toBe(5);
  });

  it("R2 config is stored sealed and returned redacted", async () => {
    const put = await api(svc, "PUT", "/api/r2", { endpoint: "https://acct.r2.cloudflarestorage.com", macTokens: { all: "AKID:supersecretvalue" } });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.json)).not.toContain("supersecretvalue");
    const row = svc.ctx.db.prepare("SELECT value FROM settings WHERE key = 'sealed:r2'").get() as { value: string };
    expect(row.value).not.toContain("supersecretvalue");
    expect(row.value).not.toContain("AKID");
    expect((await api(svc, "PUT", "/api/r2", { endpoint: "not a url" })).status).toBe(400);
  });

  it("a browser can log in once with the token and then use a cookie", async () => {
    const r = await svc.app.inject({ method: "POST", url: "/api/session", payload: { token: TOKEN }, headers: { host: "localhost" } });
    expect(r.statusCode).toBe(200);
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    expect(String(r.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Strict/);
    const r2 = await svc.app.inject({ method: "GET", url: "/api/stats", headers: { host: "localhost", cookie } });
    expect(r2.statusCode).toBe(200);
  });

  it("serves the UI from the static directory with an SPA fallback", async () => {
    const root = await svc.app.inject({ method: "GET", url: "/", headers: { host: "127.0.0.1" } });
    expect(root.body).toContain("IVY UI");
    expect((await svc.app.inject({ method: "GET", url: "/app.js", headers: { host: "127.0.0.1" } })).body).toContain("console.log");
    expect((await svc.app.inject({ method: "GET", url: "/timeline/2026-09-24", headers: { host: "127.0.0.1" } })).body).toContain("IVY UI");
    expect((await api(svc, "GET", "/api/nope")).status).toBe(404);
  });
});

describe("lock semantics (S8 vs freshness)", () => {
  const PASS2 = "another long passphrase";

  it("a UI lock (default) answers 423 for content but keeps the key and ingest", async () => {
    expect((await api(svc, "GET", "/api/coverage")).status).toBe(200);
    const lock = await api(svc, "POST", "/api/keystore/lock", {});
    expect(lock.json).toMatchObject({ state: "locked", locked: true, uiLocked: true, keyInMemory: true, ingestRunning: true });
    expect((await api(svc, "GET", "/api/search?q=abc")).status).toBe(423);
    expect((await api(svc, "PUT", "/api/keystore/settings", { autoLockMode: "full" })).status).toBe(423);
    expect(svc.ctx.keystore.isUnlocked()).toBe(true); // ingest still decrypts
    expect((await api(svc, "GET", "/api/keystore")).json).toMatchObject({ locked: true, uiLocked: true, ingestRunning: true });
    expect((await api(svc, "POST", "/api/keystore/unlock", { passphrase: "wrong passphrase" })).status).toBe(401);
    expect((await api(svc, "POST", "/api/keystore/unlock", { passphrase: PASS2 })).json).toMatchObject({ state: "unlocked" });
    expect((await api(svc, "GET", "/api/coverage")).status).toBe(200);
  });

  it("full: true drops the key and stops ingest", async () => {
    const lock = await api(svc, "POST", "/api/keystore/lock", { full: true });
    expect(lock.json).toMatchObject({ state: "locked", locked: true, uiLocked: false, keyInMemory: false, ingestRunning: false });
    expect(svc.ctx.keystore.isUnlocked()).toBe(false);
    expect((await svc.ingester.poll()).skipped).toBe("locked");
    expect((await api(svc, "GET", "/api/coverage")).status).toBe(423);
    expect((await api(svc, "POST", "/api/keystore/lock", { full: "yes" })).status).toBe(400);
    expect((await api(svc, "POST", "/api/keystore/unlock", { passphrase: PASS2 })).json).toMatchObject({ state: "unlocked" });
    expect((await api(svc, "GET", "/api/keystore")).json).toMatchObject({ locked: false, uiLocked: false, ingestRunning: true });
  });

  it("autoLockMode is a persisted setting; auto-lock is a UI lock by default", async () => {
    expect((await api(svc, "GET", "/api/keystore")).json.autoLockMode).toBe("ui");
    expect((await api(svc, "PUT", "/api/keystore/settings", { autoLockMode: "sometimes" })).status).toBe(400);
    expect((await api(svc, "PUT", "/api/keystore/settings", {})).status).toBe(400);
    const put = await api(svc, "PUT", "/api/keystore/settings", { autoLockMode: "full" });
    expect(put.json).toMatchObject({ autoLockMode: "full", autoLockMinutes: 5 });
    const row = svc.ctx.db.prepare("SELECT value FROM settings WHERE key = 'keystore.autoLockMode'").get() as { value: string };
    expect(row.value).toBe("full");
    expect((await api(svc, "PUT", "/api/keystore/settings", { autoLockMode: "ui" })).json.autoLockMode).toBe("ui");
  });

  it("serves requests while an unlock derives the key (Argon2id on a worker thread)", async () => {
    await api(svc, "POST", "/api/keystore/lock", { full: true });
    const order: string[] = [];
    const unlock = api(svc, "POST", "/api/keystore/unlock", { passphrase: PASS2 }).then((r) => { order.push("unlock"); return r; });
    await new Promise((r) => setTimeout(r, 20)); // the derivation is now under way
    const health = await api(svc, "GET", "/api/health").then((r) => { order.push("health"); return r; });
    const ks = await api(svc, "GET", "/api/keystore").then((r) => { order.push("keystore"); return r; });
    expect(health.status).toBe(200);
    expect(ks.json.state).toBe("locked"); // answered before the unlock finished
    expect((await unlock).json.state).toBe("unlocked");
    expect(order).toEqual(["health", "keystore", "unlock"]);
  });
});

describe("event stream and activity", () => {
  it("streams events over WebSocket /events (bearer subprotocol) and records them in /api/activity", async () => {
    const url = await svc.listen();
    const ws = new WebSocket(url.replace("http", "ws") + "/events", [`bearer.${TOKEN}`]);
    const got: Array<{ type: string }> = [];
    ws.on("message", (m) => got.push(JSON.parse(String(m))));
    await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
    await new Promise((r) => setTimeout(r, 50));
    await api(svc, "POST", "/api/keystore/lock");
    await api(svc, "POST", "/api/keystore/unlock", { passphrase: "another long passphrase" });
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    expect(got.map((g) => g.type)).toEqual(expect.arrayContaining(["hello", "keystore.locked", "keystore.unlocked"]));
    const act = await api(svc, "GET", "/api/activity?limit=10&type=keystore.locked,keystore.unlocked");
    expect(act.json.events.length).toBeGreaterThanOrEqual(2);
    expect(act.json.events[0]).toMatchObject({ type: "keystore.unlocked" });
  });

  it("refuses a WebSocket without the token", async () => {
    const addr = svc.app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/events`);
    const code = await new Promise<number>((res) => { ws.on("unexpected-response", (_req, r) => res(r.statusCode ?? 0)); ws.on("error", () => res(-1)); });
    expect(code).toBe(401);
  });
});
