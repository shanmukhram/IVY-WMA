/**
 * The dashboard's device scope: device=<id|windows|android> on every read API means the same
 * thing (query/types.ts deviceScope). Two Windows devices and one Android device; one Telegram
 * conversation captured by a Windows device and by the Android device; a LINE conversation from
 * the second Windows device; notifications, files and media from each.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitMessageBatch } from "../src/ingest/committers.ts";

let svc: Service;
let dir: string;
const W1 = "dev-win-1", W2 = "dev-win-2", A1 = "dev-and-1";
const DAY = "2026-09-24";
const T = (h: number) => `${DAY}T${String(h).padStart(2, "0")}:00:00.000Z`;
const db = () => svc.ctx.db;
const msg = (msgId: string, sentAt: string, text: string) => ({ msgId, sender: "Aki", sentAt, text, sourceStatus: "live", attachments: [] });
const batch = (deviceId: string, over: Record<string, unknown>) => commitMessageBatch(db(), {
  v: 1, kind: "message_batch", deviceId, eventTime: T(9), captureTime: "2026-10-10T00:00:00.000Z",
  platform: "telegram", account: "@bunny", convKey: "-100", peer: "Robotics lab", convKind: "group", coverage: "complete", cursor: "1", ...over,
} as never);

// what each scope should see (by record title / text marker)
let tgId = "", lineId = "";

beforeAll(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  db().prepare(`INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES
    (?, 'windows', 'k', 'FPW1', 't1'), (?, 'windows', 'k', 'FPW2', 't2'), (?, 'android', 'k', 'FPA1', 't3')`).run(W1, W2, A1);

  // Telegram: message 1 from Windows 1 and from Android; message 2 only from Android
  batch(W1, { sourceSession: "windows:telegram-desktop", messages: [msg("1", T(9), "walrus tg one")] });
  batch(A1, { sourceSession: "android:root-db", coverage: "partial", messages: [msg("1", T(9), "walrus tg one"), msg("2", T(10), "walrus tg two")] });
  // LINE from Windows 2
  batch(W2, { sourceSession: "windows:line-desktop", platform: "line", account: "bunny", convKey: "u1", peer: "Kenji", convKind: "dm", coverage: "partial",
    messages: [msg("9", T(11), "walrus line")] });
  tgId = (db().prepare("SELECT id FROM conversations WHERE platform = 'telegram'").get() as { id: string }).id;
  lineId = (db().prepare("SELECT id FROM conversations WHERE platform = 'line'").get() as { id: string }).id;

  const notif = db().prepare(`INSERT INTO notifications(id, device_id, source, app, title, preview, posted_at, captured_at, ingested_at, dedupe_key)
                              VALUES (?, ?, ?, 'Teams', ?, 'walrus note', ?, 't', 't', ?)`);
  notif.run("n-w1", W1, "windows", "note w1", T(12), "k1");
  notif.run("n-w2", W2, "windows", "note w2", T(12), "k2");
  notif.run("n-a1", A1, "android", "note a1", T(12), "k3");
  const file = db().prepare(`INSERT INTO files(id, device_id, path, name, mtime, event_time, captured_at, first_seen_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, 't', 't', 't', ?)`);
  file.run("f-w1", W1, "C:\\walrus-w1.txt", "walrus-w1.txt", T(13), "u1");
  file.run("f-w2", W2, "C:\\walrus-w2.txt", "walrus-w2.txt", T(13), "u2");
  const media = db().prepare(`INSERT INTO media(id, device_id, kind, source_path, captured_at, imported_at, taken_at, ocr_text, ocr_status)
                              VALUES (?, ?, ?, ?, 't', 't', ?, ?, 'done')`);
  media.run("m-w1", W1, "screenshot", "C:\\shot-w1.png", T(14), "walrus shot w1");
  media.run("m-w2", W2, "photo", "C:\\photo-w2.jpg", T(14), "walrus photo w2");
  media.run("m-a1", A1, "photo", "/sdcard/photo-a1.jpg", T(14), "walrus photo a1");
});
afterAll(async () => { await svc.close(); rm(dir); });

const get = async (url: string) => {
  const r = await api(svc, "GET", url);
  expect(r.status, url).toBe(200);
  return r.json;
};
const q = (device: string | null) => (device ? `device=${encodeURIComponent(device)}` : "");
const sorted = (xs: string[]) => [...xs].sort();

/** Message texts in a scope, read from the record listing. */
async function messageTexts(device: string | null) {
  return sorted((await get(`/api/views/records?type=message&${q(device)}`)).items.map((i: { body: string }) => i.body));
}

