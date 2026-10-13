/**
 * Forget this device: GET /api/devices/:id/footprint says what a forget removes; DELETE /api/devices/:id?wipe=1
 * with the device's fingerprint as `confirm` removes it from the vault and the local cache, keeps the other
 * device's copy of a shared conversation, and never touches R2. Objects the device left in R2 are then ignored
 * by ingest (ledger status `ignored`, left in the bucket, no GET once recorded), and a newly paired device of
 * the same role ingests normally.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { PNG_1x1, iso, type SimDevice } from "./helpers/device.ts";
import { softDelete } from "../src/bin/recovery.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
const devs: SimDevice[] = [];
afterEach(async () => { for (const d of devs.splice(0)) d.close(); await st?.cleanup(); st = undefined; });

const db = () => st!.svc.ctx.db;
const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
const WIN_BUCKET = "ivy-up-windows";
const photoBytes = new Uint8Array([...PNG_1x1, ...randomBytes(600)]);
const attBytes = new Uint8Array([...PNG_1x1, ...randomBytes(300)]);
const TG = { platform: "telegram", account: "42", convKey: "-100", peer: "Robotics lab", convKind: "group", cursor: "1" };
const msg = (m: Record<string, unknown>) => ({ sender: "7", sentAt: "2026-09-24T09:00:00.000Z", sourceStatus: "live", attachments: [], ...m });

/**
 * Seed: a Windows device with a notification, a usage event (moved to the bin), a photo original kept in R2
 * (file + media + media_archive), a Telegram group it shares with the Android device (m1 from both, m2 with an
 * attachment kept in R2 from Windows only, m3 from Android only) and a LINE chat only it captured.
 */
async function seed() {
  st = await fullStack();
  const win = await pairNew(st.svc, "windows");
  const and = await pairNew(st.svc, "android");
  devs.push(win, and);

  await win.put("windows_notification", { app: "Mail", title: "Flamingo", text: "pink", postedAt: iso() });
  await win.put("usage_event", { app: "Notepad", exe: "notepad.exe", title: "notes.txt - Notepad", startedAt: "2026-10-09T09:00:00.000Z", endedAt: "2026-10-09T09:05:00.000Z" });
  const photo = win.blob(photoBytes, "photo", 256);
  await win.put("file_meta", { path: "C:\\Users\\bunny\\Pictures\\reef.png", name: "reef.png", ext: "png", size: photoBytes.length, mtime: iso(), quickHash: "qh-reef", originalBlobOid: photo.oid });
  await win.putBlob(photo);
  const att = win.blob(attBytes, "attachment", 256);
  await win.put("message_batch", {
    ...TG, sourceSession: "windows:telegram-desktop", coverage: "complete",
    messages: [msg({ msgId: "m1", text: "shared hello" }),
      msg({ msgId: "m2", text: "photo from the PC", attachments: [{ attId: "a1", kind: "image", filename: "lab.png", size: attBytes.length, blobOid: att.oid }] })],
  });
  await win.putBlob(att);
  await win.put("message_batch", {
    platform: "line", account: "u1", convKey: "c-aki", peer: "Aki", convKind: "dm", cursor: "1", sourceSession: "windows:line-desktop", coverage: "complete",
    messages: [msg({ msgId: "L1", text: "line only on the PC" })],
  });
  await and.put("message_batch", {
    ...TG, sourceSession: "android:root-db", coverage: "complete",
    messages: [msg({ msgId: "m1", text: "shared hello" }), msg({ msgId: "m3", text: "only on the phone" })],
  });
  for (let i = 0; i < 3; i++) await st.svc.ingester.poll();
  await st.svc.idle();
  const usage = (db().prepare("SELECT id FROM usage_events WHERE device_id = ?").get(win.deviceId) as { id: string }).id;
  softDelete(st.svc.ctx, "usage", usage);
  return { win, and, photo, att };
}

