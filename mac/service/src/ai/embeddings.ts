/**
 * Embeddings and semantic search (PRD M4, Q6).
 *
 * Pipeline shape: an `Embedder` turns text into vectors; a job embeds message
 * text and media OCR text that has no vector yet for the current model and
 * stores them in `embeddings` (float32, L2-normalised); semantic search embeds
 * the query and ranks stored vectors by cosine similarity. The results are
 * returned in search's separate `semantic` section ("Semantic matches"), never
 * merged into the exact list.
 *
 * Providers:
 * - OpenAI embeddings: used only when cloud AI AND `ai.embeddings` are on.
 * - Local model (the PRD default): TODO. No local model is bundled yet; the
 *   `LocalEmbedder` below is the interface it will implement (e.g. a small
 *   CoreML / ONNX text and image encoder run by a helper like mac/ocr). Until
 *   then semantic search is off unless the OpenAI setting is on, and Settings
 *   says so.
 */
import { createHash } from "node:crypto";
import type { Ctx } from "../context.ts";
import type { SemanticProvider } from "../query/search.ts";
import { TYPE_DEFS, filterSql, selectList, type Filters, type ItemType } from "../query/types.ts";
import { enrich, itemView, type BaseItem } from "../query/details.ts";
import { nowIso } from "../util/time.ts";
import { embeddingsEnabled, readAiSettings, requireCloud } from "./settings.ts";
import { openaiClient, resolveEmbeddingModel, upstream } from "./openai.ts";