// scope -> expected ids / markers
const EXPECT: Record<string, { notes: string[]; files: string[]; media: string[]; messages: string[]; chats: string[] }> = {
  [W1]: { notes: ["n-w1"], files: ["f-w1"], media: ["m-w1"], messages: ["walrus tg one"], chats: ["telegram"] },
  [W2]: { notes: ["n-w2"], files: ["f-w2"], media: ["m-w2"], messages: ["walrus line"], chats: ["line"] },
  [A1]: { notes: ["n-a1"], files: [], media: ["m-a1"], messages: ["walrus tg one", "walrus tg two"], chats: ["telegram"] },
  windows: { notes: ["n-w1", "n-w2"], files: ["f-w1", "f-w2"], media: ["m-w1", "m-w2"], messages: ["walrus line", "walrus tg one"], chats: ["line", "telegram"] },
  android: { notes: ["n-a1"], files: [], media: ["m-a1"], messages: ["walrus tg one", "walrus tg two"], chats: ["telegram"] },
  all: { notes: ["n-a1", "n-w1", "n-w2"], files: ["f-w1", "f-w2"], media: ["m-a1", "m-w1", "m-w2"], messages: ["walrus line", "walrus tg one", "walrus tg two"], chats: ["line", "telegram"] },
};
const SCOPES = [W1, W2, A1, "windows", "android", "all"];
const dev = (s: string) => (s === "all" ? null : s);

