/**
 * Attachment status shown by the views (PLAN decision 12): a LINE for Windows attachment with no
 * original on its way reads phone_only (LINE for Windows keeps no inline media on disk, so the
 * original is on the phone); Telegram and Android-delivered attachments keep the stored status.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitMessageBatch } from "../src/ingest/committers.ts";

let svc: Service;
let dir: string;
const WIN = "dev-win";
const AND = "dev-and";
const OID = "1".repeat(26);
const base = (deviceId: string) => ({ v: 1 as const, kind: "message_batch", deviceId, eventTime: "2026-10-01T10:00:00.000Z", captureTime: "2026-10-10T00:00:00.000Z" });
const msg = (msgId: string, attachments: unknown[]) => ({ msgId, sender: "Aki", sentAt: `2026-10-01T10:0${msgId}:00.000Z`, text: "", sourceStatus: "live", attachments });
const line = { ...base(WIN), sourceSession: "windows:line-desktop", platform: "line", account: "bunny", convKey: "u1", peer: "Aki", convKind: "dm", coverage: "partial", cursor: "1" };
const tg = { ...base(WIN), sourceSession: "windows:telegram-desktop", platform: "telegram", account: "42", convKey: "77", peer: "Aki", convKind: "dm", coverage: "complete", cursor: "1" };
let lineId = "", tgId = "";

beforeAll(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  const db = svc.ctx.db;
  db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'FPW', 't')").run(WIN);
  db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'android', 'k', 'FPA', 't')").run(AND);
  lineId = commitMessageBatch(db, { ...line, messages: [
    msg("1", [{ attId: "img1", kind: "image", filename: "photo.jpg", size: 10 }]),                 // no blob: original only on the phone
    msg("2", [{ attId: "img2", kind: "image", filename: "saved.jpg", size: 10, blobOid: OID }]),   // a blob: normal statuses
    msg("3", [{ attId: "vid3", kind: "video", filename: "clip.mp4", size: 10 }]),                  // later also from Android
  ] } as never).summary.conversationId as string;
  // the blob of message 2 has been placed
  db.prepare("UPDATE attachments SET status = 'cached', local_path = ? WHERE att_key = 'img2'").run(dir + "/saved.jpg");
  // the Android adapter later imports message 3 of the same LINE chat
  commitMessageBatch(db, { ...line, ...base(AND), sourceSession: "android:root-db", messages: [msg("3", [{ attId: "vid3", kind: "video", filename: "clip.mp4", size: 10 }])] } as never);
  tgId = commitMessageBatch(db, { ...tg, messages: [msg("1", [{ attId: "doc1", kind: "doc", filename: "notes.pdf", size: 10 }])] } as never).summary.conversationId as string;
});
afterAll(async () => { await svc.close(); rm(dir); });

const byFile = (msgs: Array<{ attachments: Array<{ filename: string; status: string }> }>) =>
  Object.fromEntries(msgs.flatMap((m) => m.attachments).map((a) => [a.filename, a.status]));

describe("attachment status derivation", () => {
  it("LINE for Windows without a blob is phone_only; with a blob it is cached; once Android delivered it the stored status stands", async () => {
    const r = await api(svc, "GET", `/api/views/chats/${lineId}/messages`);
    expect(r.status).toBe(200);
    expect(byFile(r.json.messages)).toEqual({ "photo.jpg": "phone_only", "saved.jpg": "cached", "clip.mp4": "on_demand" });
    const ids = r.json.messages.map((m: { id: string }) => m.id).join(",");
    const a = await api(svc, "GET", `/api/attachments?message=${ids}`);
    expect(Object.fromEntries(a.json.items.map((x: { filename: string; status: string }) => [x.filename, x.status])))
      .toEqual({ "photo.jpg": "phone_only", "saved.jpg": "cached", "clip.mp4": "on_demand" });
    expect((await api(svc, "GET", `/api/views/chats/${lineId}/profile`)).json.attachments).toEqual({ phone_only: 1, cached: 1, on_demand: 1 });
    // the stored status is untouched
    expect(svc.ctx.db.prepare("SELECT status FROM attachments WHERE att_key = 'img1'").get()).toEqual({ status: "on_demand" });
  });

  it("a Telegram attachment without a blob stays on_demand", async () => {
    const r = await api(svc, "GET", `/api/views/chats/${tgId}/messages`);
    expect(byFile(r.json.messages)).toEqual({ "notes.pdf": "on_demand" });
  });
});
