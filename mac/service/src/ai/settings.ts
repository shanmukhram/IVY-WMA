/**
 * AI settings (PRD A3). Cloud AI is an explicit switch, default OFF.
 *
 *   ui.ai.cloudEnabled   boolean, shared with PUT /api/ui-settings (the original switch)
 *   ai.model             chat model id; unset = the newest GPT-5-class model the API lists
 *   ai.embeddings        boolean, default off (M4/Q6); needs cloudEnabled too
 *   ai.embeddingModel    embedding model id; unset = the newest text-embedding model the API lists
 *   sealed:openai        { apiKey }, sealed under the identity key exactly like the R2 tokens;
 *                        never returned by any route (GET reports only whether one is set)
 *
 * While cloudEnabled is false every AI route answers 409 and no code path
 * constructs an OpenAI client, so nothing leaves the Mac.
 */
import type { Ctx } from "../context.ts";
import { deleteSetting, getSetting, setSetting } from "../db/index.ts";
import { hasSealed, readSealed, writeSealed } from "../keystore/sealed-settings.ts";

export class AiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/** A3: named exactly, shown in Settings and returned by GET /api/ai/settings. */
export const WHAT_IS_SENT =
  "What would be sent to the OpenAI API: your question, and the passages and records the assistant retrieves while answering " +
  "(search results, timeline entries, single records and conversation excerpts that its tools return from the local index). " +
  "The model never receives the whole vault, only what those tools return. Keys, tokens and the identity key are never sent.";

export const WHAT_EMBEDDINGS_SEND =
  "With embeddings on, message text and the OCR text of screenshots and photos are sent to the OpenAI embeddings API in batches, " +
  "and each search query is embedded to find semantic matches. The local-model default is not built yet (no local model is bundled), " +
  "so semantic search exists only through OpenAI under this setting.";

export const OFF_MESSAGE = "Cloud AI is off (Settings > AI). Nothing is sent to OpenAI; search, timeline and browsing work fully without it.";

export interface AiSettings {
  cloudEnabled: boolean;
  model: string | null;
  embeddings: boolean;
  embeddingModel: string | null;
  apiKeySet: boolean;
}

export function readAiSettings(ctx: Ctx): AiSettings {
  return {
    cloudEnabled: getSetting(ctx.db, "ui.ai.cloudEnabled") === "true",
    model: getSetting(ctx.db, "ai.model") ?? null,
    embeddings: getSetting(ctx.db, "ai.embeddings") === "true",
    embeddingModel: getSetting(ctx.db, "ai.embeddingModel") ?? null,
    apiKeySet: hasSealed(ctx.db, "openai"),
  };
}

export function cloudEnabled(ctx: Ctx): boolean { return getSetting(ctx.db, "ui.ai.cloudEnabled") === "true"; }
export function embeddingsEnabled(ctx: Ctx): boolean { return cloudEnabled(ctx) && getSetting(ctx.db, "ai.embeddings") === "true" && hasSealed(ctx.db, "openai"); }

export interface AiSettingsPatch { cloudEnabled?: unknown; apiKey?: unknown; model?: unknown; embeddings?: unknown; embeddingModel?: unknown }

export function writeAiSettings(ctx: Ctx, b: AiSettingsPatch): AiSettings {
  for (const k of Object.keys(b)) {
    if (!["cloudEnabled", "apiKey", "model", "embeddings", "embeddingModel"].includes(k)) throw new AiError(400, "bad_key", `unknown AI setting ${k}`);
  }
  if (b.cloudEnabled !== undefined && typeof b.cloudEnabled !== "boolean") throw new AiError(400, "bad_value", "cloudEnabled must be a boolean");
  if (b.embeddings !== undefined && typeof b.embeddings !== "boolean") throw new AiError(400, "bad_value", "embeddings must be a boolean");
  for (const k of ["model", "embeddingModel"] as const) {
    const v = b[k];
    if (v !== undefined && v !== null && (typeof v !== "string" || !/^[A-Za-z0-9._:\-/]{1,120}$/.test(v))) throw new AiError(400, "bad_value", `${k} must be a model id`);
  }
  if (b.apiKey !== undefined && b.apiKey !== null && (typeof b.apiKey !== "string" || (b.apiKey !== "" && !/^\S{20,400}$/.test(b.apiKey)))) {
    throw new AiError(400, "bad_value", "apiKey must be an OpenAI API key (or empty to remove it)");
  }
  if (b.apiKey !== undefined) {
    if (b.apiKey === null || b.apiKey === "") deleteSetting(ctx.db, "sealed:openai");
    else writeSealed(ctx.db, ctx.keystore.secretKey(), "openai", { apiKey: b.apiKey });
  }
  if (b.cloudEnabled !== undefined) setSetting(ctx.db, "ui.ai.cloudEnabled", String(b.cloudEnabled));
  if (b.embeddings !== undefined) setSetting(ctx.db, "ai.embeddings", String(b.embeddings));
  for (const k of ["model", "embeddingModel"] as const) {
    const v = b[k];
    if (v === null || v === "") deleteSetting(ctx.db, `ai.${k}`);
    else if (typeof v === "string") setSetting(ctx.db, `ai.${k}`, v);
  }
  return readAiSettings(ctx);
}

/** The API key, only for constructing the client inside an AI route that already passed requireCloud. */
export function readApiKey(ctx: Ctx): string | null {
  if (!hasSealed(ctx.db, "openai")) return null;
  return readSealed<{ apiKey: string }>(ctx.db, ctx.keystore.secretKey(), "openai")?.apiKey ?? null;
}

/** Guard for every AI route: 409 when cloud AI is off or no key is stored. */
export function requireCloud(ctx: Ctx): string {
  if (!cloudEnabled(ctx)) throw new AiError(409, "ai_disabled", OFF_MESSAGE);
  const key = readApiKey(ctx);
  if (!key) throw new AiError(409, "ai_no_key", "Cloud AI is on but no OpenAI API key is stored (Settings > AI).");
  return key;
}