describe("device scope on every read API", () => {
  it.each(SCOPES)("notifications, files and media under scope %s", async (s) => {
    const e = EXPECT[s]!;
    const ids = (j: { items: Array<{ id: string }> }) => sorted(j.items.map((i) => i.id));
    expect(ids(await get(`/api/notifications?${q(dev(s))}`))).toEqual(e.notes);
    expect(ids(await get(`/api/views/records?type=notification&${q(dev(s))}`))).toEqual(e.notes);
    const apps = (await get(`/api/notifications/apps?${q(dev(s))}`)).apps as Array<{ count: number }>;
    expect(apps.reduce((n, a) => n + a.count, 0)).toBe(e.notes.length);
    expect((await get(`/api/views/notification-apps?${q(dev(s))}`)).apps.reduce((n: number, a: { count: number }) => n + a.count, 0)).toBe(e.notes.length);
    expect(ids(await get(`/api/files?${q(dev(s))}`))).toEqual(e.files);
    expect(ids(await get(`/api/media?${q(dev(s))}`))).toEqual(e.media);
    expect(ids(await get(`/api/views/records?type=screenshot,photo&${q(dev(s))}`))).toEqual(e.media);
  });

  it.each(SCOPES)("messages (by provenance) and the chats list under scope %s", async (s) => {
    const e = EXPECT[s]!;
    expect(await messageTexts(dev(s))).toEqual(e.messages);
    const platforms = (j: { items: Array<{ platform: string }> }) => sorted(j.items.map((i) => i.platform));
    const chats = await get(`/api/views/chats?${q(dev(s))}`);
    expect(platforms(chats)).toEqual(e.chats);
    expect(chats.total).toBe(e.chats.length);
    expect(platforms(await get(`/api/conversations?${q(dev(s))}`))).toEqual(e.chats);
  });

  it.each(SCOPES)("the thread and profile of a conversation in scope %s are whole; one outside it is 404", async (s) => {
    const e = EXPECT[s]!;
    for (const [platform, id, count] of [["telegram", tgId, 2], ["line", lineId, 1]] as const) {
      const urls = [`/api/views/chats/${id}/messages?${q(dev(s))}`, `/api/conversations/${id}/messages?${q(dev(s))}`, `/api/views/chats/${id}/profile?${q(dev(s))}`];
      const rs = await Promise.all(urls.map((u) => api(svc, "GET", u)));
      if (!e.chats.includes(platform)) { for (const r of rs) expect(r.status).toBe(404); continue; }
      for (const r of rs) expect(r.status).toBe(200);
      // the conversation is one record: every message shows, with every source's label kept
      expect(rs[0]!.json.messages).toHaveLength(count);
      expect(rs[1]!.json.messages).toHaveLength(count);
      expect(rs[2]!.json.messages).toBe(count);
      if (platform === "telegram") {
        expect(sorted(rs[0]!.json.conversation.coverageSources.map((x: { source: string }) => x.source))).toEqual(["android:root-db", "windows:telegram-desktop"]);
        expect(sorted(rs[2]!.json.sources.map((x: { source: string }) => x.source))).toEqual(["android:root-db", "windows:telegram-desktop"]);
      }
    }
  });

  it.each(SCOPES)("search under scope %s matches only the scope's records", async (s) => {
    const e = EXPECT[s]!;
    const r = await get(`/api/search?q=walrus&typo=off&pageSize=50&${q(dev(s))}`);
    const want = e.notes.length + e.files.length + e.media.length + e.messages.length;
    expect(r.total).toBe(want);
    expect(sorted(r.items.filter((i: { type: string }) => i.type === "notification").map((i: { id: string }) => i.id))).toEqual(e.notes);
    expect(sorted(r.items.filter((i: { type: string }) => i.type === "file").map((i: { id: string }) => i.id))).toEqual(e.files);
    expect(sorted(r.items.filter((i: { type: string }) => i.type === "screenshot" || i.type === "photo").map((i: { id: string }) => i.id))).toEqual(e.media);
    expect(sorted(r.items.filter((i: { type: string }) => i.type === "message").map((i: { body: string }) => i.body))).toEqual(e.messages);
  });

  it("search paging under a scope: the filter runs before the page slice", async () => {
    for (const s of [W1, "windows", "all"]) {
      const all = await get(`/api/search?q=walrus&typo=off&pageSize=50&sort=oldest&${q(dev(s))}`);
      const seen: string[] = [];
      const pages = Math.ceil(all.total / 2);
      expect(pages).toBeGreaterThan(1);
      for (let page = 1; page <= pages + 1; page++) {
        const r = await get(`/api/search?q=walrus&typo=off&pageSize=2&sort=oldest&page=${page}&${q(dev(s))}`);
        expect(r.total).toBe(all.total);
        expect(r.pages).toBe(Math.ceil(all.total / 2));
        expect(r.items.length).toBe(page <= r.pages ? Math.min(2, all.total - (page - 1) * 2) : 0);
        seen.push(...r.items.map((i: { type: string; id: string }) => `${i.type}:${i.id}`));
      }
      expect(seen).toEqual(all.items.map((i: { type: string; id: string }) => `${i.type}:${i.id}`));
    }
  });

  it.each(SCOPES)("timeline and stats under scope %s", async (s) => {
    const e = EXPECT[s]!;
    const t = await get(`/api/timeline?date=${DAY}&tz=UTC&${q(dev(s))}`);
    expect(t.counts.notification ?? 0).toBe(e.notes.length);
    expect(t.counts.file ?? 0).toBe(e.files.length);
    expect((t.counts.screenshot ?? 0) + (t.counts.photo ?? 0)).toBe(e.media.length);
    expect(t.counts.message ?? 0).toBe(e.messages.length);
    const st = await get(`/api/stats?${q(dev(s))}`);
    expect(st.counts).toMatchObject({ notifications: e.notes.length, files: e.files.length, media: e.media.length, messages: e.messages.length });
  });

  it("coverage lists only the devices of the scope", async () => {
    const ids = async (s: string | null) => sorted((await get(`/api/coverage?${q(s)}`)).devices.map((d: { deviceId: string }) => d.deviceId));
    expect(await ids(null)).toEqual(sorted([W1, W2, A1]));
    expect(await ids(W2)).toEqual([W2]);
    expect(await ids("windows")).toEqual(sorted([W1, W2]));
    expect(await ids("android")).toEqual([A1]);
    expect(await ids("nope")).toEqual([]);
    const src = await get(`/api/views/sources?device=${W1}`);
    expect(src.sources.map((x: { source: string }) => x.source)).toEqual(["windows:telegram-desktop"]);
  });

  // last: forgets the Android device (its records stay in the vault, as after a revoke)
  it("a role with no paired device scopes to nothing, not to everything", async () => {
    db().prepare("DELETE FROM devices WHERE role = 'android'").run();
    const s = "android";
    expect((await get(`/api/notifications?${q(s)}`)).total).toBe(0);
    expect((await get(`/api/files?${q(s)}`)).total).toBe(0);
    expect((await get(`/api/media?${q(s)}`)).total).toBe(0);
    expect((await get(`/api/views/chats?${q(s)}`)).total).toBe(0);
    expect((await get(`/api/views/records?${q(s)}`)).total).toBe(0);
    expect((await get(`/api/search?q=walrus&typo=off&${q(s)}`)).total).toBe(0);
    expect((await get(`/api/timeline?date=${DAY}&tz=UTC&${q(s)}`)).total).toBe(0);
    expect((await get(`/api/stats?${q(s)}`)).counts).toEqual({ messages: 0, notifications: 0, media: 0, files: 0, usage: 0, calls: 0 });
    expect((await api(svc, "GET", `/api/views/chats/${tgId}/messages?${q(s)}`)).status).toBe(404);
    expect((await get(`/api/coverage?${q(s)}`)).devices).toEqual([]);
    // absent still means everything
    expect((await get("/api/notifications")).total).toBe(3);
    expect((await get("/api/search?q=walrus&typo=off")).total).toBe(11);
  });
});
