/**
 * Records left by a device that is no longer paired (an "orphaned" device id: rows in device-keyed tables, no
 * devices row, not on forgotten_devices). GET /api/devices lists such ids under `orphaned` with what a forget
 * would remove; the footprint and DELETE /api/devices/:id?wipe=1 work for them, confirmed with the fingerprint
 * when one is on record or else the first 8 characters of the id. The forget sends no unpair command (no R2
 * request at all), records the id on forgotten_devices, and a later upload from that id is ignored.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { PNG_1x1, iso, type SimDevice } from "./helpers/device.ts";
import { DEVICE_ID_TABLES } from "../src/devices/forget.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
const devs: SimDevice[] = [];
afterEach(async () => { for (const d of devs.splice(0)) d.close(); await st?.cleanup(); st = undefined; });

const db = () => st!.svc.ctx.db;
const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
const WIN_BUCKET = "ivy-up-windows";
const msg = (m: Record<string, unknown>) => ({ sender: "7", sentAt: "2026-09-24T09:00:00.000Z", sourceStatus: "live", attachments: [], ...m });

/**
 * Seed: an old Windows pairing with catalogue entries, a file with content, and a Telegram chat of two messages;
 * then its devices row is removed directly, as an earlier pairing left it (only a consumed pairings row stays).
 * An Android device stays paired with a notification of its own.
 */
async function seed() {
  st = await fullStack();
  const old = await pairNew(st.svc, "windows");
  const and = await pairNew(st.svc, "android");
  devs.push(old, and);
  for (let i = 0; i < 4; i++) await old.put("file_meta", { path: `C:\\Users\\bunny\\Docs\\n${i}.txt`, name: `n${i}.txt`, ext: "txt", size: 10 + i, mtime: iso(), catalogOnly: true });
  const bytes = new Uint8Array([...PNG_1x1, ...randomBytes(300)]);
  const photo = old.blob(bytes, "photo", 256);
  await old.put("file_meta", { path: "C:\\Users\\bunny\\Pictures\\reef.png", name: "reef.png", ext: "png", size: bytes.length, mtime: iso(), quickHash: "qh-reef", originalBlobOid: photo.oid });
  await old.putBlob(photo);
  await old.put("message_batch", {
    platform: "telegram", account: "42", convKey: "777", peer: "Aki", convKind: "dm", cursor: "1", sourceSession: "windows:telegram-desktop", coverage: "complete",
    messages: [msg({ msgId: "t1", text: "hello from the old pairing" }), msg({ msgId: "t2", text: "second one" })],
  });
  await and.put("android_notification", { app: "com.example.mail", title: "Phone", sender: "Phone", preview: "stays", notifKey: "k1", postedAt: iso() });
  for (let i = 0; i < 3; i++) await st.svc.ingester.poll();
  await st.svc.idle();
  db().prepare("DELETE FROM devices WHERE id = ?").run(old.deviceId);
  expect(count("SELECT COUNT(*) AS n FROM pairings WHERE device_id = ? AND status = 'consumed'", old.deviceId)).toBe(1);
  return { old, and, bytes };
}

describe("GET /api/devices orphaned", () => {
  it("lists an id with records but no devices row, with the footprint counts; a paired device is not listed", async () => {
    const { old, and, bytes } = await seed();
    const files = count("SELECT COUNT(*) AS n FROM files WHERE device_id = ?", old.deviceId);
    expect(files).toBe(5);
    const ledger = count("SELECT COUNT(*) AS n FROM sync_objects WHERE device_id = ?", old.deviceId);
    const r = await api(st!.svc, "GET", "/api/devices");
    expect(r.status).toBe(200);
    expect(r.json.devices.map((d: { id: string }) => d.id)).toEqual([and.deviceId]);
    expect(r.json.orphaned).toHaveLength(1);
    const o = r.json.orphaned[0];
    expect(o).toMatchObject({
      id: old.deviceId, role: "windows", fingerprint: null, name: null, confirmWith: "shortId",
      counts: { messages: 2, conversations: 1, files: 5, media: 1, notifications: 0, pairings: 1, ledger, mediaArchive: 1, blobs: 1 },
      catalogFiles: 4, leftInR2: { objects: 1, bytes: bytes.length },
    });
    expect(o.cacheBytes).toBeGreaterThan(0);
    expect(typeof o.lastSeen).toBe("string");

    // the footprint works for the orphaned id, and is read-only
    const f = await api(st!.svc, "GET", `/api/devices/${old.deviceId}/footprint`);
    expect(f.status).toBe(200);
    expect(f.json).toMatchObject({ deviceId: old.deviceId, paired: false, role: "windows", fingerprint: null, confirmWith: "shortId", counts: o.counts, cacheBytes: o.cacheBytes });
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(2);
    // a paired device's footprint says so and confirms with its fingerprint
    expect((await api(st!.svc, "GET", `/api/devices/${and.deviceId}/footprint`)).json).toMatchObject({ paired: true, confirmWith: "fingerprint", fingerprint: and.fingerprint });
  });

  it("takes role, fingerprint and name from revoked_devices, so a revoked device's kept archive is listed and confirmed with its fingerprint", async () => {
    st = await fullStack();
    const win = await pairNew(st.svc, "windows");
    devs.push(win);
    await win.put("windows_notification", { app: "Mail", title: "kept", text: "after revoke", postedAt: iso() });
    await st.svc.ingester.poll();
    await api(st.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: "Old desk" });
    expect((await api(st.svc, "DELETE", `/api/devices/${win.deviceId}`)).json.revoked).toBe(true);
    const o = (await api(st.svc, "GET", "/api/devices")).json.orphaned;
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ id: win.deviceId, role: "windows", fingerprint: win.fingerprint, name: "Old desk", confirmWith: "fingerprint", counts: { notifications: 1, commands: 0 } });
    expect((await api(st.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: win.deviceId.slice(0, 8) })).status).toBe(400);
    const r = await api(st.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: win.fingerprint });
    expect(r.status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM notifications")).toBe(0);
    // the unpair command the revoke sent is kept (its answer can still arrive), and does not list the id again
    expect(count("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND type = 'unpair'", win.deviceId)).toBe(1);
    expect((await api(st.svc, "GET", "/api/devices")).json.orphaned).toEqual([]);
  });

  it("scans every table that has a device_id column", async () => {
    st = await fullStack();
    const tables = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .filter((t) => (db().prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>).some((c) => c.name === "device_id"))
      .map((t) => t.name);
    expect([...DEVICE_ID_TABLES].sort()).toEqual(tables.sort());
  });
});

