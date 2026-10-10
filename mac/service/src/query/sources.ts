/**
 * Multi-source conversations (PRD WX1, C8, C9): coverage is claimed per capture
 * source (`<role>:<collector>`, PROTOCOL §6 message_batch.sourceSession) and a
 * message lists every source that delivered it.
 */
import type { DB } from "../db/index.ts";

export type Coverage = "complete" | "partial" | "notification_only";
export const COVERAGE_RANK: Record<Coverage, number> = { notification_only: 0, partial: 1, complete: 2 };
const RANKED: Coverage[] = ["notification_only", "partial", "complete"];

export const isNotificationSource = (source: string): boolean => source.endsWith(":notification");

/**
 * What the vault counts for a source's claim, whatever the batch says: a notification source never
 * counts above `partial` (it only sees what was shown), and LINE from a Windows source never above
 * `partial` (WL2: the PC holds a mirror of what the phone synced).
 */
export function effectiveClaim(source: string, platform: string, claim: Coverage): Coverage {
  const cap = isNotificationSource(source) || (platform === "line" && source.startsWith("windows:")) ? "partial" : "complete";
  return COVERAGE_RANK[claim] <= COVERAGE_RANK[cap] ? claim : cap;
}

export function parseCoverageBySource(json: string | null | undefined): Record<string, Coverage> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, Coverage> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v in COVERAGE_RANK) out[k] = v as Coverage;
    return out;
  } catch { return {}; }
}

/** Sources ordered best claim first, then by name. */
export function sortedSources(by: Record<string, Coverage>): Array<{ source: string; coverage: Coverage }> {
  return Object.entries(by)
    .map(([source, coverage]) => ({ source, coverage }))
    .sort((a, b) => COVERAGE_RANK[b.coverage] - COVERAGE_RANK[a.coverage] || a.source.localeCompare(b.source));
}

/** The displayed coverage: the best any source claims (`fallback` when no source has claimed yet). */
export function bestCoverage(by: Record<string, Coverage>, fallback: Coverage = "notification_only"): Coverage {
  let best = -1;
  for (const c of Object.values(by)) best = Math.max(best, COVERAGE_RANK[c]);
  return best < 0 ? fallback : RANKED[best]!;
}

/** "complete via windows:telegram-desktop; partial via android:notification" */
export function coverageText(by: Record<string, Coverage>): string {
  return sortedSources(by).map((s) => `${s.coverage} via ${s.source}`).join("; ");
}

/** API shape: `coverageBySource` (source -> claim), the same ordered best first, and the reading line. */
export function coverageView(json: string | null | undefined) {
  const by = parseCoverageBySource(json);
  return { coverageBySource: by, coverageSources: sortedSources(by), coverageText: coverageText(by) };
}

export const stableJson = (by: Record<string, Coverage>): string =>
  JSON.stringify(Object.fromEntries(Object.keys(by).sort().map((k) => [k, by[k]])));

export interface MessageSource { source: string; deviceId: string | null; capturedAt: string; lastSeenAt: string; deletedAtSource: string | null }

/** Provenance rows for a set of messages, oldest first. */
export function messageSources(db: DB, ids: string[]): Map<string, MessageSource[]> {
  const out = new Map<string, MessageSource[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT message_id, source_session, device_id, captured_at, last_seen_at, source_deleted_at FROM message_sources
                             WHERE message_id IN (${chunk.map(() => "?").join(",")}) ORDER BY captured_at, rid`).all(...chunk) as Array<{
      message_id: string; source_session: string; device_id: string | null; captured_at: string; last_seen_at: string; source_deleted_at: string | null;
    }>;
    for (const r of rows) {
      const l = out.get(r.message_id) ?? [];
      l.push({ source: r.source_session, deviceId: r.device_id, capturedAt: r.captured_at, lastSeenAt: r.last_seen_at, deletedAtSource: r.source_deleted_at });
      out.set(r.message_id, l);
    }
  }
  return out;
}
