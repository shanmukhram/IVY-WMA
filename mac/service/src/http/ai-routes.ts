/**
 * AI layer (PRD A1-A4, T6, Q7, M4/Q6) and Activity Vault import (S7) routes.
 * Registered from server.ts, so they sit behind the same guards (token,
 * loopback Host, same-site Origin, 423 while locked).
 *
 * AI (every route that would talk to OpenAI answers 409 while cloud AI is off,
 * and no OpenAI client is constructed; search / timeline / browsing never
 * depend on it, A4):
 *   GET  /api/ai/settings                 switch, model, embeddings, apiKeySet (the key itself is never returned), what is sent
 *   PUT  /api/ai/settings {cloudEnabled?, apiKey?, model?, embeddings?, embeddingModel?}
 *   GET  /api/ai/models                   chat + embedding model ids from the API, and the default it implies       (409 when off)
 *   POST /api/ai/ask {question, context?: {searchQuery?, filters?, date?, timeline?, tz?}, conversationId?}       (409 when off)
 *   POST /api/ai/overview {context, conversationId?}  short overview of the search results or the day             (409 when off)
 *   GET  /api/ai/conversations, GET /api/ai/conversations/:id, DELETE /api/ai/conversations/:id (to the recovery bin)
 *        local history only; readable with cloud AI off (nothing is sent)
 *   GET  /api/ai/embeddings               stored vectors per model
 *   POST /api/ai/embeddings/run {limit?}  embed pending message / OCR text now                                     (409 unless embeddings on)
 *
 * Activity Vault (S7):
 *   GET  /api/imports/activity-vault      settings, last runs, coverage row, detected source
 *   PUT  /api/imports/activity-vault/settings {enabled?, adapter?: "local"|"mcp", path?, url?}
 *   POST /api/imports/activity-vault/run  import now (also runs daily when enabled)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Service } from "../service.ts";
import type { SemanticProvider } from "../query/search.ts";
import { softDelete } from "../bin/recovery.ts";
import { AiError, OFF_MESSAGE, WHAT_EMBEDDINGS_SEND, WHAT_IS_SENT, embeddingsEnabled, readAiSettings, requireCloud, writeAiSettings } from "../ai/settings.ts";
import { chatModels, listModelIds, openaiClient, pickDefaultChatModel, pickDefaultEmbeddingModel, resolveChatModel } from "../ai/openai.ts";
import { getConversation, listConversations, overviewSeed, runAssistant, type AskContext } from "../ai/agent.ts";
import { embeddingStatus, openaiEmbedder, runEmbeddingJob, semanticProvider } from "../ai/embeddings.ts";
import {
  ImportError, LocalArchiveSource, activityVaultCoverage, isImportRunning, lastRuns, readAvSettings, runActivityVaultImport,
  startActivityVaultSchedule, writeAvSettings,
} from "../imports/activity-vault.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const wrap = (fn: Handler): Handler => async (req, reply) => {
  try { return await fn(req, reply); } catch (e) {
    if (e instanceof AiError || e instanceof ImportError) return reply.status(e.status).send({ error: e.code, message: e.message });
    throw e;
  }
};

const EMBED_EVERY_MS = 15 * 60_000;

function parseContext(v: unknown): AskContext | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new AiError(400, "bad_context", "context must be an object");
  const c = v as Record<string, unknown>;
  const out: AskContext = {};
  if (c.searchQuery !== undefined) { if (typeof c.searchQuery !== "string") throw new AiError(400, "bad_context", "context.searchQuery must be a string"); out.searchQuery = c.searchQuery.slice(0, 500); }
  if (c.filters !== undefined) {
    if (!c.filters || typeof c.filters !== "object") throw new AiError(400, "bad_context", "context.filters must be an object");
    out.filters = Object.fromEntries(Object.entries(c.filters as Record<string, unknown>).filter(([, x]) => typeof x === "string" && x).map(([k, x]) => [k, String(x).slice(0, 200)]));
  }
  if (c.date !== undefined) { if (typeof c.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) throw new AiError(400, "bad_context", "context.date must be YYYY-MM-DD"); out.date = c.date; }
  if (c.timeline !== undefined) {
    if (typeof c.timeline === "boolean") out.timeline = c.timeline;
    else if (c.timeline && typeof c.timeline === "object") {
      const t = c.timeline as Record<string, unknown>;
      out.timeline = { date: typeof t.date === "string" ? t.date : undefined, device: typeof t.device === "string" ? t.device : undefined, type: typeof t.type === "string" ? t.type : undefined };
      if (out.timeline.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.timeline.date)) throw new AiError(400, "bad_context", "context.timeline.date must be YYYY-MM-DD");
    } else throw new AiError(400, "bad_context", "context.timeline must be a boolean or an object");
  }
  if (typeof c.tz === "string" && c.tz.length < 64) out.tz = c.tz;
  return out;
}

export function registerAiRoutes(app: FastifyInstance, svc: Service): void {
  const ctx = svc.ctx;

  // Q6: semantic search is wired into GET /api/search only while embeddings are on (and cloud AI is on)
  const base: SemanticProvider | null = svc.semantic;
  const sem = semanticProvider(ctx);
  Object.defineProperty(svc, "semantic", { configurable: true, enumerable: true, get: () => (embeddingsEnabled(ctx) ? sem : base) });

  // background work starts with the real server only (not with inject() in tests)
  let stops: Array<() => void> = [];
  app.addHook("onListen", async () => {
    stops.push(startActivityVaultSchedule(ctx));
    const t = setInterval(() => {
      if (!embeddingsEnabled(ctx) || !ctx.keystore.isUnlocked()) return;
      void openaiEmbedder(ctx).then((e) => runEmbeddingJob(ctx, e)).catch(() => undefined);
    }, EMBED_EVERY_MS);
    t.unref();
    stops.push(() => clearInterval(t));
  });
  app.addHook("onClose", async () => { for (const s of stops) s(); stops = []; });

  // ---------------------------------------------------------------- AI settings
  const settingsView = () => ({
    ...readAiSettings(ctx),
    whatIsSent: WHAT_IS_SENT,
    embeddingsSend: WHAT_EMBEDDINGS_SEND,
    offMessage: OFF_MESSAGE,
    modelDefault: "the newest GPT-5-class model listed by the API for this key",
    localEmbeddingModel: null,
  });
  app.get("/api/ai/settings", wrap(async () => settingsView()));
  app.put("/api/ai/settings", wrap(async (req) => { writeAiSettings(ctx, (req.body ?? {}) as Record<string, unknown>); return settingsView(); }));

  app.get("/api/ai/models", wrap(async (req) => {
    const key = requireCloud(ctx);
    const client = openaiClient(ctx, key);
    const ids = await listModelIds(ctx, client, (req.query as { fresh?: string }).fresh === "1");
    const s = readAiSettings(ctx);
    return {
      models: chatModels(ids), embeddingModels: ids.filter((i) => i.startsWith("text-embedding-")),
      defaultModel: pickDefaultChatModel(ids), defaultEmbeddingModel: pickDefaultEmbeddingModel(ids),
      selected: s.model, selectedEmbeddingModel: s.embeddingModel,
    };
  }));

  // ---------------------------------------------------------------- ask / overview
  app.post("/api/ai/ask", wrap(async (req) => {
    const b = (req.body ?? {}) as { question?: unknown; context?: unknown; conversationId?: unknown };
    if (typeof b.question !== "string" || !b.question.trim() || b.question.length > 4000) throw new AiError(400, "bad_question", "question must be 1 to 4000 characters");
    if (b.conversationId !== undefined && typeof b.conversationId !== "string") throw new AiError(400, "bad_value", "conversationId must be a string");
    const context = parseContext(b.context);
    const key = requireCloud(ctx);
    const client = openaiClient(ctx, key);
    const model = await resolveChatModel(ctx, client, readAiSettings(ctx).model);
    return runAssistant({ ctx, client, model, question: b.question.trim(), context, conversationId: b.conversationId as string | undefined, kind: "ask" });
  }));

  app.post("/api/ai/overview", wrap(async (req) => {
    const b = (req.body ?? {}) as { context?: unknown; conversationId?: unknown } & Record<string, unknown>;
    const context = parseContext(b.context ?? { searchQuery: b.searchQuery, filters: b.filters, date: b.date, timeline: b.timeline }) ?? {};
    const { question, seed } = overviewSeed(context);
    const key = requireCloud(ctx);
    const client = openaiClient(ctx, key);
    const model = await resolveChatModel(ctx, client, readAiSettings(ctx).model);
    return runAssistant({ ctx, client, model, question, context, seed, kind: "overview", conversationId: typeof b.conversationId === "string" ? b.conversationId : undefined });
  }));

  // ---------------------------------------------------------------- history (local)
  app.get("/api/ai/conversations", wrap(async () => ({ items: listConversations(ctx) })));
  app.get("/api/ai/conversations/:id", wrap(async (req) => getConversation(ctx, (req.params as { id: string }).id)));
  app.delete("/api/ai/conversations/:id", wrap(async (req) => {
    const id = (req.params as { id: string }).id;
    getConversation(ctx, id); // 404 when missing or already in the bin
    return softDelete(ctx, "ai_conversation", id);
  }));

  // ---------------------------------------------------------------- embeddings (M4/Q6)
  app.get("/api/ai/embeddings", wrap(async () => ({ ...embeddingStatus(ctx), semanticLastError: sem.lastError })));
  app.post("/api/ai/embeddings/run", wrap(async (req) => {
    requireCloud(ctx);
    if (!embeddingsEnabled(ctx)) throw new AiError(409, "embeddings_disabled", "Embeddings are off (Settings > AI). Nothing is sent.");
    const limit = Math.min(Math.max(Number((req.body as { limit?: unknown } | undefined)?.limit) || 512, 1), 5000);
    return runEmbeddingJob(ctx, await openaiEmbedder(ctx), limit);
  }));

  // ---------------------------------------------------------------- Activity Vault (S7)
  app.get("/api/imports/activity-vault", wrap(async () => {
    const s = readAvSettings(ctx);
    let detected: Record<string, unknown> | null = null;
    let detectError: string | null = null;
    if (s.adapter === "local" && s.path) {
      try { const src = new LocalArchiveSource(s.path); detected = src.describe(); src.close(); } catch (e) { detectError = (e as Error).message; }
    }
    return { settings: s, running: isImportRunning(ctx), runs: lastRuns(ctx, 10), coverage: activityVaultCoverage(ctx), detected, detectError };
  }));
  app.put("/api/imports/activity-vault/settings", wrap(async (req) => ({ settings: writeAvSettings(ctx, (req.body ?? {}) as Record<string, unknown>) })));
  app.post("/api/imports/activity-vault/run", wrap(async () => runActivityVaultImport(ctx, { trigger: "manual" })));
}
