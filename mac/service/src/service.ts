/**
 * Wires the service together: database, key store, event bus, ingest loop,
 * media post-processing, recovery-bin sweep, and the HTTP/WebSocket server.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { loadConfig, dirs, type ServiceConfig } from "./config.ts";
import { openDb, getNumberSetting, getSetting } from "./db/index.ts";
import { Keystore } from "./keystore/keystore.ts";
import { EventBus } from "./events.ts";
import { Ctx, type OcrProvider, type Thumbnailer } from "./context.ts";
import { Ingester } from "./ingest/ingester.ts";
import { MediaProcessor, commandOcr, sipsThumbnailer, visionOcr } from "./ingest/media.ts";
import { DocumentProcessor } from "./ingest/documents.ts";
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
  /** pdftotext binary for document text (PLAN decision 8); undefined = look for it, null = none */
  pdftotext?: string | null;
}

export interface Service {
  ctx: Ctx;
  config: ServiceConfig;
  ingester: Ingester;
  media: MediaProcessor;
  /** text extraction for document originals (PLAN decision 8) */
  documents: DocumentProcessor;
  token: string;
  version: string;
  semantic: SemanticProvider | null;
  app: FastifyInstance;
  /** called after initialize/unlock: resume work that needs the key */
  onUnlocked(): void;
  /** GET /api/keystore: key store status plus whether ingest is running */
  keystoreStatus(): ReturnType<Keystore["status"]> & { ingestRunning: boolean; ingestPausedUntil: string | null };
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
  let ingesterRef: Ingester | null = null;
  const savedMode = getSetting(db, "keystore.autoLockMode");
  const keystore = new Keystore({
    path: config.identityPath,
    autoLockMinutes: getNumberSetting(db, "keystore.autoLockMinutes", config.autoLockMinutes),
    autoLockMode: savedMode === "full" ? "full" : "ui",
    onEvent: (type, data) => {
      // a UI lock keeps the key and R2 clients (ingest continues); only a full lock drops them
      if (type === "keystore.locked" && data.full) ctxRef?.dropR2();
      // the key was absent (start, full lock): the next pass lists everything (no marker window)
      if ((type === "keystore.unlocked" && !data.fromUiLock) || type === "keystore.initialized") ingesterRef?.requestFull();
      events.emit(type, data);
    },
  });
  const ctx = new Ctx(db, config, keystore, events);
  ctxRef = ctx;
  ctx.thumbnailer = opts.thumbnailer !== undefined ? opts.thumbnailer : config.thumbnails ? sipsThumbnailer : null;
  ctx.ocr = opts.ocr !== undefined ? opts.ocr
    : config.ocr === "vision" ? visionOcr({ concurrency: config.ocrConcurrency })
    : config.ocr === "command" && config.ocrCommand ? commandOcr(config.ocrCommand) : null;
  const media = new MediaProcessor(ctx, { concurrency: config.ocrConcurrency });
  ctx.mediaReady = (id, path) => media.enqueue(id, path);
  const documents = new DocumentProcessor(ctx, { pdftotext: opts.pdftotext });
  ctx.documentReady = (oid, path) => documents.enqueue(oid, path);
  const ingester = new Ingester(ctx);
  ingesterRef = ingester;
  const token = opts.token ?? loadToken(config.tokenPath);

  let sweepTimer: NodeJS.Timeout | undefined;
  const svc: Service = {
    ctx, config, ingester, media, documents, token, version: VERSION, semantic: opts.semantic ?? null,
    app: undefined as unknown as FastifyInstance,
    onUnlocked() {
      void sendQueued(ctx).catch(() => 0);
      media.resumePending();
      if (config.pollIntervalMs > 0) void ingester.poll().catch(() => undefined);
    },
    keystoreStatus() {
      const pausedUntil = ingester.pausedTill();
      return { ...keystore.status(), ingestRunning: keystore.isUnlocked() && ingester.isActive() && !pausedUntil, ingestPausedUntil: pausedUntil };
    },
    async listen() {
      const addr = await svc.app.listen({ host: config.host, port: config.port });
      keystore.startAutoLock();
      ingester.start();
      void media.start().catch(() => undefined); // probe the OCR helper, then the backlog
      documents.resumePending(); // e.g. PDFs left pending before pdftotext was installed
      try { sweep(ctx); } catch { /* retried on the timer */ }
      sweepTimer = setInterval(() => { try { sweep(ctx); } catch { /* next time */ } }, 6 * 3600_000);
      sweepTimer.unref();
      return addr;
    },
    async idle() { await media.idle(); await documents.idle(); await media.idle(); },
    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      keystore.stopAutoLock();
      await ingester.stop();
      await media.close();
      await documents.close();
      await svc.app.close();
      ctx.dropR2();
      keystore.lock("shutdown", { full: true });
      db.close();
    },
  };
  svc.app = await buildServer(svc);
  return svc;
}
