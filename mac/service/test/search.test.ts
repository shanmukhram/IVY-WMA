import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitFileMeta, commitMessageBatch, commitWindowsNotification, commitUsage, commitCall } from "../src/ingest/committers.ts";
import { search, parseQuery, approxFind, matchExpr } from "../src/query/search.ts";
import { softDelete } from "../src/bin/recovery.ts";

let svc: Service;
let dir: string;
const WIN = "dev-win";
const AND = "dev-and";
const b = (deviceId: string, kind: string, t = "2026-09-24T10:00:00.000Z") => ({ v: 1 as const, kind, deviceId, eventTime: t, captureTime: "2026-10-10T00:00:00.000Z" });

beforeAll(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  const db = svc.ctx.db;
  db.prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'f', 't'), (?, 'android', 'k', 'f', 't')").run(WIN, AND);
  commitFileMeta(db, { ...b(WIN, "file_meta"), kind: "file_meta", path: "C:\\Docs\\Robotics Collaboration Offer.pdf", name: "Robotics Collaboration Offer.pdf", ext: "pdf", size: 10, mtime: "2026-09-23T09:00:00.000Z", quickHash: "a" });
  commitFileMeta(db, { ...b(WIN, "file_meta"), kind: "file_meta", path: "C:\\Docs\\holiday.jpg", name: "holiday.jpg", ext: "jpg", size: 10, mtime: "2026-09-23T09:00:00.000Z", quickHash: "b" });
  commitWindowsNotification(db, { ...b(WIN, "windows_notification"), kind: "windows_notification", app: "Teams", title: "Kenji", sender: "Kenji", text: "The robotics lab sent the collaboration contract", postedAt: "2026-09-24T11:00:00.000Z" });
  commitUsage(db, { ...b(WIN, "usage_event"), kind: "usage_event", app: "Chrome", title: "Collaboration portal - Chrome", startedAt: "2026-09-24T12:00:00.000Z", endedAt: "2026-09-24T12:10:00.000Z" });
  commitCall(db, { ...b(AND, "call"), kind: "call", direction: "incoming", contact: "Kenji Robotics", number: "+8190", startedAt: "2026-09-24T13:00:00.000Z", durationS: 30 });
  const msgs = Array.from({ length: 30 }, (_, i) => ({
    msgId: String(i), sender: i % 2 ? "Aki" : "bunny", sentAt: new Date(Date.parse("2026-09-24T14:00:00.000Z") + i * 60_000).toISOString(),
    text: i === 0 ? "Here is the robotics collaboration offer from Kyoto" : `pagination filler message number ${i} about widgets`,
    sourceStatus: "live" as const, attachments: [],
  }));
  commitMessageBatch(db, { ...b(AND, "message_batch"), kind: "message_batch", sourceSession: "android:root-db", platform: "line", account: "bunny", convKey: "c1", peer: "Aki", convKind: "dm", coverage: "complete", cursor: "30", messages: msgs });
  commitMessageBatch(db, { ...b(AND, "message_batch"), kind: "message_batch", sourceSession: "android:root-db", platform: "telegram", account: "bunny", convKey: "t1", peer: "Lab", convKind: "group", coverage: "partial", cursor: "1",
    messages: [{ msgId: "x", sender: "Lab", sentAt: "2026-09-25T09:00:00.000Z", text: "colaboration typo in the source text, robotics later", sourceStatus: "live", attachments: [] }] });
});
afterAll(async () => { await svc.close(); rm(dir); });

describe("query parsing", () => {
  it("splits phrases, terms, short terms and negatives", () => {
    expect(parseQuery('robot* "collaboration offer" -spam ab')).toEqual({ phrases: ["collaboration offer"], terms: ["robot"], short: ["ab"], negatives: ["spam"] });
    expect(matchExpr(parseQuery('robot "a b c" -spam'))).toBe('("a b c" AND "robot") NOT ("spam")');
  });

  it("approximate substring matching with transpositions", () => {
    expect(approxFind("colaboration", "the collaboration offer", 1)?.dist).toBe(1);
    expect(approxFind("robtoics", "robotics lab", 1)?.dist).toBe(1);
    expect(approxFind("xyzzyx", "robotics lab", 1)).toBeNull();
  });
});

