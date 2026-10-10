import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { SimDevice, iso } from "./helpers/device.ts";
import { issueCommand, requestFile, sendQueued, cancelCommand } from "../src/commands/commands.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let st: Awaited<ReturnType<typeof fullStack>>;
let dev: SimDevice;
const db = () => st.svc.ctx.db;
const cmdKeys = () => st.s3.mock.listAll("ivy-cmd-windows").map((o) => o.key);
const PATH = "C:\\Users\\bunny\\Documents\\invoice.pdf";
let fileId: string;

beforeAll(async () => {
  st = await fullStack();
  dev = await pairNew(st.svc, "windows");
  await dev.put("file_meta", { path: PATH, name: "invoice.pdf", ext: "pdf", size: 900, mtime: iso(), quickHash: "q" });
  await st.svc.ingester.poll();
  fileId = (db().prepare("SELECT id FROM files").get() as { id: string }).id;
});
afterAll(async () => { dev.close(); await st.cleanup(); });

describe("commands (F2, F3, PLAN decision 4)", () => {
  it("issues a rescan wrapped to the device key into its cmd-bucket", async () => {
    const c = await issueCommand(st.svc.ctx, dev.deviceId, { type: "rescan", collector: "files", scope: "C:\\" });
    expect(c.status).toBe("sent");
    expect(cmdKeys()).toContain(c.object_key);
    const cmds = await dev.commands();
    const mine = cmds.find((x) => x.key === c.object_key)!;
    expect(mine.record).toMatchObject({ commandId: c.id, deviceId: dev.deviceId, params: { type: "rescan", collector: "files", scope: "C:\\" } });
  });

  it("deletes cmd/<oid> when the matching command_status is ingested", async () => {
    const c = await issueCommand(st.svc.ctx, dev.deviceId, { type: "collector_config", collector: "usage", enabled: false });
    await dev.put("command_status", { commandId: c.id, status: "done", reportedAt: iso() });
    await st.svc.ingester.poll();
    const row = db().prepare("SELECT status, cmd_deleted, completed_at FROM commands WHERE id = ?").get(c.id) as Record<string, unknown>;
    expect(row).toMatchObject({ status: "done", cmd_deleted: 1 });
    expect(row.completed_at).toBeTruthy();
    expect(cmdKeys()).not.toContain(c.object_key);
  });

  it("file_request: by file id -> path; the file_original blob lands and the file becomes cached", async () => {
    const r = await requestFile(st.svc.ctx, fileId);
    const cmdId = r.command!.id;
    const [sent] = (await dev.commands()).filter((x) => x.record.commandId === cmdId);
    expect(sent!.record.params).toEqual({ type: "file_request", path: PATH });
    const original = new Uint8Array(randomBytes(900));
    const b = dev.blob(original, "file_original", 400);
    await dev.putBlob(b);
    await dev.put("command_status", { commandId: cmdId, status: "uploaded", resultOid: b.oid, reportedAt: iso() });
    await st.svc.ingester.poll();
    const f = db().prepare("SELECT status, local_path FROM files WHERE id = ?").get(fileId) as { status: string; local_path: string };
    expect(f.status).toBe("cached");
    expect(f.local_path).toMatch(/\/files\/[0-9A-Z]{26}\/invoice\.pdf$/);
    expect(sha(readFileSync(f.local_path))).toBe(sha(original));
    expect(db().prepare("SELECT status FROM commands WHERE id = ?").get(cmdId)).toEqual({ status: "done" });
    expect(cmdKeys().some((k) => k === `cmd/${(db().prepare("SELECT oid FROM commands WHERE id = ?").get(cmdId) as { oid: string }).oid}`)).toBe(false);
    expect(st.svc.ctx.events.recent({ types: ["file.cached"] })[0]!.data).toMatchObject({ fileId, commandId: cmdId });
    const content = await api(st.svc, "GET", `/api/files/${fileId}/content`);
    expect(content.status).toBe(200);
  });

  it("a manifest carrying the commandId marks the command transferring with part progress before command_status", async () => {
    await dev.put("file_meta", { path: "C:\\a\\big.bin", name: "big.bin", ext: "bin", size: 1000, mtime: iso(), quickHash: "b" });
    await st.svc.ingester.poll();
    const id = (db().prepare("SELECT id FROM files WHERE name = 'big.bin'").get() as { id: string }).id;
    const cmdId = (await requestFile(st.svc.ctx, id)).command!.id;
    const original = new Uint8Array(randomBytes(1000));
    const b = dev.blob(original, "file_original", 256, { commandId: cmdId });
    expect(b.parts).toHaveLength(4);
    const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
    const off = st.svc.ctx.events.on((e) => { if (e.type.startsWith("command.")) seen.push(e); });
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    await dev.up.put(b.parts[1]!.key, b.parts[1]!.bytes);
    await st.svc.ingester.poll();
    let view = (await api(st.svc, "GET", `/api/commands/${cmdId}`)).json;
    expect(view).toMatchObject({ status: "transferring", display: "transferring", waitingOn: "transfer", resultOid: b.oid,
      progress: { committedParts: 2, totalChunks: 4, committedBytes: 512, totalSize: 1000 } });
    expect((await api(st.svc, "GET", `/api/commands?status=transferring`)).json.commands.map((c: { id: string }) => c.id)).toContain(cmdId);
    expect(seen.find((e) => e.type === "command.transferring")!.data).toMatchObject({ commandId: cmdId, resultOid: b.oid, committedParts: 0, totalChunks: 4 });
    expect(seen.filter((e) => e.type === "command.progress").map((e) => e.data.committedParts)).toEqual([1, 2]);
    // a repeat request for the same file reuses the transferring command
    expect((await requestFile(st.svc.ctx, id)).reused).toBe(true);
    // the rest of the parts: the original is placed and the command completes even before its status
    await dev.up.put(b.parts[2]!.key, b.parts[2]!.bytes);
    await dev.up.put(b.parts[3]!.key, b.parts[3]!.bytes);
    await st.svc.ingester.poll();
    view = (await api(st.svc, "GET", `/api/commands/${cmdId}`)).json;
    expect(view).toMatchObject({ status: "done", progress: { committedParts: 4, totalChunks: 4 } });
    const f = db().prepare("SELECT status, local_path FROM files WHERE id = ?").get(id) as { status: string; local_path: string };
    expect(f.status).toBe("cached");
    expect(sha(readFileSync(f.local_path))).toBe(sha(original));
    // the late "uploaded" never downgrades it, and the cmd object is cleaned up
    await dev.put("command_status", { commandId: cmdId, status: "uploaded", resultOid: b.oid, reportedAt: iso() });
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT status, cmd_deleted FROM commands WHERE id = ?").get(cmdId)).toEqual({ status: "done", cmd_deleted: 1 });
    off();
  });

  it("a transfer whose part fails verification turns its command into an honest error", async () => {
    await dev.put("file_meta", { path: "C:\\a\\bad.bin", name: "bad.bin", ext: "bin", size: 300, mtime: iso(), quickHash: "x" });
    await st.svc.ingester.poll();
    const id = (db().prepare("SELECT id FROM files WHERE name = 'bad.bin'").get() as { id: string }).id;
    const cmdId = (await requestFile(st.svc.ctx, id)).command!.id;
    const b = dev.blob(new Uint8Array(randomBytes(300)), "file_original", 128, { commandId: cmdId });
    const tampered = new Uint8Array(b.parts[1]!.bytes);
    tampered[tampered.length - 1]! ^= 1;
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    await dev.up.put(b.parts[1]!.key, tampered);
    await st.svc.ingester.poll();
    expect((await api(st.svc, "GET", `/api/commands/${cmdId}`)).json).toMatchObject({ status: "error", detail: expect.stringMatching(/^transfer failed: part 1/) });
  });

  it("a manifest naming an unknown, finished or other-role command is not linked", async () => {
    const c = await issueCommand(st.svc.ctx, dev.deviceId, { type: "rescan", collector: "files" });
    for (const commandId of ["no-such-command", c.id]) {
      const b = dev.blob(new TextEncoder().encode("x".repeat(10)), "file_original", 64, { commandId });
      await dev.up.put(b.manifest.key, b.manifest.bytes);
      await st.svc.ingester.poll();
      expect(db().prepare("SELECT command_id FROM blobs WHERE oid = ?").get(b.oid)).toEqual({ command_id: null });
    }
    expect(db().prepare("SELECT status FROM commands WHERE id = ?").get(c.id)).toEqual({ status: "sent" });
  });

  it("the original can arrive before its command_status and is placed when the status names it", async () => {
    await dev.put("file_meta", { path: "C:\\a\\notes.txt", name: "notes.txt", ext: "txt", size: 5, mtime: iso(), quickHash: "n" });
    await st.svc.ingester.poll();
    const id = (db().prepare("SELECT id FROM files WHERE name = 'notes.txt'").get() as { id: string }).id;
    const r = await requestFile(st.svc.ctx, id);
    const b = dev.blob(new TextEncoder().encode("hello"), "file_original", 64);
    await dev.putBlob(b);
    await st.svc.ingester.poll(); // blob only
    expect(db().prepare("SELECT status FROM files WHERE id = ?").get(id)).toEqual({ status: "reference" });
    await dev.put("command_status", { commandId: r.command!.id, status: "uploaded", resultOid: b.oid, reportedAt: iso() });
    await st.svc.ingester.poll();
    const f = db().prepare("SELECT status, local_path FROM files WHERE id = ?").get(id) as { status: string; local_path: string };
    expect(f.status).toBe("cached");
    expect(readFileSync(f.local_path, "utf8")).toBe("hello");
  });

  it("an outstanding request for the same file is reused, and a cached file is not re-requested", async () => {
    await dev.put("file_meta", { path: "C:\\a\\b.txt", name: "b.txt", ext: "txt", size: 5, mtime: iso(), quickHash: "b" });
    await st.svc.ingester.poll();
    const id = (db().prepare("SELECT id FROM files WHERE name = 'b.txt'").get() as { id: string }).id;
    const a = await requestFile(st.svc.ctx, id);
    const b = await requestFile(st.svc.ctx, id);
    expect(b.reused).toBe(true);
    expect(b.command!.id).toBe(a.command!.id);
    expect(await requestFile(st.svc.ctx, fileId)).toMatchObject({ alreadyCached: true });
  });

  it("a device error status is recorded and the command is deleted from the bucket", async () => {
    await dev.put("file_meta", { path: "C:\\gone.txt", name: "gone.txt", ext: "txt", size: 1, mtime: iso(), quickHash: "g" });
    await st.svc.ingester.poll();
    const id = (db().prepare("SELECT id FROM files WHERE name = 'gone.txt'").get() as { id: string }).id;
    const r = await requestFile(st.svc.ctx, id);
    await dev.put("command_status", { commandId: r.command!.id, status: "not_found", detail: "no such file", reportedAt: iso() });
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT status, detail, cmd_deleted FROM commands WHERE id = ?").get(r.command!.id)).toEqual({ status: "not_found", detail: "no such file", cmd_deleted: 1 });
  });

  it("with R2 unreachable a command stays queued and is sent on the next pass", async () => {
    const good = st.svc.ctx.r2()!.config;
    st.svc.ctx.setR2Config({ ...good, endpoint: "http://127.0.0.1:9" }); // nothing listens there
    const c = await issueCommand(st.svc.ctx, dev.deviceId, { type: "rescan", collector: "screenshots" });
    expect(c.status).toBe("queued");
    expect(c.last_error).toBeTruthy();
    const view = (await api(st.svc, "GET", `/api/commands/${c.id}`)).json;
    expect(view).toMatchObject({ display: "queued", waitingOn: "mac" });
    st.svc.ctx.setR2Config(good);
    expect(await sendQueued(st.svc.ctx)).toBe(1);
    expect(db().prepare("SELECT status FROM commands WHERE id = ?").get(c.id)).toEqual({ status: "sent" });
    const v2 = (await api(st.svc, "GET", `/api/commands/${c.id}`)).json;
    expect(v2).toMatchObject({ display: "queued", waitingOn: "device" }); // an offline device just leaves it waiting
  });

  it("cancels a sent command and removes it from the bucket", async () => {
    const c = await issueCommand(st.svc.ctx, dev.deviceId, { type: "rescan", collector: "usage" });
    expect(await cancelCommand(st.svc.ctx, c.id)).toBe(true);
    expect(cmdKeys()).not.toContain(c.object_key);
    expect(db().prepare("SELECT status FROM commands WHERE id = ?").get(c.id)).toEqual({ status: "cancelled" });
  });

  it("API: request original, rescan and collector-config endpoints", async () => {
    const r1 = await api(st.svc, "POST", `/api/devices/${dev.deviceId}/rescan`, { collector: "files" });
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ type: "rescan", status: "sent" });
    const r2 = await api(st.svc, "POST", `/api/devices/${dev.deviceId}/collector-config`, { collector: "usage", settings: { captureTitles: false } });
    expect(r2.json.params).toEqual({ type: "collector_config", collector: "usage", settings: { captureTitles: false } });
    const r3 = await api(st.svc, "POST", `/api/files/does-not-exist/request`, {});
    expect(r3.status).toBe(404);
    const r4 = await api(st.svc, "POST", `/api/devices/nope/rescan`, { collector: "files" });
    expect(r4.status).toBe(404);
  });
});
