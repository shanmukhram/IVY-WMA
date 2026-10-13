/**
 * Revoke and Forget tell the device to reset: each first sends an `unpair` command to the device's cmd-bucket.
 * That command survives the removal's own cleanup of open commands, and the device's command_status for it is
 * the one record still accepted after the device is gone: the command is marked done, its cmd object deleted,
 * and the confirmation is shown in GET /api/devices `removed`. Without R2 the removal still happens and says
 * the device was not told.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fullStack, pairNew, api, makeService, tempDir, rm, PASS } from "./helpers/harness.ts";
import { iso, type SimDevice } from "./helpers/device.ts";
import { issueCommand } from "../src/commands/commands.ts";
import type { Service } from "../src/service.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
let st: Stack | undefined;
const devs: SimDevice[] = [];
afterEach(async () => { for (const d of devs.splice(0)) d.close(); await st?.cleanup(); st = undefined; });

const db = () => st!.svc.ctx.db;
const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
const cmdKeys = (role = "windows") => st!.s3.mock.listAll(`ivy-cmd-${role}`).map((o) => o.key);
const cmdRow = (id: string) => db().prepare("SELECT type, status, cmd_deleted, object_key, completed_at FROM commands WHERE id = ?").get(id) as
  { type: string; status: string; cmd_deleted: number; object_key: string; completed_at: string | null };

async function setup() {
  st = await fullStack();
  const win = await pairNew(st.svc, "windows");
  devs.push(win);
  await st.svc.ingester.poll();
  return win;
}

describe("revoke sends unpair", () => {
  it("issues one unpair command that the revoke's cleanup leaves in the cmd-bucket; the device's late done status is accepted", async () => {
    const win = await setup();
    // an open rescan: the revoke cancels it and removes its object, as before
    const rescan = await issueCommand(st!.svc.ctx, win.deviceId, { type: "rescan", collector: "files" });
    expect(cmdKeys()).toEqual([rescan.object_key]);

    const r = await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ revoked: true, cancelledCommands: 1, unpairSent: true, unpairReason: null });
    const unpairId = r.json.unpairCommandId as string;
    expect(r.json.unpairSentAt).toBeTruthy();
    const unpair = cmdRow(unpairId);
    expect(unpair).toMatchObject({ type: "unpair", status: "sent", cmd_deleted: 0 });
    expect(cmdKeys()).toEqual([unpair.object_key]); // the rescan object is gone, the unpair object stays
    expect(cmdRow(rescan.id)).toMatchObject({ status: "cancelled", cmd_deleted: 1 });

    // the device reads it: wrapped to its key, no options
    const seen = await win.commands();
    expect(seen.map((c) => c.record)).toEqual([expect.objectContaining({ commandId: unpairId, deviceId: win.deviceId, params: { type: "unpair" } })]);

    // the Devices page lists it as waiting
    let list = (await api(st!.svc, "GET", "/api/devices")).json;
    expect(list.devices).toEqual([]);
    expect(list.removed).toEqual([{
      id: win.deviceId, role: "windows", name: null, fingerprint: win.fingerprint, removedAt: expect.any(String), kind: "revoked",
      unpairSentAt: r.json.unpairSentAt, unpairConfirmedAt: null, unpairDetail: null,
    }]);

    // any other record from the revoked device is still refused (quarantined) ...
    await win.put("windows_notification", { app: "Mail", title: "late", text: "after revoke", postedAt: iso() });
    // ... while its answer to the unpair command is committed
    await win.put("command_status", { commandId: unpairId, status: "done", reportedAt: iso() });
    await st!.svc.ingester.poll();

    expect(count("SELECT COUNT(*) AS n FROM notifications")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM quarantine WHERE device_id = ? AND kind = 'windows_notification'", win.deviceId)).toBe(1);
    const done = cmdRow(unpairId);
    expect(done).toMatchObject({ status: "done", cmd_deleted: 1 });
    expect(done.completed_at).toBeTruthy();
    expect(cmdKeys()).toEqual([]);
    expect(st!.s3.mock.listAll("ivy-up-windows").filter((o) => o.key.startsWith("up/cstat/"))).toEqual([]);
    const ev = st!.svc.ctx.events.recent({ types: ["device.unpair_confirmed"] });
    expect(ev[0]!.data).toMatchObject({ deviceId: win.deviceId, removed: "revoked" });

    list = (await api(st!.svc, "GET", "/api/devices")).json;
    expect(list.removed[0].unpairConfirmedAt).toBe(ev[0]!.data.confirmedAt);
    expect(count("SELECT COUNT(*) AS n FROM devices")).toBe(0); // accepting the answer does not bring the device back
  });

  it("a status for some other command id from the revoked device stays refused", async () => {
    const win = await setup();
    const rescan = await issueCommand(st!.svc.ctx, win.deviceId, { type: "rescan", collector: "files" });
    await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}`);
    await win.put("command_status", { commandId: rescan.id, status: "done", reportedAt: iso() });
    await st!.svc.ingester.poll();
    expect(cmdRow(rescan.id).status).toBe("cancelled");
    expect(count("SELECT COUNT(*) AS n FROM quarantine WHERE device_id = ? AND kind = 'command_status'", win.deviceId)).toBe(1);
  });

  it("POST /api/commands does not send unpair on its own", async () => {
    const win = await setup();
    const r = await api(st!.svc, "POST", "/api/commands", { deviceId: win.deviceId, params: { type: "unpair" } });
    expect(r.status).toBe(400);
    expect(cmdKeys()).toEqual([]);
  });
});

describe("forget sends unpair", () => {
  it("keeps the unpair command through the forget, accepts its answer, and still ignores every other record", async () => {
    const win = await setup();
    await api(st!.svc, "PATCH", `/api/devices/${win.deviceId}`, { name: "Desk PC" });
    const r = await api(st!.svc, "DELETE", `/api/devices/${win.deviceId}?wipe=1`, { confirm: win.fingerprint });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ forgotten: true, unpairSent: true, unpairReason: null });
    const unpairId = r.json.unpairCommandId as string;
    expect(cmdRow(unpairId)).toMatchObject({ type: "unpair", status: "sent", cmd_deleted: 0 });
    expect(cmdKeys()).toEqual([cmdRow(unpairId).object_key]);

    let removed = (await api(st!.svc, "GET", "/api/devices")).json.removed;
    expect(removed).toEqual([expect.objectContaining({ id: win.deviceId, kind: "forgotten", name: "Desk PC", unpairConfirmedAt: null })]);

    const noteKey = await win.put("windows_notification", { app: "Mail", title: "late", text: "after forget", postedAt: iso() });
    await win.put("command_status", { commandId: unpairId, status: "done", reportedAt: iso() });
    await st!.svc.ingester.poll();

    // the notification is ignored: not committed, left in R2, ledger 'ignored'
    expect(count("SELECT COUNT(*) AS n FROM notifications")).toBe(0);
    expect(db().prepare("SELECT status FROM sync_objects WHERE object_key = ?").get(noteKey)).toEqual({ status: "ignored" });
    expect(st!.s3.mock.listAll("ivy-up-windows").map((o) => o.key)).toEqual([noteKey]);
    // the unpair answer is committed
    expect(cmdRow(unpairId)).toMatchObject({ status: "done", cmd_deleted: 1 });
    expect(cmdKeys()).toEqual([]);
    removed = (await api(st!.svc, "GET", "/api/devices")).json.removed;
    expect(removed[0].unpairConfirmedAt).toBeTruthy();
    expect(db().prepare("SELECT unpair_confirmed_at AS c FROM forgotten_devices WHERE id = ?").get(win.deviceId)).toEqual({ c: removed[0].unpairConfirmedAt });
  });
});

describe("without R2", () => {
  let svc: Service | undefined;
  let dir: string | undefined;
  afterEach(async () => { await svc?.close(); if (dir) rm(dir); svc = undefined; dir = undefined; });

  it("revoke and forget still succeed and say the device was not told", async () => {
    dir = tempDir();
    svc = await makeService(dir);
    await svc.ctx.keystore.initialize(PASS);
    const add = (id: string, fp: string) => svc!.ctx.db.prepare(`INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', ?, ?, ?)`)
      .run(id, Buffer.alloc(32, 1).toString("base64"), fp, iso());
    add("d-revoke", "AAAA-AAAA-AAAA-AAAA");
    add("d-forget", "BBBB-BBBB-BBBB-BBBB");

    const r = await api(svc, "DELETE", "/api/devices/d-revoke");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ revoked: true, unpairSent: false, unpairCommandId: null, unpairSentAt: null });
    expect(r.json.unpairReason).toMatch(/R2 is not configured/);

    const f = await api(svc, "DELETE", "/api/devices/d-forget?wipe=1", { confirm: "BBBB-BBBB-BBBB-BBBB" });
    expect(f.status).toBe(200);
    expect(f.json).toMatchObject({ forgotten: true, unpairSent: false });
    expect(f.json.unpairReason).toMatch(/R2 is not configured/);

    expect(svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM commands").get()).toEqual({ n: 0 });
    const removed = (await api(svc, "GET", "/api/devices")).json.removed as Array<Record<string, unknown>>;
    expect(removed.map((x) => [x.id, x.kind, x.unpairSentAt])).toEqual(expect.arrayContaining([["d-revoke", "revoked", null], ["d-forget", "forgotten", null]]));
    expect(removed.every((x) => typeof x.unpairDetail === "string" && /not configured/.test(x.unpairDetail as string))).toBe(true);
  });
});
