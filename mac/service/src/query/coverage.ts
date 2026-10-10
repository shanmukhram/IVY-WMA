/**
 * Coverage (PRD D1-D5, principle 4 "never lie about coverage") and the
 * coverage gaps the timeline shows (T5).
 *
 * Everything here is computed from what devices actually reported
 * (collector_state / collector_history from device_report) and from what the
 * vault actually holds. A collector that stops reporting turns amber, then red,
 * and leaves a gap from its last run to now; nothing is inferred to fill it.
 */
import type { Ctx } from "../context.ts";
import { getSetting } from "../db/index.ts";
import { msOf, nowIso } from "../util/time.ts";
import { ROLES } from "../r2/config.ts";

export type Dot = "green" | "amber" | "red" | "off";

/** What each collector captures (D4). */
export const COLLECTOR_INFO: Record<string, { captures: string; kind: string }> = {
  files: { kind: "metadata", captures: "File index: path, name, size, modified time and a quick hash, plus thumbnails for images and PDFs. Originals only on request." },
  screenshots: { kind: "media", captures: "Screenshot images (originals), OCR'd on the Mac." },
  usage: { kind: "metadata", captures: "Foreground app spans with window titles when title capture is on (excluded titles are marked)." },
  notifications: { kind: "previews", captures: "Notifications as shown: app, title, text and sender. Partial records, not conversations." },
  calls: { kind: "metadata", captures: "Call log: direction, contact, number, start time and duration." },
  messages: { kind: "full_messages", captures: "Conversation history from rooted database reads (complete, partial or notification-only per app)." },
  photos: { kind: "media", captures: "Photos (originals) with capture and save times." },
};

const RANK: Record<Dot, number> = { off: 0, green: 1, amber: 2, red: 3 };
const worst = (a: Dot, b: Dot): Dot => (RANK[a] >= RANK[b] ? a : b);

export function ageDot(ctx: Ctx, iso: string | null, now: number): Dot {
  const ms = msOf(iso);
  if (ms === null) return "red";
  const age = now - ms;
  if (age > ctx.config.redAfterMs) return "red";
  if (age > ctx.config.amberAfterMs) return "amber";
  return "green";
}

export interface CollectorRow {
  device_id: string; name: string; enabled: number; last_run_at: string | null; cursor: string | null;
  queue_depth: number; reported_at: string; first_reported_at: string;
}

export function collectorStatus(ctx: Ctx, c: CollectorRow, deviceLastReport: string | null, now: number): { dot: Dot; reason: string } {
  if (!c.enabled) return { dot: "off", reason: "disabled on the device" };
  if (!c.last_run_at) return { dot: "red", reason: "has never run" };
  const run = ageDot(ctx, c.last_run_at, now);
  const rep = ageDot(ctx, deviceLastReport, now);
  const dot = worst(run, rep);
  if (dot === "green") return { dot, reason: "running" };
  if (rep !== "green" && RANK[rep] >= RANK[run]) return { dot, reason: `no device report for ${fmtAge(now - (msOf(deviceLastReport) ?? 0))}` };
  return { dot, reason: `last run ${fmtAge(now - msOf(c.last_run_at)!)} ago` };
}