describe("search (Q1-Q5)", () => {
  it("finds a word across every content type with a total and per-type counts", async () => {
    const r = await search(svc.ctx, { q: "collaboration", typo: false });
    expect(r.counts.file!.exact).toBe(1);
    expect(r.counts.notification!.exact).toBe(1);
    expect(r.counts.usage!.exact).toBe(1);
    expect(r.counts.message!.exact).toBe(1);
    expect(r.total).toBe(4);
    expect(new Set(r.groups.map((g) => g.type))).toEqual(new Set(["file", "notification", "usage", "message"]));
  });

  it("substring and prefix matching via the trigram index", async () => {
    const r = await search(svc.ctx, { q: "collab*", typo: false });
    expect(r.total).toBe(4);
    const r2 = await search(svc.ctx, { q: "otics", typo: false });
    expect(r2.exactTotal).toBeGreaterThanOrEqual(4);
  });

  it("exact phrase support with quotes", async () => {
    const r = await search(svc.ctx, { q: '"collaboration offer"', typo: false });
    expect(r.items.map((i) => i.type).sort()).toEqual(["file", "message"]);
    const none = await search(svc.ctx, { q: '"offer collaboration"', typo: false });
    expect(none.total).toBe(0);
  });

  it("returns FTS5 snippets with highlights, escaped for HTML", async () => {
    const r = await search(svc.ctx, { q: "Kyoto", typo: false });
    expect(r.items[0]!.snippetHtml).toContain("<mark>");
    expect(r.items[0]!.snippet).toContain("Kyoto");
    expect(r.items[0]!.detail).toMatchObject({ platform: "line", open: { conversationId: expect.any(String), messageId: r.items[0]!.id } });
  });

  it("typo tolerance: a misspelled query finds the right word, labelled fuzzy, after exact matches", async () => {
    const r = await search(svc.ctx, { q: "colaboration" });
    // the telegram message really contains "colaboration" (exact); the four "collaboration" items are typo matches
    expect(r.exactTotal).toBe(1);
    expect(r.fuzzyTotal).toBe(4);
    expect(r.items[0]!.match).toBe("exact");
    expect(r.items.slice(1).every((i) => i.match === "fuzzy" && i.typos === 1)).toBe(true);
    const t = await search(svc.ctx, { q: "robtoics" });
    expect(t.exactTotal).toBe(0);
    expect(t.fuzzyTotal).toBeGreaterThanOrEqual(5);
    expect(t.items[0]!.snippetHtml).toContain("<mark>");
  });

  it("filters by device (id or role), app, type, person and date range", async () => {
    expect((await search(svc.ctx, { q: "collaboration", device: WIN, typo: false })).total).toBe(3);
    expect((await search(svc.ctx, { q: "collaboration", device: "android", typo: false })).total).toBe(1);
    expect((await search(svc.ctx, { q: "collaboration", app: "teams", typo: false })).items.map((i) => i.type)).toEqual(["notification"]);
    expect((await search(svc.ctx, { q: "collaboration", types: ["file", "usage"], typo: false })).total).toBe(2);
    expect((await search(svc.ctx, { q: "robotics", person: "kenji", typo: false })).items.map((i) => i.type).sort()).toEqual(["call", "notification"]);
    const ranged = await search(svc.ctx, { q: "collaboration", from: "2026-09-24T11:30:00.000Z", to: "2026-09-25T00:00:00.000Z", typo: false });
    expect(ranged.items.map((i) => i.type).sort()).toEqual(["message", "usage"]);
  });

  it("paginates every match (never a sample) without duplicates", async () => {
    const seen = new Set<string>();
    const first = await search(svc.ctx, { q: "filler", pageSize: 10, sort: "oldest", typo: false });
    expect(first.total).toBe(29);
    expect(first.pages).toBe(3);
    for (let p = 1; p <= first.pages; p++) {
      const r = await search(svc.ctx, { q: "filler", pageSize: 10, page: p, sort: "oldest", typo: false });
      for (const it of r.items) seen.add(it.id);
    }
    expect(seen.size).toBe(29);
    const r3 = await search(svc.ctx, { q: "filler", pageSize: 10, page: 3, sort: "oldest", typo: false });
    expect(r3.items).toHaveLength(9);
  });

  it("exclusions and 1-2 character terms", async () => {
    expect((await search(svc.ctx, { q: "collaboration -portal", typo: false })).items.map((i) => i.type)).not.toContain("usage");
    const r = await search(svc.ctx, { q: "number 7", typo: false }); // "7" is a substring of 7, 17 and 27
    expect(r.total).toBe(3);
    expect((await search(svc.ctx, { q: '"number 7 "', typo: false })).total).toBe(1);
  });

  it("items in the recovery bin are not search results", async () => {
    const f = svc.ctx.db.prepare("SELECT id FROM files WHERE name LIKE 'holiday%'").get() as { id: string };
    expect((await search(svc.ctx, { q: "holiday", typo: false })).total).toBe(1);
    softDelete(svc.ctx, "file", f.id);
    expect((await search(svc.ctx, { q: "holiday", typo: false })).total).toBe(0);
  });

  it("is served at /api/search with query-string filters and a semantic placeholder", async () => {
    const r = await api(svc, "GET", "/api/search?q=collaboration&type=file,message&page=1&typo=off");
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(2);
    expect(r.json.semantic).toMatchObject({ enabled: false });
    expect((await api(svc, "GET", "/api/search?q=")).status).toBe(400);
    expect((await api(svc, "GET", "/api/search?q=x&type=bogus")).status).toBe(400);
  });
});
