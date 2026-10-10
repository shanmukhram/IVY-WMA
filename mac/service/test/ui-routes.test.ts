/** Listing routes added for the dashboard UI (src/http/ui-routes.ts). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitMessageBatch, commitScreenshot, commitWindowsNotification } from "../src/ingest/committers.ts";

let svc: Service;
let dir: string;
const AND = "dev-and";
const b = (deviceId: string, kind: string, t = "2026-09-24T10:00:00.000Z") => ({ v: 1 as const, kind, deviceId, eventTime: t, captureTime: "2026-10-10T00:00:00.000Z" });
const SHA = "ab".repeat(32);

beforeAll(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  const db = svc.ctx.db;
  db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'android', 'k', 'FP', 't')").run(AND);
  commitMessageBatch(db, { ...b(AND, "message_batch"), kind: "message_batch", platform: "line", account: "bunny", convKey: "c1", peer: "Aki", convKind: "dm", coverage: "complete", cursor: "2",
    messages: [
      { msgId: "1", sender: "Aki", sentAt: "2026-09-24T14:00:00.000Z", text: "look at this", sourceStatus: "live", attachments: [{ attId: "a1", kind: "image", filename: "offer.jpg", size: 10, originHash: SHA }] },
      { msgId: "2", sender: "bunny", sentAt: "2026-09-24T14:01:00.000Z", text: "thanks", sourceStatus: "live", attachments: [] },
    ] } as never);
  commitWindowsNotification(db, { ...b(AND, "windows_notification"), kind: "windows_notification", app: "Teams", title: "Kenji", sender: "Kenji", text: "hello", postedAt: "2026-09-24T11:00:00.000Z" } as never);
  commitScreenshot(db, { ...b(AND, "screenshot"), kind: "screenshot", sourcePath: "/sdcard/shot.png", sha256: SHA, blobOid: "0".repeat(26) } as never);
});
afterAll(async () => { await svc.close(); rm(dir); });

describe("dashboard listing routes", () => {
  it("lists conversations with coverage and counts, and attachments per message", async () => {
    const r = await api(svc, "GET", "/api/conversations");
    expect(r.status).toBe(200);
    expect(r.json.items).toEqual([expect.objectContaining({ platform: "line", peer: "Aki", coverage: "complete", messageCount: 2, lastMessageAt: "2026-09-24T14:01:00.000Z" })]);
    const msgs = await api(svc, "GET", `/api/conversations/${r.json.items[0].id}/messages`);
    const ids = msgs.json.messages.map((m: { id: string }) => m.id).join(",");
    const att = await api(svc, "GET", `/api/attachments?message=${ids}`);
    expect(att.json.items).toEqual([expect.objectContaining({ filename: "offer.jpg", status: "on_demand", local: 0 })]);
  });

  it("lists notifications per app as partial records", async () => {
    expect((await api(svc, "GET", "/api/notifications/apps")).json.apps).toEqual([expect.objectContaining({ app: "Teams", count: 1 })]);
    const n = await api(svc, "GET", "/api/notifications?app=teams");
    expect(n.json.total).toBe(1);
    expect(n.json.items[0]).toMatchObject({ type: "notification", title: "Kenji", detail: { partial: true } });
  });

  it("lists media and reports evidenced origin by content hash, never inferred ones", async () => {
    const m = await api(svc, "GET", "/api/media?kind=screenshot");
    expect(m.json.items).toHaveLength(1);
    const o = await api(svc, "GET", `/api/media/${m.json.items[0].id}/origin`);
    expect(o.json.evidenced).toEqual([expect.objectContaining({ platform: "line", sender: "Aki", filename: "offer.jpg", evidence: "identical content hash" })]);
    expect(o.json.inferred).toEqual([]);
    expect((await api(svc, "GET", "/api/media/nope/origin")).status).toBe(404);
  });

  it("serves facets and the UI-owned settings; refuses unknown keys", async () => {
    const f = await api(svc, "GET", "/api/facets");
    expect(f.json.apps).toEqual(expect.arrayContaining(["line", "Teams"]));
    expect(f.json.accounts).toEqual(["bunny"]);
    expect((await api(svc, "GET", "/api/ui-settings")).json.settings).toEqual({ "ai.cloudEnabled": false });
    expect((await api(svc, "PUT", "/api/ui-settings", { "ai.cloudEnabled": true })).json.settings).toEqual({ "ai.cloudEnabled": true });
    expect((await api(svc, "PUT", "/api/ui-settings", { "ai.cloudEnabled": "yes" })).status).toBe(400);
    expect((await api(svc, "PUT", "/api/ui-settings", { other: 1 })).status).toBe(400);
  });

  it("is locked like every other content route", async () => {
    await api(svc, "POST", "/api/keystore/lock", { full: false });
    expect((await api(svc, "GET", "/api/conversations")).status).toBe(423);
    await api(svc, "POST", "/api/keystore/unlock", { passphrase: PASS });
  });
});