describe("GET /api/devices/:id/footprint", () => {
  it("counts what a forget removes, what shared records stay, the local cache and the media left in R2", async () => {
    const { win, photo, att } = await seed();
    expect(count("SELECT COUNT(*) AS n FROM media_archive")).toBe(2);
    const ledger = count("SELECT COUNT(*) AS n FROM sync_objects WHERE device_id = ?", win.deviceId);
    const paths = new Set<string>();
    for (const r of db().prepare(`SELECT local_path AS p FROM media WHERE device_id = ? UNION SELECT thumb_path FROM media WHERE device_id = ?
                                  UNION SELECT local_path FROM files WHERE device_id = ? UNION SELECT local_path FROM attachments`)
      .all(win.deviceId, win.deviceId, win.deviceId) as Array<{ p: string | null }>) if (r.p) paths.add(r.p);
    const cacheBytes = [...paths].reduce((s, p) => s + statSync(p).size, 0);
    expect(paths.size).toBe(3); // the photo original, its thumbnail, the attachment
    expect(cacheBytes).toBeGreaterThan(photoBytes.length + attBytes.length);

    const r = await api(st!.svc, "GET", `/api/devices/${win.deviceId}/footprint`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      deviceId: win.deviceId, role: "windows", fingerprint: win.fingerprint, confirmWith: "fingerprint",
      counts: {
        messages: 2, conversations: 1, messageSources: 3, messageEdits: 0, attachments: 1,
        notifications: 1, media: 1, files: 1, calls: 0, usageEvents: 1, commands: 0, quarantine: 0, pairings: 1,
        ledger, mediaArchive: 2, blobs: 2,
      },
      shared: { messagesKept: 1, conversationsKept: 1 },
      binRows: 1,
      cacheBytes,
      leftInR2: { objects: 2, bytes: photoBytes.length + attBytes.length },
    });
    expect(ledger).toBeGreaterThanOrEqual(6); // pairing, notification, usage, file_meta, two message batches
    void photo; void att;
    // read-only: nothing changed
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(4);
    expect((await api(st!.svc, "GET", "/api/devices/nope/footprint")).status).toBe(404);
  });
});

