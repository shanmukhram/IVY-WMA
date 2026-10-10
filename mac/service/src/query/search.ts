/**
 * Unified search (PRD Q1-Q5).
 *
 * Query language
 *   word            substring match (trigram index): "collab" finds "collaboration"
 *   word*           same (prefix is a substring); the star is accepted and ignored
 *   "two words"     exact phrase (contiguous, case-insensitive)
 *   -word           exclude
 *   1-2 characters  matched by a scan on the text columns (trigrams need 3+)
 *
 * Exact matches come first (FTS5 MATCH, ranked by bm25 or by time), with FTS5
 * `snippet()` highlights. Typo tolerance follows: for every unquoted term of 4+
 * characters the trigram index proposes candidates (OR of the term's trigrams),
 * and a bounded edit distance (1 for 4-7 characters, 2 for 8+) over the text
 * decides; these are labelled `match: "fuzzy"`. Everything is paginated with a
 * total count (Q5: all matches, never a sample).
 *
 * SEMANTIC SEARCH EXTENSION POINT (Q6): `SemanticProvider` below. When enabled,
 * its results are returned separately in `semantic` and are never merged into
 * the exact list.
 */
import type { Ctx } from "../context.ts";
import { ITEM_TYPES, TYPE_DEFS, filterSql, selectList, type Filters, type ItemType, type TypeDef } from "./types.ts";
import { enrich, itemView, type BaseItem } from "./details.ts";

export interface SemanticProvider {
  /** Q6: return semantically similar items; called only when the user enabled semantic search. */
  search(q: string, filters: Filters & { types: ItemType[] }, limit: number): Promise<Array<{ type: ItemType; id: string; score: number }>>;
}

export interface SearchParams extends Filters {
  q: string;
  types?: ItemType[];
  page?: number;
  pageSize?: number;
  sort?: "relevance" | "newest" | "oldest";
  typo?: boolean;
}

interface Parsed {
  phrases: string[];  // quoted
  terms: string[];    // unquoted, 3+ chars
  short: string[];    // unquoted, 1-2 chars
  negatives: string[];
}

const MARK_START = "\u0002";
const MARK_END = "\u0003";
const FUZZY_CANDIDATES_PER_TYPE = 400;

export function parseQuery(q: string): Parsed {
  const out: Parsed = { phrases: [], terms: [], short: [], negatives: [] };
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    if (m[2] !== undefined) {
      const p = m[2].trim();
      if (!p) continue;
      if (m[1] === "-") out.negatives.push(p);
      else if ([...p].length >= 3) out.phrases.push(p);
      else out.short.push(p);
      continue;
    }
    let t = m[3]!;
    let neg = false;
    if (t.startsWith("-") && t.length > 1) { neg = true; t = t.slice(1); }
    t = t.replace(/\*+$/, "").replace(/^\*+/, "");
    if (!t) continue;
    if (neg) out.negatives.push(t);
    else if ([...t].length >= 3) out.terms.push(t);
    else out.short.push(t);
  }
  return out;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** FTS5 MATCH expression for the exact query; null when no 3+ char positive term exists. */
export function matchExpr(p: Parsed): string | null {
  const pos = [...p.phrases, ...p.terms].map(quote);
  if (!pos.length) return null;
  const negs = p.negatives.filter((n) => [...n].length >= 3).map(quote);
  const base = pos.length === 1 ? pos[0]! : `(${pos.join(" AND ")})`;
  return negs.length ? `${base} NOT (${negs.join(" OR ")})` : base;
}

function shortTermSql(d: TypeDef, terms: string[], negate = false): { sql: string[]; args: unknown[] } {
  const sql: string[] = [];
  const args: unknown[] = [];
  for (const t of terms) {
    const ors = d.text.map((c) => `instr(lower(COALESCE(${c}, '')), lower(?)) > 0`);
    sql.push(negate ? `NOT (${ors.join(" OR ")})` : `(${ors.join(" OR ")})`);
    for (let i = 0; i < d.text.length; i++) args.push(t);
  }
  return { sql, args };
}

function orderBy(sort: SearchParams["sort"]): string {
  if (sort === "newest") return "event_time DESC, rid DESC";
  if (sort === "oldest") return "event_time ASC, rid ASC";
  return "score ASC, event_time DESC";
}

interface Branch { sql: string; args: unknown[]; countSql: string; countArgs: unknown[]; type: ItemType }

