/**
 * The OpenAI client, behind the narrow surface IVY uses (chat completions with
 * tool calling, the model list, embeddings). Constructed only by AI routes that
 * passed `requireCloud`, per request, from the sealed key. Tests replace the
 * factory with a fake shaped like the official client (no network).
 */
import OpenAI from "openai";
import type { Ctx } from "../context.ts";
import { AiError } from "./settings.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** The subset of the official `openai` client IVY calls. */
export interface OpenAILike {
  chat: { completions: { create(body: Record<string, unknown>): Promise<{ choices: Array<{ message: ChatMessage; finish_reason?: string | null }>; model?: string }> } };
  models: { list(): PromiseLike<{ data: Array<{ id: string; created?: number; owned_by?: string }> }> };
  embeddings: { create(body: { model: string; input: string[] }): Promise<{ data: Array<{ embedding: number[]; index?: number }> }> };
}

export type OpenAIFactory = (apiKey: string) => OpenAILike;

const defaultFactory: OpenAIFactory = (apiKey) => new OpenAI({ apiKey, maxRetries: 2, timeout: 90_000 }) as unknown as OpenAILike;
const factories = new WeakMap<Ctx, OpenAIFactory>();

/** Tests: inject a fake client for this service. */
export function setOpenAIFactory(ctx: Ctx, f: OpenAIFactory | null): void {
  if (f) factories.set(ctx, f); else factories.delete(ctx);
  modelCache.delete(ctx);
}

export function openaiClient(ctx: Ctx, apiKey: string): OpenAILike {
  return (factories.get(ctx) ?? defaultFactory)(apiKey);
}

/** Upstream failures become 502 with the API's message (never the key). */
export function upstream(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const err = e as { status?: number; message?: string; name?: string };
  const msg = (err.message ?? String(e)).replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-…");
  if (err.status === 401) return new AiError(502, "ai_auth", `OpenAI rejected the API key: ${msg}`);
  if (err.status === 429) return new AiError(502, "ai_rate_limited", `OpenAI rate limit or quota: ${msg}`);
  return new AiError(502, "ai_upstream", `OpenAI request failed: ${msg}`);
}

// ------------------------------------------------------------------ models

const modelCache = new WeakMap<Ctx, { at: number; ids: string[] }>();
const MODEL_TTL_MS = 3600_000;

export async function listModelIds(ctx: Ctx, client: OpenAILike, fresh = false): Promise<string[]> {
  const c = modelCache.get(ctx);
  if (!fresh && c && Date.now() - c.at < MODEL_TTL_MS) return c.ids;
  let page;
  try { page = await client.models.list(); } catch (e) { throw upstream(e); }
  const ids = [...new Set((page?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string"))].sort();
  modelCache.set(ctx, { at: Date.now(), ids });
  return ids;
}

const version = (id: string, prefix: RegExp): number[] | null => {
  const m = prefix.exec(id);
  return m ? m[1]!.split(".").filter(Boolean).map(Number) : null;
};
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

/** Chat models offered in Settings: the gpt-* and o-series ids the account can use, without audio/realtime/image/search/tts variants. */
export function chatModels(ids: string[]): string[] {
  return ids.filter((id) => /^(gpt-|o\d)/.test(id) && !/(audio|realtime|image|tts|transcribe|search|embedding|instruct|moderation|dall-e|whisper)/.test(id));
}

/**
 * Default chat model: the newest GPT-5-class general model the API lists
 * (gpt-5, gpt-5.1, ... : the plain family id, no -mini/-nano/-pro/dated
 * suffix), else the newest dated or chat-latest GPT-5 id. Read from the
 * account's model list, never a hardcoded id.
 */
export function pickDefaultChatModel(ids: string[]): string | null {
  const plain = ids.map((id) => ({ id, v: version(id, /^gpt-5((?:\.\d+)*)$/) ?? (id === "gpt-5" ? [] : null) })).filter((x) => x.v !== null);
  if (plain.length) return plain.sort((a, b) => cmp([5, ...b.v!], [5, ...a.v!]))[0]!.id;
  const any = ids.map((id) => ({ id, v: version(id, /^gpt-5((?:\.\d+)*)(?:-chat-latest|-\d{4}-\d{2}-\d{2})$/) })).filter((x) => x.v !== null);
  if (any.length) return any.sort((a, b) => cmp(b.v!, a.v!))[0]!.id;
  return null;
}

/** Default embedding model: the newest text-embedding-N id the API lists, "small" before "large" (cost) at the same version. */
export function pickDefaultEmbeddingModel(ids: string[]): string | null {
  const c = ids.map((id) => ({ id, m: /^text-embedding-(\d+)(?:-(small|large))?$/.exec(id) })).filter((x) => x.m);
  if (!c.length) return null;
  return c.sort((a, b) => Number(b.m![1]) - Number(a.m![1]) || (a.m![2] === "small" ? -1 : b.m![2] === "small" ? 1 : 0))[0]!.id;
}

export async function resolveChatModel(ctx: Ctx, client: OpenAILike, configured: string | null): Promise<string> {
  if (configured) return configured;
  const m = pickDefaultChatModel(await listModelIds(ctx, client));
  if (!m) throw new AiError(409, "ai_no_model", "No GPT-5-class model is listed for this API key; choose a model in Settings > AI.");
  return m;
}

export async function resolveEmbeddingModel(ctx: Ctx, client: OpenAILike, configured: string | null): Promise<string> {
  if (configured) return configured;
  const m = pickDefaultEmbeddingModel(await listModelIds(ctx, client));
  if (!m) throw new AiError(409, "ai_no_model", "No text-embedding model is listed for this API key; choose one in Settings > AI.");
  return m;
}
