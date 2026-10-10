/**
 * Day timeline (PRD T1, T3, T4, T5): every source merged in ORIGINAL event-time
 * order (sent_at, posted_at, taken_at/saved_at, mtime, started_at), with capture
 * times kept separately on each item, hour groups for expand/collapse,
 * pagination over all records, and coverage gaps computed from collector state.
 */
import type { Ctx } from "../context.ts";
import { ITEM_TYPES, TYPE_DEFS, filterSql, selectList, type ItemType } from "./types.ts";
import { enrich, itemView, type BaseItem } from "./details.ts";
import { gapsAll, gapsFor } from "./coverage.ts";
import { dayBounds, msOf } from "../util/time.ts";

export interface TimelineParams {
  date?: string;           // YYYY-MM-DD in tz
  from?: string;           // or an explicit [from, to)
  to?: string;
  tz?: string;             // IANA zone or offset minutes; default the Mac's zone
  device?: string;
  types?: ItemType[];
  page?: number;
  pageSize?: number;
}

export class TimelineError extends Error {}

export function timeline(ctx: Ctx, p: TimelineParams, now = Date.now()) {
  let start: string, end: string, tz: string;
  if (p.date) ({ start, end, tz } = dayBounds(p.date, p.tz));
  else if (p.from && p.to) { start = new Date(p.from).toISOString(); end = new Date(p.to).toISOString(); tz = p.tz ?? "UTC"; }
  else throw new TimelineError("date (YYYY-MM-DD) or from+to is required");
  const types = (p.types?.length ? p.types : ITEM_TYPES).filter((t) => ITEM_TYPES.includes(t));
  const pageSize = Math.min(Math.max(p.pageSize ?? 100, 1), 500);
  const page = Math.max(p.page ?? 1, 1);

  const parts = types.map((t) => {
    const d = TYPE_DEFS[t];
    const f = filterSql(d, { device: p.device, from: start, to: end });
    return { sql: `SELECT ${selectList(d)} FROM ${d.from} WHERE ${f.sql.join(" AND ")}`, args: f.args, type: t };
  });
  const union = parts.map((x) => `SELECT * FROM (${x.sql})`).join(" UNION ALL ");
  const args = parts.flatMap((x) => x.args);

  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (${union})`).get(...args) as { n: number }).n;
  const rows = ctx.db.prepare(`SELECT * FROM (${union}) ORDER BY event_time ASC, type ASC, rid ASC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as BaseItem[];
  const counts = Object.fromEntries((ctx.db.prepare(`SELECT type, COUNT(*) AS n FROM (${union}) GROUP BY type`).all(...args) as Array<{ type: string; n: number }>).map((r) => [r.type, r.n]));

  // hour groups (T3): counts per local hour of the requested window
  const startMs = msOf(start)!;
  const hourRows = ctx.db.prepare(`SELECT CAST((unixepoch(event_time, 'subsec') * 1000 - ?) / 3600000 AS INTEGER) AS h, COUNT(*) AS n FROM (${union}) GROUP BY h ORDER BY h`)
    .all(startMs, ...args) as Array<{ h: number; n: number }>;
  const hours = hourRows.map((r) => ({ index: r.h, from: new Date(startMs + r.h * 3600_000).toISOString(), to: new Date(startMs + (r.h + 1) * 3600_000).toISOString(), count: r.n }));

  const gaps = p.device && p.device !== "windows" && p.device !== "android"
    ? gapsFor(ctx, p.device, start, end, now)
    : gapsAll(ctx, start, end, now).filter((g) => !p.device || g.role === p.device);

  const items = enrich(ctx, rows).map(itemView);
  return {
    window: { from: start, to: end, tz }, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)),
    counts, hours, gaps, items,
    unavailable: unavailableSources(ctx),
  };
}

/** Sources with no paired device at all (shown on the timeline as unavailable, T5). */
function unavailableSources(ctx: Ctx): Array<{ role: string; reason: string }> {
  const roles = new Set((ctx.db.prepare("SELECT DISTINCT role FROM devices").all() as Array<{ role: string }>).map((r) => r.role));
  return ["windows", "android"].filter((r) => !roles.has(r)).map((role) => ({ role, reason: "no paired device" }));
}
