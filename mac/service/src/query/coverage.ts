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
import { freshest, msOf, nowIso } from "../util/time.ts";
import { ROLES } from "../r2/config.ts";
import { activityVaultCoverage } from "../imports/activity-vault.ts";
import { deviceScope } from "./types.ts";

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
  import_total: number | null; import_done: number | null; phase: string | null;
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

/**
 * Import progress. Preferred source: the device's own `importTotal` / `importDone`
 * / `phase` (PROTOCOL §6 device_report.collectors[]), which gives a real
 * percentage of the device's pass. Older devices: a total in a JSON cursor, else
 * only what the vault holds (and no percentage).
 */
function importProgress(ctx: Ctx, deviceId: string, c: CollectorRow) {
  const reported = c.import_total !== null || c.import_done !== null || c.phase !== null;
  const vaultKind = c.name === "files" || c.name === "messages" || c.name === "photos";
  if (!reported && !vaultKind) return null;
  let indexed: number | null = null;
  if (c.name === "files") indexed = (ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE device_id = ? AND source_status = 'live' AND deleted_at IS NULL AND (catalog = 0 OR local_path IS NOT NULL)").get(deviceId) as { n: number }).n;
  if (c.name === "messages") indexed = (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_id = ?").get(deviceId) as { n: number }).n;
  if (c.name === "photos") indexed = (ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE device_id = ? AND kind = 'photo'").get(deviceId) as { n: number }).n;
  const fullScan = c.cursor?.startsWith("scan:") ? c.cursor.slice(5) : null;

  if (reported) {
    const total = c.import_total;
    const done = c.import_done;
    const percent = total !== null && done !== null ? (total === 0 ? 100 : Math.min(100, Math.floor((done / total) * 100))) : null;
    return {
      source: "device" as const,
      phase: c.phase, done, total, indexed, percent,
      state: total === null || done === null ? (c.phase === "incremental" ? "live" : "counting") : done >= total ? "complete" : "in_progress",
      lastFullScanAt: fullScan,
      note: total === null ? "the device has not counted the items of this pass yet" : null,
    };
  }

  let total: number | null = null;
  try {
    const cur = c.cursor ? (JSON.parse(c.cursor) as Record<string, unknown>) : null;
    const t = cur && (cur.total ?? cur.expected ?? cur.totalFiles);
    if (typeof t === "number" && t >= 0) total = t;
  } catch { /* cursor is not JSON (e.g. "scan:<time>") */ }
  const n = indexed ?? 0;
  return {
    source: total !== null ? ("cursor" as const) : ("vault" as const),
    phase: null, done: null, total, indexed: n,
    percent: total ? Math.min(100, Math.round((n / total) * 100)) : null,
    state: total !== null ? (n >= total ? "complete" : "in_progress") : fullScan ? "full_scan_reported" : "unknown",
    lastFullScanAt: fullScan,
    note: total === null ? "the device does not report a total for this collector; the count is what the vault holds" : null,
  };
}

export interface Problem { severity: "red" | "amber"; source: { deviceId?: string; role?: string; collector?: string; bucket?: string }; message: string }

/**
 * `scope.device` (<id|windows|android>, query/types.ts) narrows the report to the devices in the
 * dashboard's device scope: their rows, their problems and the overall status. Problems that
 * belong to no device (vault locked, R2, bucket polls, quarantine per bucket) stay, and the
 * Activity Vault import, which is not a device, is left out of a scoped report.
 */
export function coverage(ctx: Ctx, now = Date.now(), scope: { device?: string } = {}) {
  const ds = deviceScope("id", scope.device);
  const devices = ctx.db.prepare(`SELECT * FROM devices${ds ? ` WHERE ${ds.sql}` : ""} ORDER BY paired_at`).all(...(ds?.args ?? [])) as Array<{
    id: string; role: string; fingerprint: string; paired_at: string; last_seen: string | null; last_report_at: string | null;
    last_upload_at: string | null; app_version: string | null; queue_depth_total: number | null;
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
    // "last heard" is when the device itself last sent something: the freshest of its heartbeat (last_report_at)
    // and the creation time of the newest object the Mac has committed from it (last_upload_at). Both are the
    // device's times, so the Mac working through an old backlog does not make a quiet device look alive.
    // last_seen (when the Mac last committed anything) is shown beside it but does not drive the dot.
    const lastHeard = freshest(d.last_report_at, d.last_upload_at);
    // A device that has never once sent a heartbeat is red (its reporting never started).
    const heardDot: Dot = d.last_report_at ? ageDot(ctx, lastHeard, now) : "red";
    let dot: Dot = heardDot;
    const colViews = collectors.map((c) => {
      const s = collectorStatus(ctx, c, d.last_report_at, now);
      dot = worst(dot, s.dot);
      if (s.dot === "red" || s.dot === "amber") problems.push({ severity: s.dot, source: { deviceId: d.id, role: d.role, collector: c.name }, message: `${d.role} ${c.name}: ${s.reason}` });
      return {
        name: c.name, enabled: !!c.enabled, lastRunAt: c.last_run_at, lastReportAt: c.reported_at, firstReportedAt: c.first_reported_at,
        queueDepth: c.queue_depth, cursor: c.cursor, status: s.dot, statusReason: s.reason, phase: c.phase,
        captures: COLLECTOR_INFO[c.name]?.captures ?? "Reported by the device; no description on the Mac yet.",
        captureKind: COLLECTOR_INFO[c.name]?.kind ?? "unknown",
        import: importProgress(ctx, d.id, c),
      };
    });
    if (!d.last_report_at) problems.push({ severity: "red", source: { deviceId: d.id, role: d.role }, message: `${d.role} has paired but never sent a device report` });
    else if (heardDot !== "green") {
      // Truly quiet: the Mac has heard nothing (no report, no object) for a while.
      problems.push({ severity: heardDot === "red" ? "red" : "amber", source: { deviceId: d.id, role: d.role }, message: `${d.role}: last heard ${fmtAge(now - (msOf(lastHeard) ?? 0))} ago` });
    } else if (ageDot(ctx, d.last_report_at, now) !== "green") {
      // Being heard from (uploading), but the heartbeat specifically is behind — surfaced, not hidden.
      problems.push({ severity: "amber", source: { deviceId: d.id, role: d.role }, message: `${d.role}: uploading, but no heartbeat for ${fmtAge(now - (msOf(d.last_report_at) ?? 0))}` });
    }

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
    const queuedCommands = (ctx.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND status IN ('queued','sent','transferring','uploaded')").get(d.id) as { n: number }).n;
    const counts = {
      files: (ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE device_id = ? AND deleted_at IS NULL AND (catalog = 0 OR local_path IS NOT NULL)").get(d.id) as { n: number }).n,
      catalog: (ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE device_id = ? AND deleted_at IS NULL AND catalog = 1 AND local_path IS NULL").get(d.id) as { n: number }).n,
      media: (ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      notifications: (ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      usage: (ctx.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      calls: (ctx.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
      messages: (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_id = ? AND deleted_at IS NULL").get(d.id) as { n: number }).n,
    };
    return {
      deviceId: d.id, role: d.role, fingerprint: d.fingerprint, pairedAt: d.paired_at, lastSeen: d.last_seen,
      lastReportAt: d.last_report_at, lastUploadAt: d.last_upload_at, lastHeard, reportStatus: ageDot(ctx, d.last_report_at, now),
      appVersion: d.app_version, queueDepthTotal: d.queue_depth_total,
      status: dot, collectors: colViews,
      pendingBlobs: pending.map((b) => ({ oid: b.oid, status: b.status, payloadKind: b.payload_kind, committedParts: (JSON.parse(b.committed_parts) as number[]).length, totalChunks: b.total_chunks, committedBytes: b.committed_bytes, totalSize: b.total_size, updatedAt: b.updated_at })),
      quarantined, queuedCommands, counts,
      gaps: gapsFor(ctx, d.id, new Date(now - 7 * 86400_000).toISOString(), new Date(now).toISOString(), now),
    };
  });

  // S7: imports that are not devices (Activity Vault); shown as their own coverage rows
  const imports = ds ? [] : [activityVaultCoverage(ctx, now)];
  for (const im of imports) {
    if (im.enabled && (im.status === "red" || im.status === "amber")) problems.push({ severity: im.status, source: { collector: im.source }, message: `${im.name}: ${im.statusReason}` });
  }

  // which roles have no paired device at all is a fact about the vault, the same under any scope
  const pairedRoles = new Set((ctx.db.prepare("SELECT DISTINCT role FROM devices").all() as Array<{ role: string }>).map((r) => r.role));
  const missingRoles = ROLES.filter((r) => !pairedRoles.has(r));
  problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
  return {
    at: nowIso(), locked: !unlocked, r2Configured: ctx.r2Configured(),
    status: deviceViews.reduce<Dot>((acc, d) => worst(acc, d.status), devices.length ? "green" : "off"),
    problems, devices: deviceViews, buckets, unpairedRoles: missingRoles, imports,
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