function exactBranch(d: TypeDef, p: Parsed, f: Filters): Branch {
  const expr = matchExpr(p);
  const flt = filterSql(d, f);
  const shortPos = shortTermSql(d, p.short);
  const shortNeg = shortTermSql(d, p.negatives.filter((n) => [...n].length < 3), true);
  const where = [...flt.sql, ...shortPos.sql, ...shortNeg.sql];
  const args = [...flt.args, ...shortPos.args, ...shortNeg.args];
  if (expr) {
    const from = `${d.fts} JOIN ${d.from}`;
    const w = `${d.fts} MATCH ? AND x.rid = ${d.fts}.rowid AND ${where.join(" AND ")}`;
    return {
      type: d.type,
      sql: `SELECT ${selectList(d)}, snippet(${d.fts}, -1, '${MARK_START}', '${MARK_END}', '…', 40) AS snippet, bm25(${d.fts}) AS score FROM ${from} WHERE ${w}`,
      args: [expr, ...args],
      countSql: `SELECT COUNT(*) AS n FROM ${from} WHERE ${w}`,
      countArgs: [expr, ...args],
    };
  }
  // only 1-2 character terms: scan
  const w = where.join(" AND ");
  return {
    type: d.type,
    sql: `SELECT ${selectList(d)}, NULL AS snippet, 0 AS score FROM ${d.from} WHERE ${w}`,
    args,
    countSql: `SELECT COUNT(*) AS n FROM ${d.from} WHERE ${w}`,
    countArgs: args,
  };
}

// ------------------------------------------------------------------ typo tolerance

export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/**
 * Approximate substring match (Sellers): the minimum edit distance (with
 * transpositions) between `pat` and any substring of `text`, plus where it ends.
 */
export function approxFind(pat: string, text: string, maxK: number): { dist: number; end: number } | null {
  const m = pat.length;
  if (m === 0) return { dist: 0, end: 0 };
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let best: { dist: number; end: number } | null = prev[m]! <= maxK ? { dist: prev[m]!, end: 0 } : null;
  for (let j = 1; j <= text.length; j++) {
    const cur = new Array<number>(m + 1);
    cur[0] = 0;
    const tc = text[j - 1];
    for (let i = 1; i <= m; i++) {
      const cost = pat[i - 1] === tc ? 0 : 1;
      let v = Math.min(prev[i]! + 1, cur[i - 1]! + 1, prev[i - 1]! + cost);
      if (i > 1 && j > 1 && pat[i - 1] === text[j - 2] && pat[i - 2] === tc) v = Math.min(v, prev2[i - 2]! + 1);
      cur[i] = v;
    }
    if (cur[m]! <= maxK && (!best || cur[m]! < best.dist)) { best = { dist: cur[m]!, end: j }; if (cur[m] === 0) break; }
    prev2 = prev;
    prev = cur;
  }
  return best;
}

export function maxTypos(term: string): number {
  const n = [...term].length;
  return n >= 8 ? 2 : n >= 4 ? 1 : 0;
}

function trigrams(t: string): string[] {
  const s = [...fold(t)];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3).join(""));
  return [...out];
}

function makeSnippet(text: string, start: number, end: number, width = 120): string {
  const a = Math.max(0, start - Math.floor((width - (end - start)) / 2));
  const b = Math.min(text.length, a + width);
  return (a > 0 ? "…" : "") + text.slice(a, start) + MARK_START + text.slice(start, end) + MARK_END + text.slice(end, b) + (b < text.length ? "…" : "");
}

interface FuzzyHit { row: BaseItem & { snippet: string | null; score: number }; dist: number }

function fuzzyBranch(ctx: Ctx, d: TypeDef, p: Parsed, f: Filters): FuzzyHit[] {
  const fuzzyTerms = p.terms.filter((t) => maxTypos(t) > 0);
  if (!fuzzyTerms.length) return [];
  const grams = [...new Set(fuzzyTerms.flatMap(trigrams))];
  if (!grams.length) return [];
  const flt = filterSql(d, f);
  const textExpr = d.text.map((c) => `COALESCE(${c}, '')`).join(" || ' \u0001 ' || ");
  const rows = ctx.db.prepare(
    `SELECT ${selectList(d)}, ${textExpr} AS fulltext, bm25(${d.fts}) AS score
     FROM ${d.fts} JOIN ${d.from}
     WHERE ${d.fts} MATCH ? AND x.rid = ${d.fts}.rowid AND ${flt.sql.join(" AND ")}
     ORDER BY bm25(${d.fts}) LIMIT ${FUZZY_CANDIDATES_PER_TYPE}`,
  ).all(grams.map(quote).join(" OR "), ...flt.args) as Array<BaseItem & { fulltext: string; score: number }>;

  const hits: FuzzyHit[] = [];
  const exactAll = [...p.phrases, ...p.terms.filter((t) => maxTypos(t) === 0), ...p.short].map(fold);
  const negs = p.negatives.map(fold);
  for (const r of rows) {
    const text = fold(r.fulltext);
    if (exactAll.some((t) => !text.includes(t))) continue;
    if (negs.some((n) => text.includes(n))) continue;
    // an exact hit for every term is already in the exact list
    if (fuzzyTerms.every((t) => text.includes(fold(t)))) continue;
    let total = 0;
    let first: { start: number; end: number } | null = null;
    let ok = true;
    for (const t of fuzzyTerms) {
      const ft = fold(t);
      const idx = text.indexOf(ft);
      if (idx >= 0) { first ??= { start: idx, end: idx + ft.length }; continue; }
      const hit = approxFind(ft, text, maxTypos(t));
      if (!hit) { ok = false; break; }
      total += hit.dist;
      first ??= { start: Math.max(0, hit.end - ft.length), end: hit.end };
    }
    if (!ok) continue;
    const raw = r.fulltext.replace(/ \u0001 /g, " · ");
    hits.push({ row: { ...stripFull(r), snippet: first ? makeSnippet(raw, first.start, first.end) : null }, dist: total });
  }
  return hits;
}