describe("DELETE /api/devices/:id?wipe=1 for an orphaned id", () => {
  it("needs the short id, removes exactly its rows, adds the forgotten row, makes no R2 request and says the device was not paired", async () => {
    const { old, and } = await seed();
    const andLedger = count("SELECT COUNT(*) AS n FROM sync_objects WHERE device_id = ?", and.deviceId);
    const objects = st!.s3.mock.listAll(WIN_BUCKET).length;

    const bad = await api(st!.svc, "DELETE", `/api/devices/${old.deviceId}?wipe=1`, { confirm: "wrong" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("bad_confirm");
    expect(count("SELECT COUNT(*) AS n FROM files WHERE device_id = ?", old.deviceId)).toBe(5);

    st!.s3.mock.clearRequests();
    const r = await api(st!.svc, "DELETE", `/api/devices/${old.deviceId}?wipe=1`, { confirm: ` ${old.deviceId.slice(0, 8).toUpperCase()} ` });
    expect(r.status).toBe(200);
    expect(st!.s3.mock.requests()).toEqual([]);
    expect(st!.s3.mock.listAll(WIN_BUCKET).length).toBe(objects);
    expect(r.json).toMatchObject({
      forgotten: true, deviceId: old.deviceId, unpairSent: false, unpairCommandId: null, unpairReason: "Device was not paired, so it was not told to reset.",
      removed: { messages: 2, conversations: 1, files: 5, media: 1, pairings: 1, mediaArchive: 1, blobs: 1 },
    });

    for (const t of ["conversations", "messages", "message_sources", "notifications", "media", "files", "media_archive", "pairings", "collector_state", "collector_history", "quarantine", "commands"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${t} WHERE device_id = ?`, old.deviceId), t).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM sync_objects WHERE device_id = ? AND status <> 'ignored'", old.deviceId)).toBe(0);
    expect(db().prepare("SELECT role, fingerprint, unpair_sent_at AS sent, unpair_detail AS detail FROM forgotten_devices WHERE id = ?").get(old.deviceId))
      .toEqual({ role: "windows", fingerprint: "", sent: null, detail: "Device was not paired, so it was not told to reset." });
    // the paired Android device is untouched
    expect(count("SELECT COUNT(*) AS n FROM notifications WHERE device_id = ?", and.deviceId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sync_objects WHERE device_id = ?", and.deviceId)).toBe(andLedger);
    expect(count("SELECT COUNT(*) AS n FROM devices WHERE id = ?", and.deviceId)).toBe(1);

    // no longer listed, and gone for the footprint and a second forget
    expect((await api(st!.svc, "GET", "/api/devices")).json.orphaned).toEqual([]);
    expect((await api(st!.svc, "GET", `/api/devices/${old.deviceId}/footprint`)).status).toBe(404);
    expect((await api(st!.svc, "DELETE", `/api/devices/${old.deviceId}?wipe=1`, { confirm: old.deviceId.slice(0, 8) })).status).toBe(404);
  });

  it("a later upload from that id is ignored on the next poll and left in R2", async () => {
    const { old } = await seed();
    expect((await api(st!.svc, "DELETE", `/api/devices/${old.deviceId}?wipe=1`, { confirm: old.deviceId.slice(0, 8) })).status).toBe(200);
    const key = await old.put("windows_notification", { app: "Mail", title: "late", text: "after the forget", postedAt: iso() });
    const r = (await st!.svc.ingester.poll()).buckets.find((b) => b.bucket === WIN_BUCKET)!;
    expect(r).toMatchObject({ committed: 0, quarantined: 0, ignored: 1 });
    expect(db().prepare("SELECT status, device_id FROM sync_objects WHERE object_key = ?").get(key)).toEqual({ status: "ignored", device_id: old.deviceId });
    expect(st!.s3.mock.listAll(WIN_BUCKET).map((o) => o.key)).toContain(key);
    expect(count("SELECT COUNT(*) AS n FROM notifications WHERE device_id = ?", old.deviceId)).toBe(0);
    expect((await api(st!.svc, "GET", "/api/devices")).json.orphaned).toEqual([]);
  });

  it("an id that appears in no table is 404 for the footprint and the forget", async () => {
    st = await fullStack();
    expect((await api(st.svc, "GET", "/api/devices/ed2d211c-0000-0000-0000-000000000000/footprint")).status).toBe(404);
    expect((await api(st.svc, "DELETE", "/api/devices/ed2d211c-0000-0000-0000-000000000000?wipe=1", { confirm: "ed2d211c" })).status).toBe(404);
    expect((await api(st.svc, "GET", "/api/devices")).json.orphaned).toEqual([]);
  });
});