describe("DELETE /api/devices/:id?wipe=1", () => {
  it("removes exactly that device's rows, keeps the shared conversation for the other device, frees the cache, never touches R2", async () => {
    const { win, and, photo, att } = await seed();
    const winPaths = (db().prepare("SELECT local_path AS p FROM media WHERE device_id = ? UNION SELECT thumb_path FROM media WHERE device_id = ? UNION SELECT local_path FROM attachments")
      .all(win.deviceId, win.deviceId) as Array<{ p: string }>).map((r) => r.p);
    expect(winPaths.length).toBe(3);
    const winBytes = winPaths.reduce((s, p) => s + statSync(p).size, 0);
    for (const p of winPaths) expect(existsSync(p)).toBe(true);
    const objects = st!.s3.mock.listAll(WIN_BUCKET).length;
    const andRows = {
      sources: count("SELECT COUNT(*) AS n FROM message_sources WHERE device_id = ?", and.deviceId),
      ledger: count("SELECT COUNT(*) AS n FROM sync_objects WHERE device_id = ?", and.deviceId),
    };

    // a wrong confirm is refused and changes nothing
    const bad = await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: "0000-0000-0000-0000" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("bad_confirm");
    expect((await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, {})).status).toBe(400);
    expect(count("SELECT COUNT(*) AS n FROM devices WHERE id = ?", win.deviceId)).toBe(1);

    st!.s3.mock.clearRequests();
    const r = await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: win.fingerprint.toLowerCase() });
    expect(r.status).toBe(200);
    expect(st!.s3.mock.requests()).toEqual([]); // no list, get, put or delete of any kind
    expect(st!.s3.mock.listAll(WIN_BUCKET).length).toBe(objects);
    expect(r.json).toMatchObject({
      forgotten: true, deviceId: win.deviceId,
      removed: { messages: 2, conversations: 1, messageSources: 3, attachments: 1, notifications: 1, media: 1, files: 1, usageEvents: 1, pairings: 1, mediaArchive: 2, blobs: 2 },
      shared: { messagesKept: 1, conversationsKept: 1 },
      binPurged: 1,
      cacheBytesFreed: winBytes,
      cacheFilesRemoved: 3,
      leftInR2Bytes: photoBytes.length + attBytes.length,
      tokenWarning: "The device's R2 tokens remain valid until you rotate them in the Cloudflare dashboard.",
    });
    expect(r.json.binNote).toMatch(/recovery bin/);

    // nothing of the device is left in any table keyed by device id (blob tombstones and their ledger rows aside)
    for (const t of ["devices", "conversations", "messages", "notifications", "media", "calls", "usage_events", "commands", "message_sources",
      "media_archive", "files", "pairings", "collector_state", "collector_history", "quarantine"]) {
      const col = t === "devices" ? "id" : "device_id";
      expect(count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, win.deviceId), t).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM sync_objects WHERE device_id = ? AND status <> 'ignored'", win.deviceId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM blobs WHERE oid IN (?, ?) AND status = 'ignored' AND manifest_env IS NULL AND local_path IS NULL", photo.oid, att.oid)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM forgotten_devices WHERE id = ? AND fingerprint = ?", win.deviceId, win.fingerprint)).toBe(1);

    // the shared Telegram group stays with the Android copy: m1 (now attributed to Android) and m3
    const kept = db().prepare("SELECT m.msg_key AS k, m.device_id AS d, m.text_source AS ts FROM messages m ORDER BY m.msg_key").all();
    expect(kept).toEqual([{ k: "m1", d: and.deviceId, ts: "android:root-db" }, { k: "m3", d: and.deviceId, ts: "android:root-db" }]);
    expect(db().prepare("SELECT source_session AS s, device_id AS d FROM message_sources ORDER BY rid").all())
      .toEqual([{ s: "android:root-db", d: and.deviceId }, { s: "android:root-db", d: and.deviceId }]);
    const conv = db().prepare("SELECT platform, device_id, coverage, coverage_by_source FROM conversations").all();
    expect(conv).toEqual([{ platform: "telegram", device_id: and.deviceId, coverage: "complete", coverage_by_source: '{"android:root-db":"complete"}' }]);
    expect(count("SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'line only'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM message_sources WHERE device_id = ?", and.deviceId)).toBe(andRows.sources);
    expect(count("SELECT COUNT(*) AS n FROM sync_objects WHERE device_id = ?", and.deviceId)).toBe(andRows.ledger);
    expect(count("SELECT COUNT(*) AS n FROM devices WHERE id = ?", and.deviceId)).toBe(1);

    // cache files are gone; the bin holds nothing of the device
    for (const p of winPaths) expect(existsSync(p)).toBe(false);
    expect((await api(st!.svc, "GET", "/api/bin")).json.total ?? 0).toBe(0);

    // idempotent: the device is gone, so a second call and a footprint are 404
    expect((await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: win.fingerprint })).status).toBe(404);
    expect((await api(st!.svc, "GET", `/api/devices/${win.deviceId}/footprint`)).status).toBe(404);
  });

  it("without wipe, DELETE is the plain revoke: captured records stay", async () => {
    const { win } = await seed();
    const r = await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}`);
    expect(r.json).toMatchObject({ revoked: true, cancelledCommands: 0 });
    expect(count("SELECT COUNT(*) AS n FROM notifications WHERE device_id = ?", win.deviceId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM forgotten_devices")).toBe(0);
  });
});

describe("leftovers of a forgotten device in R2", () => {
  it("are ignored: ledger row ignored, object stays in the bucket, nothing committed, no GET on the next poll", async () => {
    const { win } = await seed();
    expect((await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: win.fingerprint })).status).toBe(200);
    // the device is still running and uploads one more notification (its tokens stay valid until rotated)
    const key = await win.put("windows_notification", { app: "Mail", title: "late", text: "after the forget", postedAt: iso() });

    const first = (await st!.svc.ingester.poll()).buckets.find((b) => b.bucket === WIN_BUCKET)!;
    expect(first).toMatchObject({ committed: 0, quarantined: 0, ignored: 1 });
    expect(db().prepare("SELECT status, device_id FROM sync_objects WHERE object_key = ?").get(key)).toEqual({ status: "ignored", device_id: win.deviceId });
    expect(st!.s3.mock.listAll(WIN_BUCKET).map((o) => o.key)).toContain(key);
    expect(count("SELECT COUNT(*) AS n FROM notifications")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM quarantine")).toBe(0);

    st!.s3.mock.clearRequests();
    const second = (await st!.svc.ingester.poll()).buckets.find((b) => b.bucket === WIN_BUCKET)!;
    expect(second).toMatchObject({ committed: 0, quarantined: 0, ignored: 0, replayed: 0 });
    const touched = st!.s3.mock.requests().filter((q) => q.key === key);
    expect(touched).toEqual([]); // no GET, no delete
    expect(st!.s3.mock.requests().filter((q) => q.operation === "GetObject" || q.operation === "DeleteObject" || q.operation === "DeleteObjects")).toEqual([]);
    expect(st!.s3.mock.listAll(WIN_BUCKET).map((o) => o.key)).toContain(key);

    // a full listing sees the kept media originals and the late record again: all settled from the ledger
    st!.s3.mock.clearRequests();
    const full = (await st!.svc.ingester.poll({ full: true })).buckets.find((b) => b.bucket === WIN_BUCKET)!;
    expect(full).toMatchObject({ committed: 0, quarantined: 0, ignored: 0 });
    expect(st!.s3.mock.requests().filter((q) => q.operation === "GetObject" || q.operation === "DeleteObjects" || q.operation === "DeleteObject")).toEqual([]);
  });

  it("a new blob named by an ignored record is ignored too, without fetching its parts", async () => {
    const { win } = await seed();
    await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: win.fingerprint });
    const shot = win.blob(new Uint8Array([...PNG_1x1, ...randomBytes(400)]), "screenshot", 256);
    await win.put("screenshot", { sourcePath: "C:\\shot.png", width: 1, height: 1, sha256: "x", blobOid: shot.oid, takenAt: iso(), savedAt: iso() });
    await win.putBlob(shot);
    st!.s3.mock.clearRequests();
    const r = (await st!.svc.ingester.poll()).buckets.find((b) => b.bucket === WIN_BUCKET)!;
    expect(r.committed).toBe(0);
    expect(r.ignored).toBe(1 + 1 + shot.parts.length); // the record, the manifest, every part
    const gets = st!.s3.mock.requests().filter((q) => q.operation === "GetObject").map((q) => q.key);
    expect(gets.filter((k) => k?.startsWith(`up/blob/${shot.oid}/`))).toEqual([]);
    expect(db().prepare("SELECT status FROM blobs WHERE oid = ?").get(shot.oid)).toEqual({ status: "ignored" });
    expect(count("SELECT COUNT(*) AS n FROM media")).toBe(0);
    expect(st!.s3.mock.listAll(WIN_BUCKET).filter((o) => o.key.startsWith(`up/blob/${shot.oid}/`)).length).toBe(1 + shot.parts.length);
  });

  it("a newly paired device of the same role ingests normally", async () => {
    const { win } = await seed();
    await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: win.fingerprint });
    const fresh = await pairNew(st!.svc, "windows");
    devs.push(fresh);
    expect(fresh.deviceId).not.toBe(win.deviceId);
    expect(count("SELECT COUNT(*) AS n FROM devices WHERE id = ?", fresh.deviceId)).toBe(1);
    await fresh.put("windows_notification", { app: "Mail", title: "new PC", text: "hello", postedAt: iso() });
    const r = (await st!.svc.ingester.poll()).buckets.find((b) => b.bucket === WIN_BUCKET)!;
    expect(r).toMatchObject({ committed: 1, ignored: 0 });
    expect(count("SELECT COUNT(*) AS n FROM notifications WHERE device_id = ?", fresh.deviceId)).toBe(1);
  });
});