export function fmtAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** Import progress from what the device reported, if it reported a total (cursor JSON with total/expected). */
function importProgress(ctx: Ctx, deviceId: string, c: CollectorRow) {
  if (c.name !== "files" && c.name !== "messages" && c.name !== "photos") return null;
  let indexed = 0;
  if (c.name === "files") indexed = (ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE device_id = ? AND source_status = 'live' AND deleted_at IS NULL").get(deviceId) as { n: number }).n;
  if (c.name === "messages") indexed = (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_id = ?").get(deviceId) as { n: number }).n;
  if (c.name === "photos") indexed = (ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE device_id = ? AND kind = 'photo'").get(deviceId) as { n: number }).n;
  let total: number | null = null;
  try {
    const cur = c.cursor ? (JSON.parse(c.cursor) as Record<string, unknown>) : null;
    const t = cur && (cur.total ?? cur.expected ?? cur.totalFiles);
    if (typeof t === "number" && t >= 0) total = t;
  } catch { /* cursor is not JSON (e.g. "scan:<time>") */ }
  const fullScan = c.cursor?.startsWith("scan:") ? c.cursor.slice(5) : null;
  return {
    indexed, total,
    percent: total ? Math.min(100, Math.round((indexed / total) * 100)) : null,
    state: total !== null ? (indexed >= total ? "complete" : "in_progress") : fullScan ? "full_scan_reported" : "unknown",
    lastFullScanAt: fullScan,
    note: total === null ? "the device does not report a total for this collector; the count is what the vault holds" : null,
  };
}

export interface Problem { severity: "red" | "amber"; source: { deviceId?: string; role?: string; collector?: string; bucket?: string }; message: string }

export function coverage(ctx: Ctx, now = Date.now()) {
  const devices = ctx.db.prepare("SELECT * FROM devices ORDER BY paired_at").all() as Array<{
    id: string; role: string; fingerprint: string; paired_at: string; last_seen: string | null; last_report_at: string | null;
    app_version: string | null; queue_depth_total: number | null;
  }>;
  const problems: Problem[] = [];
  const unlocked = ctx.keystore.isUnlocked();
  if (!unlocked) problems.push({ severity: "amber", source: {}, message: "The vault is locked: nothing is ingested until it is unlocked." });
  if (!ctx.r2Configured()) problems.push({ severity: "red", source: {}, message: "R2 is not configured." });

  const buckets: Array<Record<string, unknown>> = [];
  for (const row of ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'poll:%'").all() as Array<{ key: string; value: string }>) {
    const name = row.key.slice(5);
    const p = JSON.parse(row.value) as { at: string; ok: boolean; error: string | null; lastOkAt: string | null };
    buckets.push({ bucket: name, lastPollAt: p.at, lastSuccessAt: p.lastOkAt, ok: p.ok, error: p.error, marker: getSetting(ctx.db, `marker:${name}`) ?? null });
    if (!p.ok) problems.push({ severity: "red", source: { bucket: name }, message: `Polling ${name} failed: ${p.error}` });
  }

  const openQuarantine = ctx.db.prepare("SELECT bucket, COUNT(*) AS n, MAX(created_at) AS latest FROM quarantine WHERE resolved_at IS NULL GROUP BY bucket").all() as Array<{ bucket: string; n: number; latest: string }>;
  for (const q of openQuarantine) {
    const last = ctx.db.prepare("SELECT reason, object_key FROM quarantine WHERE bucket = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1").get(q.bucket) as { reason: string; object_key: string };
    problems.push({ severity: "amber", source: { bucket: q.bucket }, message: `${q.n} object(s) quarantined in ${q.bucket}; latest ${last.object_key}: ${last.reason}` });
  }

  const deviceViews = devices.map((d) => {
    const collectors = ctx.db.prepare("SELECT * FROM collector_state WHERE device_id = ? ORDER BY name").all(d.id) as CollectorRow[];
    const reportDot: Dot = ageDot(ctx, d.last_report_at, now);
    let dot: Dot = reportDot;
    const colViews = collectors.map((c) => {
      const s = collectorStatus(ctx, c, d.last_report_at, now);
      dot = worst(dot, s.dot);
      if (s.dot === "red" || s.dot === "amber") problems.push({ severity: s.dot, source: { deviceId: d.id, role: d.role, collector: c.name }, message: `${d.role} ${c.name}: ${s.reason}` });
      return {
        name: c.name, enabled: !!c.enabled, lastRunAt: c.last_run_at, lastReportAt: c.reported_at, firstReportedAt: c.first_reported_at,
        queueDepth: c.queue_depth, cursor: c.cursor, status: s.dot, statusReason: s.reason,
        captures: COLLECTOR_INFO[c.name]?.captures ?? "Reported by the device; no description on the Mac yet.",
        captureKind: COLLECTOR_INFO[c.name]?.kind ?? "unknown",
        import: importProgress(ctx, d.id, c),
      };
    });
    if (!d.last_report_at) problems.push({ severity: "red", source: { deviceId: d.id, role: d.role }, message: `${d.role} has paired but never sent a device report` });
    else if (reportDot !== "green") problems.push({ severity: reportDot === "red" ? "red" : "amber", source: { deviceId: d.id, role: d.role }, message: `${d.role}: last device report ${fmtAge(now - msOf(d.last_report_at)!)} ago` });

    const role = d.role;
    const pending = ctx.db.prepare(`SELECT oid, status, payload_kind, committed_parts, total_chunks, committed_bytes, total_size, updated_at, first_seen_at
                                    FROM blobs WHERE status IN ('awaiting_manifest','assembling')
                                      AND (device_id = ? OR (device_id IS NULL AND role = ?))`)
      .all(d.id, role) as Array<{ oid: string; status: string; payload_kind: string | null; committed_parts: string; total_chunks: number | null; committed_bytes: number; total_size: number | null; updated_at: string; first_seen_at: string }>;
    for (const b of pending) {
      if (now - (msOf(b.updated_at) ?? now) > 3600_000) problems.push({ severity: "amber", source: { deviceId: d.id, role }, message: `blob ${b.oid} (${b.payload_kind ?? "no manifest yet"}) has not progressed for ${fmtAge(now - msOf(b.updated_at)!)}` });
    }
    const quarantined = (ctx.db.prepare("SELECT COUNT(*) AS n FROM quarantine WHERE resolved_at IS NULL AND (device_id = ? OR (device_id IS NULL AND role = ?))").get(d.id, role) as { n: number }).n;
    const failedCommands = ctx.db.prepare("SELECT id, type, status, detail FROM commands WHERE device_id = ? AND status IN ('error','not_found','access_denied','too_large','expired') AND issued_at > ?")
      .all(d.id, new Date(now - 7 * 86400_000).toISOString()) as Array<{ id: string; type: string; status: string; detail: string | null }>;
    for (const c of failedCommands) problems.push({ severity: "amber", source: { deviceId: d.id, role }, message: `${c.type} command ${c.status}${c.detail ? `: ${c.detail}` : ""}` });
    const queuedCommands = (ctx.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND status IN ('queued','sent','uploaded')").get(d.id) as { n: number }).n;
    const counts = {
      files: (ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      media: (ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      notifications: (ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      usage: (ctx.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      calls: (ctx.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      messages: (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
    };
    return {
      deviceId: d.id, role: d.role, fingerprint: d.fingerprint, pairedAt: d.paired_at, lastSeen: d.last_seen,
      lastReportAt: d.last_report_at, reportStatus: reportDot, appVersion: d.app_version, queueDepthTotal: d.queue_depth_total,
      status: dot, collectors: colViews,
      pendingBlobs: pending.map((b) => ({ oid: b.oid, status: b.status, payloadKind: b.payload_kind, committedParts: (JSON.parse(b.committed_parts) as number[]).length, totalChunks: b.total_chunks, committedBytes: b.committed_bytes, totalSize: b.total_size, updatedAt: b.updated_at })),
      quarantined, queuedCommands, counts,
      gaps: gapsFor(ctx, d.id, new Date(now - 7 * 86400_000).toISOString(), new Date(now).toISOString(), now),
    };
  });

  const missingRoles = ROLES.filter((r) => !devices.some((d) => d.role === r));
  problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
  return {
    at: nowIso(), locked: !unlocked, r2Configured: ctx.r2Configured(),
    status: deviceViews.reduce<Dot>((acc, d) => worst(acc, d.status), devices.length ? "green" : "off"),
    problems, devices: deviceViews, buckets, unpairedRoles: missingRoles,
    quarantineOpen: openQuarantine.reduce((n, q) => n + q.n, 0),
    thresholds: { amberAfterMs: ctx.config.amberAfterMs, redAfterMs: ctx.config.redAfterMs, gapThresholdMs: ctx.config.gapThresholdMs },
  };
}

// ------------------------------------------------------------------ gaps

export interface Gap {
  deviceId: string; role: string; collector: string; from: string; to: string;
  reason: "stale" | "disabled" | "never_ran" | "ongoing";
  open: boolean;
  lastRunAt: string | null;
}

/** Coverage gaps for one device in [from, to). `now` caps open gaps. */
export function gapsFor(ctx: Ctx, deviceId: string, from: string, to: string, now = Date.now()): Gap[] {
  const dev = ctx.db.prepare("SELECT role FROM devices WHERE id = ?").get(deviceId) as { role: string } | undefined;
  if (!dev) return [];
  const fromMs = msOf(from)!, toMs = Math.min(msOf(to)!, now);
  if (toMs <= fromMs) return [];
  const G = ctx.config.gapThresholdMs;
  const out: Gap[] = [];
  const push = (collector: string, a: number, b: number, reason: Gap["reason"], open: boolean, lastRunAt: string | null) => {
    const s = Math.max(a, fromMs), e = Math.min(b, toMs);
    if (e > s) out.push({ deviceId, role: dev.role, collector, from: new Date(s).toISOString(), to: new Date(e).toISOString(), reason, open, lastRunAt });
  };
  const names = ctx.db.prepare("SELECT name, enabled, last_run_at, first_reported_at FROM collector_state WHERE device_id = ?").all(deviceId) as Array<{ name: string; enabled: number; last_run_at: string | null; first_reported_at: string }>;
  for (const c of names) {
    const hist = ctx.db.prepare("SELECT reported_at, last_run_at, enabled FROM collector_history WHERE device_id = ? AND name = ? ORDER BY reported_at, rid").all(deviceId, c.name) as Array<{ reported_at: string; last_run_at: string | null; enabled: number }>;
    let lastRun: number | null = null;
    let lastRunIso: string | null = null;
    let disabledSince: number | null = null;
    for (const h of hist) {
      const rep = msOf(h.reported_at)!;
      const run = msOf(h.last_run_at);
      if (!h.enabled) {
        disabledSince ??= rep;
        continue;
      }
      if (disabledSince !== null) {
        push(c.name, disabledSince, rep, "disabled", false, lastRunIso);
        disabledSince = null;
        lastRun = Math.max(lastRun ?? 0, rep); // a gap is measured from re-enable, not across the disabled span
      }
      if (run !== null) {
        if (lastRun !== null && run - lastRun > G) push(c.name, lastRun, run, "stale", false, lastRunIso);
        if (lastRun === null || run > lastRun) { lastRun = run; lastRunIso = h.last_run_at; }
      }
    }
    if (disabledSince !== null) push(c.name, disabledSince, now, "disabled", true, lastRunIso);
    else if (lastRun === null) push(c.name, msOf(c.first_reported_at)!, now, "never_ran", true, null);
    else if (now - lastRun > G) push(c.name, lastRun, now, "stale", true, lastRunIso);
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

export function gapsAll(ctx: Ctx, from: string, to: string, now = Date.now()): Gap[] {
  const ids = ctx.db.prepare("SELECT id FROM devices").all() as Array<{ id: string }>;
  return ids.flatMap((d) => gapsFor(ctx, d.id, from, to, now)).sort((a, b) => a.from.localeCompare(b.from));
}
