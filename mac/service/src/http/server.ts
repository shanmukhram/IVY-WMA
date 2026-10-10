/**
 * HTTP + WebSocket API for the dashboard (a browser client on localhost; the
 * Electron window is a thin wrapper around it).
 *
 * Security model: bound to 127.0.0.1; every /api route and /events needs the
 * local bearer token from data/session.token (Authorization: Bearer, the
 * `ivy_session` cookie set by POST /api/session, or for WebSockets the
 * `bearer.<token>` subprotocol / `?token=`). Host must be a loopback name (DNS
 * rebinding) and a cross-site Origin is refused. While the vault is locked (a UI
 * lock or a full lock) only health, session and keystore routes answer;
 * everything else is 423. A UI lock keeps the key in memory, so ingest continues.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import type { Service } from "../service.ts";
import { KeystoreError } from "../keystore/keystore.ts";
import { PairingError, cancelPairing, getDevice, listDevices, listPairings, revokeDevice, startPairing } from "../pairing/pairing.ts";
import { CommandError, cancelCommand, commandView, getCommand, issueCommand, listCommands, requestFile } from "../commands/commands.ts";
import { search, SearchError } from "../query/search.ts";
import { timeline, TimelineError } from "../query/timeline.ts";
import { coverage } from "../query/coverage.ts";
import { coverageView, messageSources } from "../query/sources.ts";
import { BinError, isBinType, listBin, purge, restore, retentionDays, setRetentionDays, softDelete, sweep } from "../bin/recovery.ts";
import { redact } from "../r2/config.ts";
import { enrich, itemView } from "../query/details.ts";
import { ITEM_TYPES, TYPE_DEFS, selectList, type ItemType } from "../query/types.ts";
import { parseBound } from "../util/time.ts";
import { setSetting } from "../db/index.ts";
import { blobProgress, type BlobRow } from "../ingest/blobs.ts";
import { registerUiRoutes } from "./ui-routes.ts"; // dashboard UI listings (@ivy/mac-ui)
import { registerAiRoutes } from "./ai-routes.ts"; // AI layer (A1-A4) and Activity Vault import (S7)

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const OPEN_ROUTES = new Set(["/api/health", "/api/session"]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".heic": "image/heic", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4",
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

function hostOk(h: string | undefined): boolean {
  if (!h) return false;
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]!;
  return LOOPBACK.has(name.toLowerCase());
}

function originOk(o: string | undefined): boolean {
  if (!o || o === "null" || o.startsWith("file://") || o.startsWith("app://")) return true; // Electron / same-origin fetches
  try { return LOOPBACK.has(new URL(o).hostname.toLowerCase()) || new URL(o).hostname === "[::1]"; } catch { return false; }
}

function cookieToken(req: FastifyRequest): string | undefined {
  const c = req.headers.cookie;
  if (!c) return undefined;
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "ivy_session") return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function wsToken(req: FastifyRequest): string | undefined {
  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string") {
    for (const p of proto.split(",").map((s) => s.trim())) if (p.startsWith("bearer.")) return p.slice(7);
  }
  const q = (req.query as Record<string, string | undefined>)?.token;
  return q;
}

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function types(v: unknown): ItemType[] | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const out = v.split(",").map((s) => s.trim()).filter(Boolean) as ItemType[];
  for (const t of out) if (!ITEM_TYPES.includes(t)) throw new HttpError(400, "bad_type", `unknown type ${t}; one of ${ITEM_TYPES.join(", ")}`);
  return out;
}

function sendLocalFile(reply: FastifyReply, path: string | null | undefined) {
  if (!path || !existsSync(path)) throw new HttpError(404, "not_available", "no local copy");
  const st = statSync(path);
  reply.header("content-type", MIME[extname(path).toLowerCase()] ?? "application/octet-stream");
  reply.header("content-length", st.size);
  reply.header("cache-control", "private, max-age=300");
  reply.header("x-content-type-options", "nosniff");
  reply.header("content-security-policy", "sandbox");
  return reply.send(createReadStream(path));
}

export async function buildServer(svc: Service): Promise<FastifyInstance> {
  const { ctx } = svc;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { code?: string; statusCode?: number };
    if (e instanceof HttpError) return reply.status(e.status).send({ error: e.code, message: e.message });
    if (e instanceof KeystoreError) {
      const status = { locked: 423, uninitialized: 409, already_initialized: 409, wrong_passphrase: 401, weak_passphrase: 400, bad_salt: 400, cooldown: 429, corrupt: 500 }[e.code];
      return reply.status(status).send({ error: e.code, message: e.message });
    }
    if (e instanceof PairingError) return reply.status(e.code === "r2_unavailable" ? 409 : 400).send({ error: e.code, message: e.message });
    if (e instanceof CommandError) return reply.status(e.code.startsWith("unknown") ? 404 : 409).send({ error: e.code, message: e.message });
    if (e instanceof BinError) return reply.status(e.code === "not_found" ? 404 : 409).send({ error: e.code, message: e.message });
    if (e instanceof SearchError || e instanceof TimelineError) return reply.status(400).send({ error: "bad_query", message: e.message });
    if (e instanceof ZodError) return reply.status(400).send({ error: "invalid", message: "invalid input", issues: e.issues });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? "bad_request", message: e.message });
    return reply.status(500).send({ error: "internal", message: e.message });
  });

  // ---------------------------------------------------------------- guards
  app.addHook("onRequest", async (req, reply) => {
    if (!hostOk(req.headers.host)) return reply.status(421).send({ error: "bad_host", message: "only loopback hosts are served" });
    const url = req.url.split("?")[0]!;
    const isApi = url.startsWith("/api/") || url === "/events";
    if (!isApi) return;
    if (!originOk(req.headers.origin as string | undefined)) return reply.status(403).send({ error: "bad_origin", message: "cross-site requests are refused" });
    if (OPEN_ROUTES.has(url)) return;
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const tok = bearer ?? cookieToken(req) ?? (url === "/events" || url === "/api/events" ? wsToken(req) : undefined);
    if (!tok || !eq(tok, svc.token)) return reply.status(401).send({ error: "unauthorized", message: "missing or wrong session token" });
    if (!url.startsWith("/api/keystore") && url !== "/events" && url !== "/api/events") {
      if (!ctx.keystore.contentUnlocked()) return reply.status(423).send({ error: "locked", message: "the vault is locked", keystore: ctx.keystore.state() });
      ctx.keystore.touch(); // user activity resets the auto-lock timer
    }
  });

  // ---------------------------------------------------------------- session & health
  app.get("/api/health", async () => ({ ok: true, service: "@ivy/mac-service", version: svc.version, keystore: ctx.keystore.state() }));
  app.post("/api/session", async (req, reply) => {
    const t = (req.body as { token?: string } | undefined)?.token;
    if (!t || !eq(t, svc.token)) return reply.status(401).send({ error: "unauthorized", message: "wrong token" });
    reply.header("set-cookie", `ivy_session=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; Path=/`);
    return { ok: true };
  });
  app.delete("/api/session", async (_req, reply) => {
    reply.header("set-cookie", "ivy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return { ok: true };
  });

  // ---------------------------------------------------------------- keystore (S8)
  app.get("/api/keystore", async () => ({ ...svc.keystoreStatus(), saltBackup: SALT_NOTE }));
  app.post("/api/keystore/initialize", async (req) => {
    const b = req.body as { passphrase?: string; salt?: string } | undefined;
    const r = await ctx.keystore.initialize(b?.passphrase ?? "", b?.salt);
    svc.onUnlocked();
    return { ...r, state: ctx.keystore.state(), saltBackup: SALT_NOTE };
  });
  app.post("/api/keystore/unlock", async (req) => {
    const r = await ctx.keystore.unlock((req.body as { passphrase?: string } | undefined)?.passphrase ?? "");
    svc.onUnlocked();
    return { ...r, state: ctx.keystore.state() };
  });
  // { full?: boolean }: false (default) = UI lock, content 423 but the key stays and ingest runs;
  // true = the key is zeroed and ingest stops until the next unlock.
  app.post("/api/keystore/lock", async (req) => {
    const full = (req.body as { full?: unknown } | undefined)?.full;
    if (full !== undefined && typeof full !== "boolean") throw new HttpError(400, "bad_value", "full must be a boolean");
    ctx.keystore.lock("manual", { full: full === true });
    return svc.keystoreStatus();
  });
  app.post("/api/keystore/change-passphrase", async (req) => {
    const b = req.body as { current?: string; next?: string } | undefined;
    if (!ctx.keystore.contentUnlocked()) throw new KeystoreError("locked", "unlock first");
    return { ...(await ctx.keystore.changePassphrase(b?.current ?? "", b?.next ?? "")), saltBackup: SALT_NOTE };
  });
  app.put("/api/keystore/settings", async (req) => {
    if (!ctx.keystore.contentUnlocked()) throw new KeystoreError("locked", "unlock first");
    const b = req.body as { autoLockMinutes?: unknown; autoLockMode?: unknown } | undefined;
    if (b?.autoLockMinutes === undefined && b?.autoLockMode === undefined) throw new HttpError(400, "bad_value", "autoLockMinutes or autoLockMode is required");
    let m: number | undefined;
    if (b?.autoLockMinutes !== undefined) {
      m = num(b.autoLockMinutes);
      if (m === undefined || m < 0 || m > 24 * 60) throw new HttpError(400, "bad_value", "autoLockMinutes must be 0..1440 (0 = never)");
    }
    if (b?.autoLockMode !== undefined && b.autoLockMode !== "ui" && b.autoLockMode !== "full") throw new HttpError(400, "bad_value", 'autoLockMode must be "ui" or "full"');
    if (m !== undefined) { ctx.keystore.setAutoLockMinutes(m); setSetting(ctx.db, "keystore.autoLockMinutes", String(m)); }
    if (b?.autoLockMode !== undefined) { ctx.keystore.setAutoLockMode(b.autoLockMode as "ui" | "full"); setSetting(ctx.db, "keystore.autoLockMode", b.autoLockMode as string); }
    return svc.keystoreStatus();
  });

  // ---------------------------------------------------------------- R2
  app.get("/api/r2", async () => {
    const r2 = ctx.r2();
    return { configured: !!r2, config: r2 ? redact(r2.config) : null };
  });
  app.put("/api/r2", async (req) => {
    const c = ctx.setR2Config(req.body);
    ctx.events.emit("r2.configured", { endpoint: redact(c).endpoint });
    return { configured: true, config: redact(c) };
  });
  app.post("/api/r2/check", async () => {
    const r2 = ctx.r2();
    if (!r2) throw new HttpError(409, "r2_not_configured", "configure R2 first");
    const buckets = await r2.check();
    return { ok: buckets.every((b) => b.ok), buckets };
  });

  // ---------------------------------------------------------------- pairing & devices
  app.post("/api/pairings", async (req) => {
    const role = (req.body as { role?: string } | undefined)?.role;
    return startPairing(ctx, role as "windows" | "android");
  });
  app.get("/api/pairings", async () => ({ pairings: listPairings(ctx) }));
  app.delete("/api/pairings/:id", async (req) => ({ cancelled: await cancelPairing(ctx, (req.params as { id: string }).id) }));
  app.get("/api/devices", async () => ({ macFingerprint: ctx.keystore.macFingerprint(), devices: listDevices(ctx).map(deviceView) }));
  app.get("/api/devices/:id", async (req) => {
    const d = getDevice(ctx, (req.params as { id: string }).id);
    if (!d) throw new HttpError(404, "not_found", "no such device");
    return deviceView(d);
  });
  app.delete("/api/devices/:id", async (req) => revokeDevice(ctx, (req.params as { id: string }).id));
  app.get("/api/fingerprints", async () => ({
    mac: ctx.keystore.macFingerprint(),
    devices: listDevices(ctx).map((d) => ({ deviceId: d.id, role: d.role, fingerprint: d.fingerprint, pairedAt: d.paired_at })),
  }));

  // ---------------------------------------------------------------- ingest & quarantine
  app.post("/api/ingest/poll", async (req) => svc.ingester.poll({ full: !!(req.body as { full?: boolean } | undefined)?.full }));
  app.get("/api/ingest/status", async () => {
    const blobs = ctx.db.prepare("SELECT * FROM blobs WHERE status IN ('awaiting_manifest','assembling') ORDER BY updated_at DESC LIMIT 100").all() as BlobRow[];
    const ledger = ctx.db.prepare("SELECT status, COUNT(*) AS n FROM sync_objects GROUP BY status").all();
    return { running: svc.ingester.isRunning(), last: svc.ingester.last, intervalMs: ctx.config.pollIntervalMs, ledger, pendingBlobs: blobs.map(blobProgress) };
  });
  app.get("/api/quarantine", async (req) => {
    const all = (req.query as { all?: string }).all === "1";
    const rows = ctx.db.prepare(`SELECT id, bucket, role, object_key, kind, device_id, reason, size, created_at, resolved_at, resolution, stored_path IS NOT NULL AS stored
                                 FROM quarantine ${all ? "" : "WHERE resolved_at IS NULL"} ORDER BY created_at DESC LIMIT 500`).all();
    return { items: rows };
  });
  app.post("/api/quarantine/:id/retry", async (req) => svc.ingester.retryQuarantined((req.params as { id: string }).id));
  app.delete("/api/quarantine/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const q = ctx.db.prepare("SELECT stored_path FROM quarantine WHERE id = ?").get(id) as { stored_path: string | null } | undefined;
    if (!q) throw new HttpError(404, "not_found", "no such quarantine entry");
    const { removeQuietly } = await import("../util/fsx.ts");
    removeQuietly(q.stored_path);
    ctx.db.prepare("UPDATE quarantine SET resolved_at = COALESCE(resolved_at, ?), resolution = COALESCE(resolution, 'dismissed'), stored_path = NULL WHERE id = ?").run(new Date().toISOString(), id);
    return { dismissed: true };
  });

  // ---------------------------------------------------------------- commands (F2/F3)
  app.get("/api/commands", async (req) => {
    const q = req.query as { device?: string; status?: string; file?: string; limit?: string };
    return { commands: listCommands(ctx, { deviceId: q.device, status: q.status, fileId: q.file, limit: num(q.limit) }) };
  });
  app.get("/api/commands/:id", async (req) => {
    const c = getCommand(ctx, (req.params as { id: string }).id);
    if (!c) throw new HttpError(404, "not_found", "no such command");
    return commandView(ctx, c);
  });
  app.post("/api/commands", async (req) => {
    const b = req.body as { deviceId?: string; params?: unknown } | undefined;
    if (!b?.deviceId || !b.params) throw new HttpError(400, "bad_command", "deviceId and params are required");
    const p = b.params as { type?: string; fileId?: string };
    if (p.type === "file_request" && p.fileId) return requestFile(ctx, p.fileId);
    return commandView(ctx, await issueCommand(ctx, b.deviceId, b.params as never));
  });
  app.delete("/api/commands/:id", async (req) => ({ cancelled: await cancelCommand(ctx, (req.params as { id: string }).id) }));
  app.post("/api/files/:id/request", async (req) => requestFile(ctx, (req.params as { id: string }).id, { force: !!(req.body as { force?: boolean } | undefined)?.force }));
  app.post("/api/devices/:id/rescan", async (req) => {
    const b = req.body as { collector?: string; scope?: string } | undefined;
    if (!b?.collector) throw new HttpError(400, "bad_command", "collector is required");
    return commandView(ctx, await issueCommand(ctx, (req.params as { id: string }).id, { type: "rescan", collector: b.collector, ...(b.scope ? { scope: b.scope } : {}) }));
  });
  app.post("/api/devices/:id/collector-config", async (req) => {
    const b = req.body as { collector?: string; enabled?: boolean; settings?: Record<string, unknown> } | undefined;
    if (!b?.collector) throw new HttpError(400, "bad_command", "collector is required");
    return commandView(ctx, await issueCommand(ctx, (req.params as { id: string }).id, {
      type: "collector_config", collector: b.collector,
      ...(b.enabled !== undefined ? { enabled: !!b.enabled } : {}), ...(b.settings ? { settings: b.settings } : {}),
    }));
  });

  // ---------------------------------------------------------------- search / timeline / coverage
  app.get("/api/search", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return search(ctx, {
      q: q.q ?? "", types: types(q.type), device: q.device, app: q.app, person: q.person, conversation: q.conversation, account: q.account,
      from: parseBound(q.from), to: parseBound(q.to, true), page: num(q.page), pageSize: num(q.pageSize),
      sort: (q.sort as "relevance" | "newest" | "oldest" | undefined) ?? "relevance", typo: q.typo !== "off" && q.typo !== "0",
    }, svc.semantic);
  });
  app.get("/api/timeline", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return timeline(ctx, { date: q.date, from: q.from, to: q.to, tz: q.tz, device: q.device, types: types(q.type), page: num(q.page), pageSize: num(q.pageSize) });
  });
  app.get("/api/coverage", async () => coverage(ctx));
  app.get("/api/stats", async () => {
    const c = (t: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NULL`).get() as { n: number }).n;
    const polls = ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'poll:%'").all() as Array<{ key: string; value: string }>;
    return {
      counts: { messages: c("messages"), notifications: c("notifications"), media: c("media"), files: c("files"), usage: c("usage_events"), calls: c("calls") },
      lastSync: polls.map((p) => ({ bucket: p.key.slice(5), ...(JSON.parse(p.value) as object) })),
    };
  });

  // ---------------------------------------------------------------- records (Q4)
  app.get("/api/items/:type/:id", async (req) => {
    const { type, id } = req.params as { type: string; id: string };
    if (!ITEM_TYPES.includes(type as ItemType)) throw new HttpError(400, "bad_type", "unknown type");
    const d = TYPE_DEFS[type as ItemType];
    const row = ctx.db.prepare(`SELECT ${selectList(d)}, x.deleted_at AS deleted_at FROM ${d.from} WHERE x.id = ?`).get(id) as (Parameters<typeof enrich>[1][number] & { deleted_at: string | null }) | undefined;
    if (!row) throw new HttpError(404, "not_found", "no such item");
    return { ...itemView(enrich(ctx, [row])[0]!), deletedAt: row.deleted_at };
  });
  app.get("/api/conversations/:id/messages", async (req) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { around?: string; before?: string; after?: string };
    const row = ctx.db.prepare(`SELECT id, platform, account, conv_key, peer, kind, coverage, coverage_by_source, chat_title, participant_count, chat_type, deleted_at
                                FROM conversations WHERE id = ?`).get(id) as (Record<string, unknown> & { coverage_by_source: string }) | undefined;
    if (!row) throw new HttpError(404, "not_found", "no such conversation");
    const { coverage_by_source, ...convCols } = row;
    const conv = { ...convCols, ...coverageView(coverage_by_source) };
    const before = Math.min(num(q.before) ?? 20, 200), after = Math.min(num(q.after) ?? 20, 200);
    let pivot = q.around ? (ctx.db.prepare("SELECT sent_at, rid FROM messages WHERE id = ? AND conversation_id = ?").get(q.around, id) as { sent_at: string; rid: number } | undefined) : undefined;
    pivot ??= ctx.db.prepare("SELECT sent_at, rid FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY sent_at DESC, rid DESC LIMIT 1").get(id) as { sent_at: string; rid: number } | undefined;
    const cols = "id, msg_key, sender, sent_at, captured_at, text, text_quality, reply_to, edited_at, source_status, source_deleted_at, forwarded_from, media_kind";
    const older = pivot ? ctx.db.prepare(`SELECT ${cols} FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND (sent_at < ? OR (sent_at = ? AND rid < ?)) ORDER BY sent_at DESC, rid DESC LIMIT ?`).all(id, pivot.sent_at, pivot.sent_at, pivot.rid, before).reverse() : [];
    const newer = pivot ? ctx.db.prepare(`SELECT ${cols} FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND (sent_at > ? OR (sent_at = ? AND rid >= ?)) ORDER BY sent_at ASC, rid ASC LIMIT ?`).all(id, pivot.sent_at, pivot.sent_at, pivot.rid, after + 1) : [];
    const msgs = [...older, ...newer] as Array<Record<string, unknown> & { id: string }>;
    const prov = messageSources(ctx.db, msgs.map((m) => m.id));
    return { conversation: conv, around: q.around ?? null, messages: msgs.map((m) => ({ ...m, sources: prov.get(m.id) ?? [] })) };
  });
  app.get("/api/files", async (req) => {
    const q = req.query as { device?: string; status?: string; page?: string; pageSize?: string };
    const pageSize = Math.min(num(q.pageSize) ?? 50, 500), page = Math.max(num(q.page) ?? 1, 1);
    const where = ["deleted_at IS NULL"]; const args: unknown[] = [];
    if (q.device) { where.push("device_id = ?"); args.push(q.device); }
    if (q.status) { where.push("status = ?"); args.push(q.status); }
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
    const rows = ctx.db.prepare(`SELECT 'file' AS type, rid, id, device_id, NULL AS app, COALESCE(mtime, event_time) AS event_time, 'mtime' AS time_field, captured_at, name AS title, path AS body, NULL AS person
                                 FROM files WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as Parameters<typeof enrich>[1];
    return { total, page, pageSize, items: enrich(ctx, rows).map(itemView) };
  });
  app.get("/api/files/:id/content", async (req, reply) => {
    const f = ctx.db.prepare("SELECT local_path FROM files WHERE id = ? AND deleted_at IS NULL").get((req.params as { id: string }).id) as { local_path: string | null } | undefined;
    return sendLocalFile(reply, f?.local_path);
  });
  app.get("/api/files/:id/thumb", async (req, reply) => {
    const f = ctx.db.prepare("SELECT thumb_path FROM files WHERE id = ? AND deleted_at IS NULL").get((req.params as { id: string }).id) as { thumb_path: string | null } | undefined;
    return sendLocalFile(reply, f?.thumb_path);
  });
  app.get("/api/media/:id/content", async (req, reply) => {
    const m = ctx.db.prepare("SELECT local_path FROM media WHERE id = ? AND deleted_at IS NULL").get((req.params as { id: string }).id) as { local_path: string | null } | undefined;
    return sendLocalFile(reply, m?.local_path);
  });
  app.get("/api/media/:id/thumb", async (req, reply) => {
    const m = ctx.db.prepare("SELECT thumb_path, local_path FROM media WHERE id = ? AND deleted_at IS NULL").get((req.params as { id: string }).id) as { thumb_path: string | null; local_path: string | null } | undefined;
    return sendLocalFile(reply, m?.thumb_path ?? m?.local_path);
  });

  // ---------------------------------------------------------------- recovery bin (B1-B4)
  app.delete("/api/items/:type/:id", async (req) => {
    const { type, id } = req.params as { type: string; id: string };
    if (!isBinType(type)) throw new HttpError(400, "bad_type", "unknown type");
    return softDelete(ctx, type, id);
  });
  app.get("/api/bin", async (req) => {
    const q = req.query as { page?: string; pageSize?: string };
    return listBin(ctx, { page: num(q.page), pageSize: num(q.pageSize) });
  });
  app.post("/api/bin/:type/:id/restore", async (req) => {
    const { type, id } = req.params as { type: string; id: string };
    if (!isBinType(type)) throw new HttpError(400, "bad_type", "unknown type");
    return restore(ctx, type, id);
  });
  app.delete("/api/bin/:type/:id", async (req) => {
    const { type, id } = req.params as { type: string; id: string };
    if (!isBinType(type)) throw new HttpError(400, "bad_type", "unknown type");
    return purge(ctx, type, id);
  });
  app.get("/api/bin/settings", async () => ({ retentionDays: retentionDays(ctx) }));
  app.put("/api/bin/settings", async (req) => {
    const d = num((req.body as { retentionDays?: unknown } | undefined)?.retentionDays);
    if (d === undefined) throw new HttpError(400, "bad_value", "retentionDays is required");
    setRetentionDays(ctx, d);
    return { retentionDays: retentionDays(ctx) };
  });
  app.post("/api/bin/sweep", async () => sweep(ctx));

  // ---------------------------------------------------------------- activity & events
  app.get("/api/activity", async (req) => {
    const q = req.query as { limit?: string; before?: string; type?: string };
    return { events: ctx.events.recent({ limit: num(q.limit), before: num(q.before), types: q.type ? q.type.split(",") : undefined }) };
  });
  const wsHandler = (socket: import("ws").WebSocket) => {
    socket.send(JSON.stringify({ type: "hello", at: new Date().toISOString(), data: { keystore: ctx.keystore.state() } }));
    const off = ctx.events.on((ev) => {
      // while locked only lock-state events go out
      if (!ctx.keystore.contentUnlocked() && !ev.type.startsWith("keystore.")) return;
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(ev));
    });
    socket.on("close", off);
    socket.on("error", off);
  };
  app.get("/events", { websocket: true }, wsHandler);
  app.get("/api/events", { websocket: true }, wsHandler);

  // ---------------------------------------------------------------- dashboard UI listings (added for @ivy/mac-ui; see ui-routes.ts)
  registerUiRoutes(app, svc);
  registerAiRoutes(app, svc);

  // ---------------------------------------------------------------- static UI
  const staticDir = ctx.config.staticDir;
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, prefix: "/", index: ["index.html"] });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0]!;
    if (req.method === "GET" && !url.startsWith("/api/") && existsSync(join(staticDir, "index.html"))) {
      return reply.type("text/html").send(createReadStream(join(staticDir, "index.html")));
    }
    return reply.status(404).send({ error: "not_found", message: `${req.method} ${url}` });
  });

  return app;
}

function deviceView(d: ReturnType<typeof listDevices>[number]) {
  return {
    id: d.id, role: d.role, fingerprint: d.fingerprint, publicKey: d.public_key, pairingId: d.pairing_id, pairedAt: d.paired_at,
    lastSeen: d.last_seen, lastReportAt: d.last_report_at, appVersion: d.app_version, queueDepthTotal: d.queue_depth_total,
    revokeWarning: "Revoking forgets this device's key: its uploads are quarantined and no commands reach it. Captured content stays in the vault. Its R2 tokens stay valid until rotated in Cloudflare.",
  };
}

export const SALT_NOTE =
  "Back up data/identity.json (it holds the identity salt). Re-pairing after a restore needs the same passphrase and the same salt: " +
  "a new salt means a new Mac key and every device must be paired again. After a passphrase change the salt alone re-derives the key only " +
  "with the ORIGINAL passphrase; keep a fresh copy of identity.json to unlock with the new one.";
