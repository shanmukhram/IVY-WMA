/** Read-only routes for the redesigned dashboard (src/http/view-routes.ts). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitMessageBatch, commitScreenshot, commitWindowsNotification } from "../src/ingest/committers.ts";

let svc: Service;
let dir: string;
const WIN = "dev-win";
const AND = "dev-and";
const b = (deviceId: string, kind: string, t = "2026-09-24T10:00:00.000Z") => ({ v: 1 as const, kind, deviceId, eventTime: t, captureTime: "2026-10-10T00:00:00.000Z" });
const msg = (msgId: string, sender: string, sentAt: string, text: string, over: Record<string, unknown> = {}) => ({ msgId, sender, sentAt, text, sourceStatus: "live", attachments: [], ...over });

beforeAll(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  const db = svc.ctx.db;
  db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'FPW', 't')").run(WIN);
  db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'android', 'k', 'FPA', 't')").run(AND);
  const tg = { ...b(WIN, "message_batch"), kind: "message_batch", sourceSession: "windows:telegram-desktop", platform: "telegram", account: "42", convKey: "-100", peer: "Robotics lab", convKind: "group", coverage: "complete", cursor: "3" };
  commitMessageBatch(db, { ...tg, messages: [
    msg("1", "7", "2026-09-24T09:00:00.000Z", "first"),
    msg("2", "42", "2026-09-24T09:05:00.000Z", "mine, edited", { editedAt: "2026-09-24T09:06:00.000Z" }),
    msg("3", "7", "2026-09-25T08:00:00.000Z", "latest", { attachments: [{ attId: "a1", kind: "image", filename: "x.jpg", size: 3 }] }),
  ] } as never);
  // the same chat seen by the Android database, one message deleted there
  commitMessageBatch(db, { ...tg, ...b(AND, "message_batch"), kind: "message_batch", sourceSession: "android:root-db", coverage: "complete", cursor: "1",
    messages: [msg("1", "7", "2026-09-24T09:00:00.000Z", "first", { sourceStatus: "deleted_at_source", deletedAtSource: "2026-09-26T00:00:00.000Z" })] } as never);
  commitMessageBatch(db, { ...b(WIN, "message_batch"), kind: "message_batch", sourceSession: "windows:line-desktop", platform: "line", account: "bunny", convKey: "u1", peer: "Aki", convKind: "dm", coverage: "partial", cursor: "1",
    messages: [msg("9", "Aki", "2026-09-20T10:00:00.000Z", "hello from line")] } as never);
  commitWindowsNotification(db, { ...b(WIN, "windows_notification"), kind: "windows_notification", app: "Teams", title: "Kenji", sender: "Kenji", text: "hi", postedAt: "2026-09-24T11:00:00.000Z" } as never);
  commitScreenshot(db, { ...b(WIN, "screenshot"), kind: "screenshot", sourcePath: "C:\\shot.png", sha256: "ab".repeat(32), blobOid: "0".repeat(26) } as never);
  db.prepare("UPDATE media SET ocr_text = 'robotics offer'").run();
});
afterAll(async () => { await svc.close(); rm(dir); });

describe("dashboard view routes", () => {
  it("lists capture sources per platform with counts", async () => {
    const r = await api(svc, "GET", "/api/views/sources");
    expect(r.status).toBe(200);
    expect(r.json.sources).toEqual([
      expect.objectContaining({ source: "android:root-db", role: "android", collector: "root-db", platform: "telegram", conversations: 1, messages: 1 }),
      expect.objectContaining({ source: "windows:line-desktop", role: "windows", platform: "line", conversations: 1, messages: 1 }),
      expect.objectContaining({ source: "windows:telegram-desktop", role: "windows", platform: "telegram", conversations: 1, messages: 3, lastMessageAt: "2026-09-25T08:00:00.000Z" }),
    ]);
  });

  it("lists chats per source and per role with the last message preview", async () => {
    const tg = await api(svc, "GET", "/api/views/chats?source=windows:telegram-desktop");
    expect(tg.json.total).toBe(1);
    expect(tg.json.items[0]).toMatchObject({ peer: "Robotics lab", messageCount: 3, firstMessageAt: "2026-09-24T09:00:00.000Z", lastMessage: { text: "latest", sender: "7" } });
    expect(tg.json.items[0].coverageSources.map((s: { source: string }) => s.source)).toEqual(["android:root-db", "windows:telegram-desktop"]);
    expect((await api(svc, "GET", "/api/views/chats?source=windows:line-desktop")).json.items.map((c: { peer: string }) => c.peer)).toEqual(["Aki"]);
    expect((await api(svc, "GET", "/api/views/chats?role=android")).json.items.map((c: { peer: string }) => c.peer)).toEqual(["Robotics lab"]);
    expect((await api(svc, "GET", "/api/views/chats?role=windows&platform=line")).json.total).toBe(1);
    expect((await api(svc, "GET", "/api/views/chats?q=robot")).json.total).toBe(1);
    expect((await api(svc, "GET", "/api/views/chats?source=bad source")).status).toBe(400);
  });

  it("builds the profile pane: counts, first/last, per-source coverage and deletions", async () => {
    const id = (await api(svc, "GET", "/api/views/chats?source=windows:telegram-desktop")).json.items[0].id;
    const p = await api(svc, "GET", `/api/views/chats/${id}/profile`);
    expect(p.json).toMatchObject({ messages: 3, firstMessageAt: "2026-09-24T09:00:00.000Z", lastMessageAt: "2026-09-25T08:00:00.000Z", edited: 1, deletedAtSource: 1 });
    expect(p.json.attachments).toEqual({ on_demand: 1 });
    expect(p.json.sources).toEqual([
      expect.objectContaining({ source: "android:root-db", coverage: "complete", messages: 1, deletedThere: 1 }),
      expect.objectContaining({ source: "windows:telegram-desktop", coverage: "complete", messages: 3, deletedThere: 0 }),
    ]);
    expect(p.json.senders[0]).toEqual({ sender: "7", n: 2 });
    expect((await api(svc, "GET", "/api/views/chats/nope/profile")).status).toBe(404);
  });

  it("lists records by device and type, newest first, with OCR text on media", async () => {
    const m = await api(svc, "GET", "/api/views/records?type=screenshot,photo&device=windows");
    expect(m.json.total).toBe(1);
    expect(m.json.items[0]).toMatchObject({ type: "screenshot", ocrText: "robotics offer" });
    expect((await api(svc, "GET", "/api/views/records?type=screenshot&device=android")).json.total).toBe(0);
    expect((await api(svc, "GET", `/api/views/records?type=notification&device=${WIN}&app=teams`)).json.items[0]).toMatchObject({ title: "Kenji" });
    const msgs = await api(svc, "GET", "/api/views/records?type=message&device=windows");
    expect(msgs.json.items[0].eventTime >= msgs.json.items.at(-1).eventTime).toBe(true);
    expect((await api(svc, "GET", "/api/views/records?type=nope")).status).toBe(400);
  });

  it("counts notification apps per device", async () => {
    expect((await api(svc, "GET", "/api/views/notification-apps?device=windows")).json.apps).toEqual([expect.objectContaining({ app: "Teams", count: 1 })]);
    expect((await api(svc, "GET", "/api/views/notification-apps?device=android")).json.apps).toEqual([]);
  });

  it("is locked like every other content route", async () => {
    await api(svc, "POST", "/api/keystore/lock", { full: false });
    expect((await api(svc, "GET", "/api/views/sources")).status).toBe(423);
    await api(svc, "POST", "/api/keystore/unlock", { passphrase: PASS });
  });
});