function stripFull<T extends { fulltext?: string }>(r: T): Omit<T, "fulltext"> {
  const { fulltext: _f, ...rest } = r;
  return rest;
}

// ------------------------------------------------------------------ API

export function snippetHtml(s: string | null): string | null {
  if (s === null) return null;
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc.replaceAll(MARK_START, "<mark>").replaceAll(MARK_END, "</mark>");
}

export function plainSnippet(s: string | null): string | null {
  return s === null ? null : s.replaceAll(MARK_START, "").replaceAll(MARK_END, "");
}

export class SearchError extends Error {}

export async function search(ctx: Ctx, params: SearchParams, semantic?: SemanticProvider | null) {
  const t0 = performance.now();
  const q = (params.q ?? "").trim();
  if (!q) throw new SearchError("q is required");
  const parsed = parseQuery(q);
  if (!parsed.phrases.length && !parsed.terms.length && !parsed.short.length) throw new SearchError("the query has no positive terms");
  const types = (params.types?.length ? params.types : ITEM_TYPES).filter((t) => ITEM_TYPES.includes(t));
  const pageSize = Math.min(Math.max(params.pageSize ?? 25, 1), 200);
  const page = Math.max(params.page ?? 1, 1);
  const offset = (page - 1) * pageSize;
  const filters: Filters = {
    device: params.device, app: params.app, from: params.from, to: params.to,
    person: params.person, conversation: params.conversation, account: params.account,
  };

  const branches = types.map((t) => exactBranch(TYPE_DEFS[t], parsed, filters));
  const counts: Record<string, number> = {};
  let exactTotal = 0;
  for (const b of branches) {
    const n = (ctx.db.prepare(b.countSql).get(...b.countArgs) as { n: number }).n;
    counts[b.type] = n;
    exactTotal += n;
  }

  let exactRows: Array<BaseItem & { snippet: string | null; score: number }> = [];
  if (offset < exactTotal) {
    const union = branches.filter((b) => counts[b.type]! > 0).map((b) => `SELECT * FROM (${b.sql})`).join(" UNION ALL ");
    const args = branches.filter((b) => counts[b.type]! > 0).flatMap((b) => b.args);
    exactRows = ctx.db.prepare(`${union} ORDER BY ${orderBy(params.sort)} LIMIT ? OFFSET ?`).all(...args, pageSize, offset) as typeof exactRows;
  }

  // typo-tolerant matches, after every exact match
  const fuzzyCounts: Record<string, number> = {};
  let fuzzy: FuzzyHit[] = [];
  if (params.typo !== false) {
    for (const t of types) {
      const hits = fuzzyBranch(ctx, TYPE_DEFS[t], parsed, filters);
      fuzzyCounts[t] = hits.length;
      fuzzy.push(...hits);
    }
    fuzzy.sort((a, b) => a.dist - b.dist || a.row.score - b.row.score || String(b.row.event_time).localeCompare(String(a.row.event_time)));
  }
  const fuzzyTotal = fuzzy.length;
  const remaining = pageSize - exactRows.length;
  const fuzzyOffset = Math.max(0, offset - exactTotal);
  const fuzzyPage = remaining > 0 ? fuzzy.slice(fuzzyOffset, fuzzyOffset + remaining) : [];
  fuzzy = [];

  const pageRows = [
    ...exactRows.map((r) => ({ r, match: "exact" as const, dist: 0 })),
    ...fuzzyPage.map((h) => ({ r: h.row, match: "fuzzy" as const, dist: h.dist })),
  ];
  const enriched = enrich(ctx, pageRows.map((p) => p.r));
  const items = pageRows.map((p, i) => ({
    ...itemView(enriched[i]!),
    match: p.match,
    typos: p.dist,
    score: p.r.score,
    snippet: plainSnippet(p.r.snippet) ?? (p.r.body ?? "").slice(0, 160),
    snippetHtml: snippetHtml(p.r.snippet) ?? snippetHtml((p.r.body ?? "").slice(0, 160)),
  }));

  const groups: Array<{ type: string; items: typeof items }> = [];
  for (const it of items) {
    let g = groups.find((x) => x.type === it.type);
    if (!g) { g = { type: it.type, items: [] }; groups.push(g); }
    g.items.push(it);
  }

  let semanticOut: { enabled: boolean; label: string; items: unknown[] } = { enabled: false, label: "Semantic matches (not enabled)", items: [] };
  if (semantic) {
    const hits = await semantic.search(q, { ...filters, types }, pageSize);
    semanticOut = { enabled: true, label: "Semantic matches", items: hits };
  }

  const total = exactTotal + fuzzyTotal;
  return {
    q, parsed, page, pageSize, total, exactTotal, fuzzyTotal,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    counts: Object.fromEntries(types.map((t) => [t, { exact: counts[t] ?? 0, fuzzy: fuzzyCounts[t] ?? 0 }])),
    items, groups, semantic: semanticOut,
    tookMs: Math.round(performance.now() - t0),
  };
}
