/**
 * Multi-source conversation capture (PRD WX1, C8, N3; PLAN task 1.10): copies of a message from the
 * Windows Telegram Desktop session, the Android database and Android notifications merge on
 * platform + account + convKey + msgId into one record listing every source.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { commitAndroidNotification, commitMessageBatch } from "../src/ingest/committers.ts";
import { migrate } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { coverageText, effectiveClaim } from "../src/query/sources.ts";

let svc: Service;
let dir: string;
const WIN = "dev-win", AND = "dev-and";
const SENT = "2026-10-09T10:00:00.000Z";
const db = () => svc.ctx.db;

type Msg = Record<string, unknown>;
function batch(deviceId: string, sourceSession: string, coverage: string, messages: Msg[], over: Record<string, unknown> = {}, captureTime = "2026-10-10T00:00:00.000Z") {
  return commitMessageBatch(db(), {
    v: 1, kind: "message_batch", deviceId, eventTime: SENT, captureTime,
    platform: "telegram", account: "@bunny", convKey: "-100123", peer: "Robotics lab", convKind: "group",
    sourceSession, coverage, cursor: "1", messages: messages.map((m) => ({ sender: "Aki", sentAt: SENT, sourceStatus: "live", attachments: [], ...m })),
    ...over,
  } as never);
}
const msgRow = (key = "7781") => db().prepare("SELECT * FROM messages WHERE msg_key = ?").get(key) as Record<string, unknown>;
const sourcesOf = (key = "7781") => (db().prepare(`SELECT s.source_session AS source, s.device_id AS deviceId, s.source_deleted_at AS deletedAt FROM message_sources s
                                                  JOIN messages m ON m.id = s.message_id WHERE m.msg_key = ? ORDER BY s.rid`).all(key)) as Array<{ source: string; deviceId: string; deletedAt: string | null }>;

beforeEach(async () => {
  dir = tempDir();
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
  db().prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'k', 'FPW', 't'), (?, 'android', 'k', 'FPA', 't')").run(WIN, AND);
});
afterEach(async () => { await svc.close(); rm(dir); });

describe("merge by platform message id (WX1, C8)", () => {
  it("the same message from the Windows session and then the Android database is one record with two sources", () => {
    batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "7781", text: "lab meeting moved to 3pm", forwardedFrom: "Robotics News", mediaKind: "photo" }],
      { chatMeta: { title: "Robotics lab", participantCount: 42, chatType: "supergroup" } });
    const r = batch(AND, "android:root-db", "partial", [{ msgId: "7781", text: "lab meeting moved to 3pm" }], {}, "2026-10-10T01:00:00.000Z");
    expect(r.summary).toMatchObject({ inserted: 0, edited: 0 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
    expect(sourcesOf()).toEqual([
      { source: "windows:telegram-desktop", deviceId: WIN, deletedAt: null },
      { source: "android:root-db", deviceId: AND, deletedAt: null },
    ]);
    expect(msgRow()).toMatchObject({ forwarded_from: "Robotics News", media_kind: "photo", text_source: "windows:telegram-desktop", text_quality: "full" });
    expect(db().prepare("SELECT COUNT(*) AS n FROM message_edits").get()).toEqual({ n: 0 });
    expect(db().prepare("SELECT chat_title, participant_count, chat_type FROM conversations").get()).toEqual({ chat_title: "Robotics lab", participant_count: 42, chat_type: "supergroup" });
  });

  it("a notification preview first, then the full copy: the text is upgraded, not recorded as an edit", () => {
    batch(AND, "android:notification", "notification_only", [{ msgId: "7781", text: "lab meeting moved to…" }]);
    expect(msgRow()).toMatchObject({ text: "lab meeting moved to…", text_quality: "preview" });
    const r = batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "7781", text: "lab meeting moved to 3pm, room B" }]);
    expect(r.summary).toMatchObject({ upgraded: 1, edited: 0 });
    expect(msgRow()).toMatchObject({ text: "lab meeting moved to 3pm, room B", text_quality: "full", text_source: "windows:telegram-desktop" });
    // a later preview never overwrites the full text
    batch(AND, "android:notification", "notification_only", [{ msgId: "7781", text: "lab meeting moved to…" }]);
    expect(msgRow()).toMatchObject({ text: "lab meeting moved to 3pm, room B", text_quality: "full" });
    expect(db().prepare("SELECT COUNT(*) AS n FROM message_edits").get()).toEqual({ n: 0 });
    expect(sourcesOf().map((s) => s.source)).toEqual(["android:notification", "windows:telegram-desktop"]);
  });

  it("an edit from a newer source is kept in message_edits; a stale copy does not revert it", () => {
    batch(AND, "android:root-db", "partial", [{ msgId: "7781", text: "see you at 2" }]);
    batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "7781", text: "see you at 3", editedAt: "2026-10-09T10:05:00.000Z" }]);
    batch(AND, "android:root-db", "partial", [{ msgId: "7781", text: "see you at 2" }]); // the phone's older snapshot
    expect(msgRow()).toMatchObject({ text: "see you at 3", edited_at: "2026-10-09T10:05:00.000Z" });
    expect(db().prepare("SELECT text FROM message_edits").all()).toEqual([{ text: "see you at 2" }]);
  });

  it("a deletion at one source does not delete: it marks deletedAtSource and the other source stays listed", () => {
    batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "7781", text: "oops" }]);
    batch(AND, "android:root-db", "partial", [{ msgId: "7781", text: "oops", sourceStatus: "deleted_at_source", deletedAtSource: "2026-10-09T11:00:00.000Z" }]);
    batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "7781", text: "oops" }]); // a source that still has it never revives nor removes it
    expect(msgRow()).toMatchObject({ text: "oops", source_status: "deleted_at_source", source_deleted_at: "2026-10-09T11:00:00.000Z", deleted_at: null });
    expect(sourcesOf()).toEqual([
      { source: "windows:telegram-desktop", deviceId: WIN, deletedAt: null },
      { source: "android:root-db", deviceId: AND, deletedAt: "2026-10-09T11:00:00.000Z" },
    ]);
    // without a deletedAtSource the deletion is dated by captureTime
    batch(AND, "android:root-db", "partial", [{ msgId: "7782", text: "gone", sourceStatus: "deleted_at_source" }], {}, "2026-10-10T02:00:00.000Z");
    expect(msgRow("7782")).toMatchObject({ source_status: "deleted_at_source", source_deleted_at: "2026-10-10T02:00:00.000Z" });
  });
});

describe("coverage per source (WX1, WL2, C9)", () => {
  it("reads 'complete via windows:telegram-desktop; partial via android:notification' and shows the best claim", async () => {
    batch(AND, "android:notification", "partial", [{ msgId: "7781", text: "hi" }]);
    expect(db().prepare("SELECT coverage FROM conversations").get()).toEqual({ coverage: "partial" });
    batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "7781", text: "hi" }]);
    const c = db().prepare("SELECT coverage, coverage_by_source FROM conversations").get() as { coverage: string; coverage_by_source: string };
    expect(c.coverage).toBe("complete");
    expect(coverageText(JSON.parse(c.coverage_by_source))).toBe("complete via windows:telegram-desktop; partial via android:notification");

    const list = await api(svc, "GET", "/api/conversations");
    expect(list.json.items[0]).toMatchObject({
      coverage: "complete",
      coverageBySource: { "windows:telegram-desktop": "complete", "android:notification": "partial" },
      coverageSources: [{ source: "windows:telegram-desktop", coverage: "complete" }, { source: "android:notification", coverage: "partial" }],
      coverageText: "complete via windows:telegram-desktop; partial via android:notification",
    });
    expect(list.json.items[0]).not.toHaveProperty("coverage_by_source");
    const thread = await api(svc, "GET", `/api/conversations/${list.json.items[0].id}/messages`);
    expect(thread.json.conversation).toMatchObject({ coverage: "complete", coverageText: "complete via windows:telegram-desktop; partial via android:notification" });
    expect(thread.json.messages[0].sources.map((s: { source: string }) => s.source)).toEqual(["android:notification", "windows:telegram-desktop"]);
    expect(thread.json.messages[0].sources[1]).toMatchObject({ deviceId: WIN, capturedAt: "2026-10-10T00:00:00.000Z" });
    const item = await api(svc, "GET", `/api/items/message/${thread.json.messages[0].id}`);
    expect(item.json.detail.sources).toEqual(["android:notification", "windows:telegram-desktop"]);
  });

  it("a notification source never counts above partial; LINE from Windows never above partial (WL2)", () => {
    expect(effectiveClaim("android:notification", "telegram", "complete")).toBe("partial");
    expect(effectiveClaim("windows:line-desktop", "line", "complete")).toBe("partial");
    expect(effectiveClaim("android:root-db", "line", "complete")).toBe("complete");
    expect(effectiveClaim("windows:telegram-desktop", "telegram", "complete")).toBe("complete");
    batch(WIN, "windows:line-desktop", "complete", [{ msgId: "1", text: "x" }], { platform: "line", account: "bunny", convKey: "c1" });
    expect(db().prepare("SELECT coverage, coverage_by_source FROM conversations WHERE platform = 'line'").get()).toEqual({ coverage: "partial", coverage_by_source: '{"windows:line-desktop":"partial"}' });
    batch(AND, "android:root-db", "complete", [{ msgId: "1", text: "x" }], { platform: "line", account: "bunny", convKey: "c1" });
    expect(db().prepare("SELECT coverage FROM conversations WHERE platform = 'line'").get()).toEqual({ coverage: "complete" });
  });

  it("each source's latest claim stands (a finished import upgrades its own claim)", () => {
    batch(WIN, "windows:telegram-desktop", "partial", [{ msgId: "1", text: "a" }]);
    batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "2", text: "b" }]);
    expect(db().prepare("SELECT coverage, coverage_by_source FROM conversations").get()).toEqual({ coverage: "complete", coverage_by_source: '{"windows:telegram-desktop":"complete"}' });
  });
});

describe("notification previews linked to archived messages (N3, C8)", () => {
  const notif = (preview: string, postedAt = "2026-10-09T10:00:20.000Z", sender = "Aki") => commitAndroidNotification(db(), {
    v: 1, kind: "android_notification", deviceId: AND, eventTime: postedAt, captureTime: "2026-10-09T10:00:21.000Z",
    app: "org.telegram.messenger", title: "Robotics lab", sender, preview, notifKey: `k-${preview}`, postedAt,
  } as never);

  it("a notification that arrives first is linked when the message is archived, adding a provenance row", () => {
    notif("lab meeting moved");
    batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "7781", text: "lab meeting moved to 3pm" }]);
    expect(db().prepare("SELECT linked_message_id, link_confidence FROM notifications").get()).toEqual({ linked_message_id: msgRow().id, link_confidence: "high" });
    expect(sourcesOf()).toEqual([
      { source: "windows:telegram-desktop", deviceId: WIN, deletedAt: null },
      { source: "android:notification", deviceId: AND, deletedAt: null },
    ]);
    const c = db().prepare("SELECT coverage, coverage_by_source FROM conversations").get() as { coverage: string; coverage_by_source: string };
    expect(c.coverage).toBe("complete");
    expect(JSON.parse(c.coverage_by_source)).toEqual({ "windows:telegram-desktop": "complete", "android:notification": "notification_only" });
  });

  it("a notification after the message links at once; an unmatched preview stays unlinked; ambiguous ones are labeled uncertain", () => {
    batch(WIN, "windows:telegram-desktop", "complete", [{ msgId: "1", text: "ok" }, { msgId: "2", text: "ok", sentAt: "2026-10-09T10:00:30.000Z" }]);
    const r = notif("ok");
    expect(r.summary).toMatchObject({ linkConfidence: "uncertain", linkedMessageId: msgRow("2").id }); // two candidates: the closer one, labeled uncertain
    const miss = notif("something else entirely");
    expect(miss.summary).not.toHaveProperty("linkedMessageId");
    const far = notif("ok", "2026-10-09T12:00:00.000Z");
    expect(far.summary).not.toHaveProperty("linkedMessageId");
  });
});

describe("migration v5 backfill", () => {
  it("attributes existing messages and conversation coverage to <role>:legacy; the platform id stays unique per conversation", () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const m of MIGRATIONS.filter((x) => x.version < 5)) { raw.exec(m.sql); raw.prepare("INSERT INTO schema_migrations VALUES (?, ?, 't')").run(m.version, m.name); }
    raw.exec(`INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES ('a1', 'android', 'k', 'f', 't');
              INSERT INTO conversations(id, device_id, platform, account, conv_key, kind, coverage, created_at, updated_at) VALUES ('c1', 'a1', 'line', 'me', 'k', 'dm', 'complete', 't', 't');
              INSERT INTO messages(id, conversation_id, device_id, msg_key, sender, sent_at, captured_at, text, source_status) VALUES ('m1', 'c1', 'a1', '1', 'Aki', 't', '2026-01-01T00:00:00.000Z', 'hi', 'deleted_at_source');`);
    expect(migrate(raw)).toEqual([5, 6]);
    expect(raw.prepare("SELECT coverage_by_source FROM conversations").get()).toEqual({ coverage_by_source: '{"android:legacy":"complete"}' });
    expect(raw.prepare("SELECT message_id, device_id, source_session FROM message_sources").all()).toEqual([{ message_id: "m1", device_id: "a1", source_session: "android:legacy" }]);
    expect(raw.prepare("SELECT text_source, text_quality, source_deleted_at FROM messages").get()).toEqual({ text_source: "android:legacy", text_quality: "full", source_deleted_at: "2026-01-01T00:00:00.000Z" });
    expect(() => raw.prepare("INSERT INTO messages(id, conversation_id, msg_key, sender, sent_at, captured_at, text) VALUES ('m2', 'c1', '1', 'x', 't', 't', 'dup')").run()).toThrow(/UNIQUE/);
    expect(() => raw.prepare("INSERT INTO message_sources(message_id, source_session, captured_at, last_seen_at) VALUES ('m1', 'android:legacy', 't', 't')").run()).toThrow(/UNIQUE/);
    raw.close();
  });
});
