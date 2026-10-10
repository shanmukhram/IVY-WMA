/**
 * The assistant's tools (A1). Each runs against the LOCAL index only and returns
 * a compact JSON view; this is the only vault content the model ever receives.
 * Every record a tool returns is remembered (`seen`), and an answer may only
 * cite records from that set (A2).
 */
import type { Ctx } from "../context.ts";
import { search } from "../query/search.ts";
import { timeline } from "../query/timeline.ts";
import { coverage } from "../query/coverage.ts";
import { enrich, itemView, type BaseItem } from "../query/details.ts";
import { ITEM_TYPES, TYPE_DEFS, selectList, type ItemType } from "../query/types.ts";
import { parseBound, localZone } from "../util/time.ts";
import { activityVaultCoverage } from "../imports/activity-vault.ts";

export type Seen = Record<string, string>; // record id -> type

const MAX_TOOL_CHARS = 14_000;
const SNIP = 300;

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "search",
      description: "Full-text search of the local vault (messages, notifications, screenshots/photos by OCR text, files, app usage, calls, Google activity). " +
        "Words match substrings; \"quoted phrase\" is exact; -word excludes. Returns up to 10 records per page with ids, original times and snippets, plus total counts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          filters: {
            type: "object",
            properties: {
              type: { type: "string", description: `comma-separated types: ${ITEM_TYPES.join(", ")}` },
              device: { type: "string" }, app: { type: "string" }, person: { type: "string" },
              conversation: { type: "string" }, account: { type: "string" },
              from: { type: "string", description: "YYYY-MM-DD or ISO time" }, to: { type: "string", description: "YYYY-MM-DD (inclusive) or ISO time" },
              sort: { type: "string", enum: ["relevance", "newest", "oldest"] },
            },
            additionalProperties: false,
          },
          page: { type: "integer", minimum: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "timeline",
      description: "Everything recorded on one day (local time of the Mac), in original event-time order, with coverage gaps and unavailable sources. Returns up to 60 records per page.",
      parameters: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, page: { type: "integer", minimum: 1 } }, required: ["date"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_record",
      description: "One record in full (message text, OCR text of a screenshot, file path, ...) by its id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "open_conversation",
      description: "The conversation around a message: the messages before and after it, with ids, senders and original times.",
      parameters: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "coverage",
      description: "What the vault covers: devices, collectors and their status, known gaps, and the Activity Vault import. Use it to say what may be missing.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]["function"]["name"];

const clip = (s: string | null | undefined, n = SNIP) => (s == null ? null : s.length > n ? s.slice(0, n) + "…" : s);

function compact(it: ReturnType<typeof itemView> & { snippet?: string | null }, full = false) {
  const d = it.detail ?? {};
  return {
    id: it.id, type: it.type, time: it.eventTime, timeField: it.timeField, app: it.app, title: it.title, person: it.person,
    text: full ? clip(it.body, 4000) : clip(it.snippet ?? it.body),
    ...(d.conversationId ? { conversationId: d.conversationId, platform: d.platform, account: d.account } : {}),
    ...(d.partial ? { partial: "notification preview, not the full conversation" } : {}),
    ...(d.availability ? { fileAvailability: d.availability } : {}),
    ...(d.link ? { link: d.link, product: d.product } : {}),
    ...(d.sourceStatus === "deleted_at_source" ? { deletedAtSource: true } : {}),
  };
}

function remember(seen: Seen, items: Array<{ id: string; type: string }>) { for (const i of items) seen[i.id] = i.type; }

function fetchRecord(ctx: Ctx, id: string, hint?: string) {
  const order = (hint && ITEM_TYPES.includes(hint as ItemType) ? [hint as ItemType, ...ITEM_TYPES.filter((t) => t !== hint)] : ITEM_TYPES);
  for (const t of order) {
    const d = TYPE_DEFS[t];
    const row = ctx.db.prepare(`SELECT ${selectList(d).replace("substr(COALESCE(", "(COALESCE(").replace("), 1, 400) AS body", ")) AS body")} FROM ${d.from} WHERE x.id = ? AND x.deleted_at IS NULL${d.where ? ` AND ${d.where}` : ""}`).get(id) as BaseItem | undefined;
    if (row) return itemView(enrich(ctx, [row])[0]!);
  }
  return null;
}

export interface ToolEnv { ctx: Ctx; seen: Seen; tz?: string }

export async function runTool(env: ToolEnv, name: string, rawArgs: string): Promise<{ output: unknown; summary: string }> {
  const { ctx, seen } = env;
  let args: Record<string, any>;
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { output: { error: "arguments are not valid JSON" }, summary: `${name}: bad arguments` }; }
  try {
    if (name === "search") {
      const f = (args.filters ?? {}) as Record<string, string | undefined>;
      const types = f.type ? (String(f.type).split(",").map((s) => s.trim()).filter((t) => ITEM_TYPES.includes(t as ItemType)) as ItemType[]) : undefined;
      const r = await search(ctx, {
        q: String(args.query ?? ""), types, device: f.device, app: f.app, person: f.person, conversation: f.conversation, account: f.account,
        from: parseBound(f.from), to: parseBound(f.to, true), page: Number(args.page) || 1, pageSize: 10,
        sort: (f.sort as "relevance" | "newest" | "oldest") ?? "relevance",
      }, null);
      const items = r.items.map((i) => ({ ...compact(i), match: i.match }));
      remember(seen, items);
      return { output: { query: r.q, total: r.total, exactTotal: r.exactTotal, fuzzyTotal: r.fuzzyTotal, page: r.page, pages: r.pages, counts: r.counts, items }, summary: `search "${r.q}": ${r.total} match(es)` };
    }
    if (name === "timeline") {
      const r = timeline(ctx, { date: String(args.date ?? ""), tz: env.tz ?? localZone(), page: Number(args.page) || 1, pageSize: 60 });
      const items = r.items.map((i) => compact(i));
      remember(seen, items);
      return {
        output: {
          window: r.window, total: r.total, page: r.page, pages: r.pages, counts: r.counts, items,
          gaps: r.gaps.map((g) => ({ role: g.role, collector: g.collector, from: g.from, to: g.to, reason: g.reason })),
          unavailableSources: r.unavailable,
        },
        summary: `timeline ${args.date}: ${r.total} record(s)`,
      };
    }
    if (name === "get_record") {
      const rec = fetchRecord(ctx, String(args.id ?? ""), seen[String(args.id ?? "")]);
      if (!rec) return { output: { error: "no such record (or it is in the recovery bin)" }, summary: "get_record: not found" };
      let extra: Record<string, unknown> = {};
      if (rec.type === "screenshot" || rec.type === "photo") {
        const m = ctx.db.prepare("SELECT substr(ocr_text, 1, 4000) AS t, ocr_status FROM media WHERE id = ?").get(rec.id) as { t: string | null; ocr_status: string };
        extra = { ocrText: m.t, ocrStatus: m.ocr_status };
      }
      const out = { ...compact(rec, true), ...extra };
      remember(seen, [out]);
      return { output: out, summary: `get_record ${rec.type}` };
    }
    if (name === "open_conversation") {
      const mid = String(args.messageId ?? "");
      const m = ctx.db.prepare("SELECT conversation_id, sent_at, rid FROM messages WHERE id = ? AND deleted_at IS NULL").get(mid) as { conversation_id: string; sent_at: string; rid: number } | undefined;
      if (!m) return { output: { error: "no such message" }, summary: "open_conversation: not found" };
      const conv = ctx.db.prepare("SELECT id, platform, account, COALESCE(peer, conv_key) AS name, kind, coverage FROM conversations WHERE id = ?").get(m.conversation_id);
      const cols = "id, sender, sent_at AS time, substr(text, 1, 1000) AS text, source_status AS sourceStatus";
      const older = ctx.db.prepare(`SELECT ${cols} FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND (sent_at < ? OR (sent_at = ? AND rid < ?)) ORDER BY sent_at DESC, rid DESC LIMIT 15`).all(m.conversation_id, m.sent_at, m.sent_at, m.rid).reverse();
      const newer = ctx.db.prepare(`SELECT ${cols} FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND (sent_at > ? OR (sent_at = ? AND rid >= ?)) ORDER BY sent_at ASC, rid ASC LIMIT 16`).all(m.conversation_id, m.sent_at, m.sent_at, m.rid);
      const messages = [...older, ...newer] as Array<{ id: string }>;
      remember(seen, messages.map((x) => ({ id: x.id, type: "message" })));
      return { output: { conversation: conv, around: mid, messages }, summary: `open_conversation: ${messages.length} message(s)` };
    }
    if (name === "coverage") {
      const c = coverage(ctx);
      return {
        output: {
          status: c.status, locked: c.locked, unpairedRoles: c.unpairedRoles,
          problems: c.problems.map((p) => p.message),
          devices: c.devices.map((d) => ({
            role: d.role, status: d.status, lastReportAt: d.lastReportAt, counts: d.counts,
            collectors: d.collectors.map((x) => ({ name: x.name, enabled: x.enabled, status: x.status, reason: x.statusReason, lastRunAt: x.lastRunAt, captures: x.captureKind })),
            gapsLast7Days: d.gaps.map((g) => ({ collector: g.collector, from: g.from, to: g.to, reason: g.reason })),
          })),
          imports: [activityVaultCoverage(ctx)],
        },
        summary: "coverage",
      };
    }
    return { output: { error: `unknown tool ${name}` }, summary: `unknown tool ${name}` };
  } catch (e) {
    return { output: { error: (e as Error).message }, summary: `${name}: ${(e as Error).message}` };
  }
}

/** Serialise a tool result for the model, bounded. */
export function toolContent(output: unknown): string {
  const s = JSON.stringify(output);
  if (s.length <= MAX_TOOL_CHARS) return s;
  return JSON.stringify({ truncated: true, note: "result too long; narrow the query or page", partial: s.slice(0, MAX_TOOL_CHARS) });
}

/** Item views for the records an answer cites (only ones still present and not in the bin). */
export function resolveRecords(ctx: Ctx, ids: string[], seen: Seen) {
  const out: Array<ReturnType<typeof itemView>> = [];
  for (const id of [...new Set(ids)]) {
    const r = fetchRecord(ctx, id, seen[id]);
    if (r) out.push({ ...r, body: clip(r.body, 400) });
  }
  return out;
}