export interface Embedder {
  readonly provider: "openai" | "local";
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** TODO(M4 local default): bundle a local text/image encoder and implement this. */
export class LocalEmbedder implements Embedder {
  readonly provider = "local" as const;
  readonly model = "local-unavailable";
  async embed(): Promise<Float32Array[]> { throw new Error("no local embedding model is bundled yet (TODO)"); }
}

const EMBEDDABLE: Array<{ type: ItemType; sql: string }> = [
  { type: "message", sql: "SELECT x.id, 'message' AS type, x.text AS text FROM messages x WHERE x.deleted_at IS NULL AND length(trim(x.text)) > 0" },
  { type: "screenshot", sql: "SELECT x.id, x.kind AS type, x.ocr_text AS text FROM media x WHERE x.deleted_at IS NULL AND x.ocr_text IS NOT NULL AND length(trim(x.ocr_text)) > 0" },
];
const MAX_CHARS = 6000; // per input, well under the embedding models' token limits
const BATCH = 64;

function normalise(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= n;
  return out;
}
const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export async function openaiEmbedder(ctx: Ctx): Promise<Embedder> {
  const key = requireCloud(ctx);
  const client = openaiClient(ctx, key);
  const model = await resolveEmbeddingModel(ctx, client, readAiSettings(ctx).embeddingModel);
  return {
    provider: "openai", model,
    async embed(texts) {
      try {
        const r = await client.embeddings.create({ model, input: texts.map((t) => t.slice(0, MAX_CHARS)) });
        const rows = [...r.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return rows.map((d) => normalise(d.embedding));
      } catch (e) { throw upstream(e); }
    },
  };
}

export interface EmbedRunResult { model: string; embedded: number; remaining: number }

/** Embed up to `limit` items that have no vector for the embedder's model. */
export async function runEmbeddingJob(ctx: Ctx, embedder: Embedder, limit = 512): Promise<EmbedRunResult> {
  let embedded = 0;
  const pending = () => EMBEDDABLE.map((e) => `SELECT * FROM (${e.sql}) s WHERE NOT EXISTS (SELECT 1 FROM embeddings em WHERE em.item_id = s.id AND em.model = ?)`).join(" UNION ALL ");
  const args = () => EMBEDDABLE.map(() => embedder.model);
  while (embedded < limit) {
    const rows = ctx.db.prepare(`${pending()} LIMIT ?`).all(...args(), Math.min(BATCH, limit - embedded)) as Array<{ id: string; type: string; text: string }>;
    if (!rows.length) break;
    const vecs = await embedder.embed(rows.map((r) => r.text));
    const ins = ctx.db.prepare(`INSERT INTO embeddings(item_type, item_id, provider, model, dims, vector, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(item_type, item_id, model) DO UPDATE SET vector = excluded.vector, dims = excluded.dims, created_at = excluded.created_at`);
    const at = nowIso();
    ctx.db.transaction(() => { rows.forEach((r, i) => ins.run(r.type, r.id, embedder.provider, embedder.model, vecs[i]!.length, toBlob(vecs[i]!), at)); })();
    embedded += rows.length;
  }
  const remaining = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (${pending()})`).get(...args()) as { n: number }).n;
  if (embedded) ctx.events.emit("ai.embedded", { model: embedder.model, embedded, remaining });
  return { model: embedder.model, embedded, remaining };
}

export function embeddingStatus(ctx: Ctx) {
  const byModel = ctx.db.prepare("SELECT provider, model, item_type AS type, COUNT(*) AS n FROM embeddings GROUP BY provider, model, item_type").all();
  return { enabled: embeddingsEnabled(ctx), localModel: "not bundled yet (TODO); semantic search needs the OpenAI embeddings setting", stored: byModel };
}

/** Cosine search over stored vectors; filters apply after ranking. */
export function cosineSearch(ctx: Ctx, query: Float32Array, model: string, filters: Filters & { types: ItemType[] }, limit: number) {
  const types = filters.types.filter((t) => t === "message" || t === "screenshot" || t === "photo");
  if (!types.length) return [];
  const rows = ctx.db.prepare(`SELECT item_type, item_id, vector FROM embeddings WHERE model = ? AND item_type IN (${types.map(() => "?").join(",")})`).all(model, ...types) as Array<{ item_type: ItemType; item_id: string; vector: Buffer }>;
  const scored: Array<{ type: ItemType; id: string; score: number }> = [];
  for (const r of rows) {
    const v = fromBlob(r.vector);
    if (v.length !== query.length) continue;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i]! * query[i]!;
    scored.push({ type: r.item_type, id: r.item_id, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: Array<{ type: ItemType; id: string; score: number; title: string | null; snippet: string | null; eventTime: string | null; detail: Record<string, unknown> }> = [];
  for (const c of scored.slice(0, limit * 4)) {
    if (out.length >= limit) break;
    const d = TYPE_DEFS[c.type];
    const f = filterSql(d, filters);
    const row = ctx.db.prepare(`SELECT ${selectList(d)} FROM ${d.from} WHERE x.id = ? AND ${f.sql.join(" AND ")}`).get(c.id, ...f.args) as BaseItem | undefined;
    if (!row) continue; // in the bin, or outside the filters
    const v = itemView(enrich(ctx, [row])[0]!);
    out.push({ type: c.type, id: c.id, score: c.score, title: v.title, snippet: (v.body ?? "").slice(0, 160), eventTime: v.eventTime, detail: v.detail });
  }
  return out;
}

/** The Q6 provider wired into GET /api/search while embeddings are enabled. A failure never breaks exact search. */
export function semanticProvider(ctx: Ctx): SemanticProvider & { lastError: string | null } {
  const cache = new Map<string, Float32Array>();
  const p = {
    lastError: null as string | null,
    async search(q: string, filters: Filters & { types: ItemType[] }, limit: number) {
      try {
        const emb = await openaiEmbedder(ctx);
        const k = createHash("sha256").update(`${emb.model}\u0000${q}`).digest("hex");
        let v = cache.get(k);
        if (!v) {
          v = (await emb.embed([q]))[0]!;
          cache.set(k, v);
          if (cache.size > 200) cache.delete(cache.keys().next().value!);
        }
        p.lastError = null;
        return cosineSearch(ctx, v, emb.model, filters, Math.min(limit, 25));
      } catch (e) {
        p.lastError = (e as Error).message;
        return [];
      }
    },
  };
  return p;
}
