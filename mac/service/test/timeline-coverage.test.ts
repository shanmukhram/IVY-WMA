import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import {
  commitDeviceReport, commitFileMeta, commitMessageBatch, commitUsage, commitWindowsNotification, commitScreenshot,
} from "../src/ingest/committers.ts";
import { timeline } from "../src/query/timeline.ts";
import { coverage, gapsFor } from "../src/query/coverage.ts";
import { dayBounds } from "../src/util/time.ts";

let svc: Service;
let dir: string;
const DEV = "win-1";
const T = (h: number, m = 0) => `2026-09-24T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const base = (kind: string, t = T(0)) => ({ v: 1 as const, kind, deviceId: DEV, eventTime: t, captureTime: "2026-10-01T00:00:00.000Z" });
const report = (at: string, cols: Array<{ name: string; lastRunAt?: string; enabled?: boolean; cursor?: string; queueDepth?: number }>) =>
  commitDeviceReport(svc.ctx.db, { ...base("device_report", at), kind: "device_report", role: "windows", queueDepthTotal: 0, reportedAt: at,
    collectors: cols.map((c) => ({ name: c.name, enabled: c.enabled ?? true, lastRunAt: c.lastRunAt, cursor: c.cursor, queueDepth: c.queueDepth ?? 0 })) });

beforeEach(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  svc.ctx.keystore.initialize(PASS);
  svc.ctx.db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'FP', ?)").run(DEV, T(0));
});
afterEach(async () => { await svc.close(); rm(dir); });

describe("timeline (T1, T3, T4, T5)", () => {
  function seedDay() {
    const db = svc.ctx.db;
    commitUsage(db, { ...base("usage_event"), kind: "usage_event", app: "Code", startedAt: T(9), endedAt: T(9, 30) });
    commitWindowsNotification(db, { ...base("windows_notification"), kind: "windows_notification", app: "Teams", title: "t", text: "x", postedAt: T(8, 15) });
    commitFileMeta(db, { ...base("file_meta"), kind: "file_meta", path: "C:\\a.txt", name: "a.txt", ext: "txt", size: 1, mtime: T(7), quickHash: "q" });
    commitScreenshot(db, { ...base("screenshot"), kind: "screenshot", sourcePath: "C:\\s.png", sha256: "s", blobOid: "01JABCDEFGHJKMNPQRSTVWXYZ0", takenAt: T(10) });
    // captured on Oct 1 but SENT on Sep 24 at 06:00: it belongs at 06:00 on the 24th
    commitMessageBatch(db, { ...base("message_batch"), kind: "message_batch", platform: "line", account: "me", convKey: "c", convKind: "dm", coverage: "complete", cursor: "1",
      messages: [{ msgId: "1", sender: "Aki", sentAt: T(6), text: "morning", sourceStatus: "live", attachments: [] }] });
    commitUsage(db, { ...base("usage_event"), kind: "usage_event", app: "NextDay", startedAt: "2026-09-25T09:00:00.000Z", endedAt: "2026-09-25T09:01:00.000Z" });
  }

  it("merges every source for a day in original event-time order, keeping capture time separate", () => {
    seedDay();
    const r = timeline(svc.ctx, { date: "2026-09-24", tz: "UTC" });
    expect(r.items.map((i) => i.type)).toEqual(["message", "file", "notification", "usage", "screenshot"]);
    expect(r.items.map((i) => i.eventTime)).toEqual([T(6), T(7), T(8, 15), T(9), T(10)]);
    expect(r.items[0]).toMatchObject({ timeField: "sent_at", capturedAt: "2026-10-01T00:00:00.000Z" });
    expect(r.items[4]).toMatchObject({ timeField: "taken_at" });
    expect(r.total).toBe(5);
    expect(r.counts).toMatchObject({ message: 1, file: 1, notification: 1, usage: 1, screenshot: 1 });
  });

  it("paginates and groups by hour", () => {
    seedDay();
    const p1 = timeline(svc.ctx, { date: "2026-09-24", tz: "UTC", pageSize: 2 });
    const p3 = timeline(svc.ctx, { date: "2026-09-24", tz: "UTC", pageSize: 2, page: 3 });
    expect(p1.pages).toBe(3);
    expect(p1.items.map((i) => i.type)).toEqual(["message", "file"]);
    expect(p3.items.map((i) => i.type)).toEqual(["screenshot"]);
    expect(p1.hours.map((h) => h.index)).toEqual([6, 7, 8, 9, 10]);
  });

  it("uses the requested time zone for day boundaries", () => {
    expect(dayBounds("2026-09-24", "Asia/Tokyo")).toMatchObject({ start: "2026-09-23T15:00:00.000Z", end: "2026-09-24T15:00:00.000Z" });
    expect(dayBounds("2026-09-24", "-300")).toMatchObject({ start: "2026-09-24T05:00:00.000Z" });
    seedDay();
    const r = timeline(svc.ctx, { date: "2026-09-24", tz: "Asia/Tokyo" }); // JST day ends at 15:00Z
    expect(r.items.map((i) => i.eventTime)).toEqual([T(6), T(7), T(8, 15), T(9), T(10)]);
    const r2 = timeline(svc.ctx, { date: "2026-09-25", tz: "Asia/Tokyo" });
    expect(r2.items.map((i) => i.title)).toEqual(["NextDay"]);
  });

  it("shows an honest gap from a collector's last run to now when its reports stop", () => {
    report(T(8), [{ name: "usage", lastRunAt: T(8) }]);
    report(T(8, 5), [{ name: "usage", lastRunAt: T(8, 5) }]);
    // nothing after 08:05; it is now 12:00 on the same day
    const now = Date.parse(T(12));
    const r = timeline(svc.ctx, { date: "2026-09-24", tz: "UTC" }, now);
    expect(r.gaps).toEqual([expect.objectContaining({ collector: "usage", from: T(8, 5), to: T(12), reason: "stale", open: true })]);
  });

  it("finds historical gaps between runs further apart than the threshold", () => {
    report(T(8), [{ name: "usage", lastRunAt: T(8) }]);
    report(T(8, 5), [{ name: "usage", lastRunAt: T(8, 5) }]);
    report(T(11), [{ name: "usage", lastRunAt: T(11) }]); // device was off 08:05-11:00
    report(T(11, 5), [{ name: "usage", lastRunAt: T(11, 5) }]);
    const g = gapsFor(svc.ctx, DEV, T(0), "2026-09-25T00:00:00.000Z", Date.parse(T(11, 10)));
    expect(g).toEqual([expect.objectContaining({ from: T(8, 5), to: T(11), reason: "stale", open: false })]);
  });

  it("marks a disabled collector as a disabled gap", () => {
    report(T(8), [{ name: "notifications", lastRunAt: T(8) }]);
    report(T(9), [{ name: "notifications", lastRunAt: T(8, 59), enabled: false }]);
    report(T(10), [{ name: "notifications", lastRunAt: T(10), enabled: true }]);
    const g = gapsFor(svc.ctx, DEV, T(0), "2026-09-25T00:00:00.000Z", Date.parse(T(10, 5)));
    expect(g).toEqual([expect.objectContaining({ collector: "notifications", from: T(9), to: T(10), reason: "disabled" })]);
  });

  it("is served at /api/timeline", async () => {
    seedDay();
    const r = await api(svc, "GET", "/api/timeline?date=2026-09-24&tz=UTC&type=usage,file");
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: { type: string }) => i.type)).toEqual(["file", "usage"]);
    expect((await api(svc, "GET", "/api/timeline")).status).toBe(400);
  });
});

describe("coverage (D1-D5)", () => {
  const now = Date.parse(T(12));
  const dev = () => coverage(svc.ctx, now).devices[0]!;
  const col = (name: string) => dev().collectors.find((c) => c.name === name)!;

  it("green when the collector ran and reported recently", () => {
    report(T(11, 58), [{ name: "usage", lastRunAt: T(11, 57) }]);
    expect(col("usage").status).toBe("green");
    expect(dev().status).toBe("green");
  });

  it("amber when stale past 15 minutes, red past an hour", () => {
    report(T(11, 58), [{ name: "usage", lastRunAt: T(11, 30) }, { name: "files", lastRunAt: T(10) }]);
    expect(col("usage")).toMatchObject({ status: "amber", statusReason: expect.stringMatching(/last run 30 min ago/) });
    expect(col("files").status).toBe("red");
    expect(dev().status).toBe("red");
    expect(coverage(svc.ctx, now).problems.some((p) => p.source.collector === "files" && p.severity === "red")).toBe(true);
  });

  it("a device whose reports stop goes red even if its last report said green", () => {
    report(T(9), [{ name: "usage", lastRunAt: T(9) }]);
    expect(dev().reportStatus).toBe("red");
    expect(col("usage").status).toBe("red");
  });

  it("disabled collectors are off, not failures; never-run is red", () => {
    report(T(11, 59), [{ name: "notifications", enabled: false }, { name: "screenshots" }]);
    expect(col("notifications")).toMatchObject({ status: "off", enabled: false });
    expect(col("screenshots")).toMatchObject({ status: "red", statusReason: "has never run" });
  });

  it("paired but never reported is a red problem; unpaired roles are listed", () => {
    const c = coverage(svc.ctx, now);
    expect(c.problems).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "red", message: expect.stringMatching(/never sent a device report/) })]));
    expect(c.unpairedRoles).toEqual(["android"]);
  });

  it("reports import progress, queue depth, what each collector captures, quarantine and pending blobs", () => {
    commitFileMeta(svc.ctx.db, { ...base("file_meta"), kind: "file_meta", path: "C:\\x", name: "x", ext: "", size: 1, mtime: T(1), quickHash: "q" });
    report(T(11, 59), [{ name: "files", lastRunAt: T(11, 59), cursor: JSON.stringify({ total: 4 }), queueDepth: 7 }, { name: "usage", lastRunAt: T(11, 59), cursor: "2026-09-24T11:59:00.000Z" }]);
    svc.ctx.db.prepare("INSERT INTO quarantine(id, bucket, role, object_key, reason, created_at) VALUES ('q1', 'ivy-up-windows', 'windows', 'up/usg/X', 'undecryptable', ?)").run(T(11));
    svc.ctx.db.prepare("INSERT INTO blobs(oid, bucket, role, status, first_seen_at, updated_at) VALUES ('B', 'ivy-up-windows', 'windows', 'awaiting_manifest', ?, ?)").run(T(11, 50), T(11, 50));
    const d = dev();
    expect(col("files")).toMatchObject({ queueDepth: 7, import: { indexed: 1, total: 4, percent: 25, state: "in_progress" }, captureKind: "metadata" });
    expect(col("files").captures).toMatch(/File index/);
    expect(col("usage").import).toBeNull();
    expect(d.quarantined).toBe(1);
    expect(d.pendingBlobs).toHaveLength(1);
    expect(coverage(svc.ctx, now).problems.some((p) => /quarantined/.test(p.message))).toBe(true);
  });

  it("without a device-reported total the import state says so instead of guessing", () => {
    report(T(11, 59), [{ name: "files", lastRunAt: T(11, 59), cursor: "scan:2026-09-24T11:00:00.000Z" }]);
    expect(col("files").import).toMatchObject({ total: null, percent: null, state: "full_scan_reported", lastFullScanAt: "2026-09-24T11:00:00.000Z" });
  });

  it("is served at /api/coverage", async () => {
    report(new Date().toISOString(), [{ name: "usage", lastRunAt: new Date().toISOString() }]);
    const r = await api(svc, "GET", "/api/coverage");
    expect(r.status).toBe(200);
    expect(r.json.devices[0].collectors[0]).toMatchObject({ name: "usage", status: "green" });
  });
});
