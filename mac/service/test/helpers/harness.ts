/** Test harness: an S3 mock with the four ivy-* buckets and scoped tokens, and a service on a temp data dir. */
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startMock } from "@ivy/s3-mock";
import type { MockServer, Policy } from "@ivy/s3-mock";
import { createService, type Service, type ServiceOptions } from "../../src/service.ts";
import type { ServiceConfig } from "../../src/config.ts";

export const PASS = "correct horse battery staple";
export const BUCKETS = ["ivy-up-windows", "ivy-up-android", "ivy-cmd-windows", "ivy-cmd-android"];
const tok = (id: string) => `${id}:${randomBytes(20).toString("hex")}`;

export interface Tokens { mac: string; winUp: string; winCmd: string; andUp: string; andCmd: string }

export function makeTokens(): Tokens {
  return { mac: tok("mac"), winUp: tok("up-windows"), winCmd: tok("cmd-windows"), andUp: tok("up-android"), andCmd: tok("cmd-android") };
}

const kid = (t: string) => t.slice(0, t.indexOf(":"));
const UP_OPS = ["PutObject", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload"] as const;
const CMD_OPS = ["ListObjectsV2", "GetObject", "HeadObject"] as const;

export function policy(t: Tokens): Policy {
  return {
    [kid(t.mac)]: { bucket: "*", operations: ["*"] },
    [kid(t.winUp)]: { bucket: "ivy-up-windows", operations: [...UP_OPS] },
    [kid(t.winCmd)]: { bucket: "ivy-cmd-windows", operations: [...CMD_OPS] },
    [kid(t.andUp)]: { bucket: "ivy-up-android", operations: [...UP_OPS] },
    [kid(t.andCmd)]: { bucket: "ivy-cmd-android", operations: [...CMD_OPS] },
  };
}

export async function startS3(t: Tokens): Promise<{ mock: MockServer; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "ivy-s3-"));
  const mock = await startMock({ root, port: 0, policy: policy(t), buckets: BUCKETS });
  return { mock, root };
}

export function r2ConfigFor(url: string, t: Tokens) {
  return {
    endpoint: url,
    macTokens: { all: t.mac },
    deviceTokens: { windows: { upWrite: t.winUp, cmdRead: t.winCmd }, android: { upWrite: t.andUp, cmdRead: t.andCmd } },
  };
}

/** Thumbnailer that copies the original (keeps tests independent of sips). */
export const copyThumbnailer = { async make(src: string, dest: string) { copyFileSync(src, dest); return true; } };

export const TOKEN = "a".repeat(64);

export async function makeService(dataDir: string, cfg: Partial<ServiceConfig> = {}, opts: ServiceOptions = {}): Promise<Service> {
  return createService(
    { dataDir, pollIntervalMs: 0, staticDir: join(dataDir, "static-none"), thumbnails: false, ...cfg },
    { thumbnailer: copyThumbnailer, ocr: null, token: TOKEN, ...opts },
  );
}

export const tempDir = (p = "ivy-svc-") => mkdtempSync(join(tmpdir(), p));
export const rm = (d: string) => rmSync(d, { recursive: true, force: true });

/** app.inject with the bearer token. */
export async function api(svc: Service, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await svc.app.inject({
    method: method as "GET", url, payload: body as never,
    headers: { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1", ...headers },
  });
  let json: any = null;
  try { json = r.json(); } catch { /* not json */ }
  return { status: r.statusCode, json, body: r.body, headers: r.headers };
}

/** Service + mock + initialized key store + R2 config. */
export async function fullStack(cfg: Partial<ServiceConfig> = {}) {
  const tokens = makeTokens();
  const s3 = await startS3(tokens);
  const dataDir = tempDir();
  const svc = await makeService(dataDir, cfg);
  svc.ctx.keystore.initialize(PASS);
  svc.ctx.setR2Config(r2ConfigFor(s3.mock.url, tokens));
  return {
    svc, tokens, s3, dataDir,
    async restart(extra: Partial<ServiceConfig> = {}) {
      await this.svc.close();
      this.svc = await makeService(dataDir, { ...cfg, ...extra });
      this.svc.ctx.keystore.unlock(PASS);
      return this.svc;
    },
    async cleanup() {
      await this.svc.close().catch(() => undefined);
      await s3.mock.stop();
      rm(dataDir); rm(s3.root);
    },
  };
}

import { startPairing } from "../../src/pairing/pairing.ts";
import { SimDevice } from "./device.ts";

/** Pair a simulated device of `role` end to end and ingest its pairing record. */
export async function pairNew(svc: Service, role: "windows" | "android" = "windows"): Promise<SimDevice> {
  const p = await startPairing(svc.ctx, role);
  const dev = new SimDevice(p.pairingString);
  await dev.pair();
  await svc.ingester.poll();
  return dev;
}
