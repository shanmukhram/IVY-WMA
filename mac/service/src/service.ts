/**
 * Wires the service together: database, key store, event bus, ingest loop,
 * media post-processing, recovery-bin sweep, and the HTTP/WebSocket server.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { loadConfig, dirs, type ServiceConfig } from "./config.ts";
import { openDb, getNumberSetting } from "./db/index.ts";
import { Keystore } from "./keystore/keystore.ts";
import { EventBus } from "./events.ts";
import { Ctx, type OcrProvider, type Thumbnailer } from "./context.ts";
import { Ingester } from "./ingest/ingester.ts";
import { MediaProcessor, commandOcr, sipsThumbnailer } from "./ingest/media.ts";
import { sendQueued } from "./commands/commands.ts";
import { sweep } from "./bin/recovery.ts";
import { buildServer } from "./http/server.ts";
import { ensureDir, writeFileAtomic } from "./util/fsx.ts";
import type { SemanticProvider } from "./query/search.ts";

export const VERSION = "0.1.0";

export interface ServiceOptions {
  thumbnailer?: Thumbnailer | null;
  ocr?: OcrProvider | null;
  /** Q6 extension point: semantic search provider (off by default) */
  semantic?: SemanticProvider | null;
  /** reuse a token (tests); otherwise read or create data/session.token */
  token?: string;
}

export interface Service {
  ctx: Ctx;
  config: ServiceConfig;
  ingester: Ingester;
  media: MediaProcessor;
  token: string;
  version: string;
  semantic: SemanticProvider | null;
  app: FastifyInstance;
  /** called after initialize/unlock: resume work that needs the key */
  onUnlocked(): void;
  listen(): Promise<string>;
  /** wait for background media work (tests) */
  idle(): Promise<void>;
  close(): Promise<void>;
}

function loadToken(path: string): string {
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeFileAtomic(path, t + "\n", 0o600);
  return t;
}

export async function createService(overrides: Partial<ServiceConfig> = {}, opts: ServiceOptions = {}): Promise<Service> {
  const config = loadConfig(overrides);
  ensureDir(config.dataDir);
  for (const d of Object.values(dirs(config))) ensureDir(d);
  const db = openDb(config.dbPath);
  const events = new EventBus(db, config.activityKeep);
  let ctxRef: Ctx | null = null;
  const keystore = new Keystore({
    path: config.identityPath,
    autoLockMinutes: getNumberSetting(db, "keystore.autoLockMinutes", config.autoLockMinutes),
    onEvent: (type, data) => {
      if (type === "keystore.locked") ctxRef?.dropR2();
      events.emit(type, data);
    },
  });
  const ctx = new Ctx(db, config, keystore, events);
  ctxRef = ctx;
  ctx.thumbnailer = opts.thumbnailer !== undefined ? opts.thumbnailer : config.thumbnails ? sipsThumbnailer : null;
  ctx.ocr = opts.ocr !== undefined ? opts.ocr : config.ocrCommand ? commandOcr(config.ocrCommand) : null;
  const media = new MediaProcessor(ctx);
  ctx.mediaReady = (id, path) => media.enqueue(id, path);
  const ingester = new Ingester(ctx);
  const token = opts.token ?? loadToken(config.tokenPath);

  let sweepTimer: NodeJS.Timeout | undefined;
  const svc: Service = {
    ctx, config, ingester, media, token, version: VERSION, semantic: opts.semantic ?? null,
    app: undefined as unknown as FastifyInstance,
    onUnlocked() {
      void sendQueued(ctx).catch(() => 0);
      if (ctx.ocr || ctx.thumbnailer) media.resumePending();
      if (config.pollIntervalMs > 0) void ingester.poll().catch(() => undefined);
    },
    async listen() {
      const addr = await svc.app.listen({ host: config.host, port: config.port });
      keystore.startAutoLock();
      ingester.start();
      try { sweep(ctx); } catch { /* retried on the timer */ }
      sweepTimer = setInterval(() => { try { sweep(ctx); } catch { /* next time */ } }, 6 * 3600_000);
      sweepTimer.unref();
      return addr;
    },
    async idle() { await media.idle(); },
    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      keystore.stopAutoLock();
      await ingester.stop();
      await media.idle();
      await svc.app.close();
      ctx.dropR2();
      keystore.lock("shutdown");
      db.close();
    },
  };
  svc.app = await buildServer(svc);
  return svc;
}
