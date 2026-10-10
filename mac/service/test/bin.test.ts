import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { SimDevice, PNG_1x1, iso } from "./helpers/device.ts";
import { softDelete, restore, purge, sweep, listBin, setRetentionDays } from "../src/bin/recovery.ts";
import { search } from "../src/query/search.ts";

let st: Awaited<ReturnType<typeof fullStack>>;
let dev: SimDevice;
const db = () => st.svc.ctx.db;
const fts = (table: string, q: string) => (db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(q) as { n: number }).n;

beforeAll(async () => {
  st = await fullStack();
  dev = await pairNew(st.svc, "windows");
});
afterAll(async () => { dev.close(); await st.cleanup(); });

describe("recovery bin (B1-B4)", () => {
  it("soft delete hides an item from search; restore brings it back", async () => {
    await dev.put("windows_notification", { app: "Mail", title: "Flamingo", text: "pink", postedAt: iso() });
    await st.svc.ingester.poll();
    const id = (db().prepare("SELECT id FROM notifications WHERE title = 'Flamingo'").get() as { id: string }).id;
    softDelete(st.svc.ctx, "notification", id);
    expect((await search(st.svc.ctx, { q: "flamingo" })).total).toBe(0);
    expect(listBin(st.svc.ctx).items.map((i) => i.id)).toContain(id);
    expect(listBin(st.svc.ctx).items[0]!.purgeAt).toBeTruthy();
    restore(st.svc.ctx, "notification", id);
    expect((await search(st.svc.ctx, { q: "flamingo" })).total).toBe(1);
  });

  it("vault deletion and deletion at the source are different things (B4)", async () => {
    await dev.put("file_meta", { path: "C:\\b4.txt", name: "b4.txt", ext: "txt", size: 1, mtime: iso(), quickHash: "q" });
    await st.svc.ingester.poll();
    await dev.put("file_meta", { path: "C:\\b4.txt", name: "b4.txt", ext: "txt", deleted: true });
    await st.svc.ingester.poll();
    const f = db().prepare("SELECT id, source_status, deleted_at FROM files WHERE name = 'b4.txt'").get() as { id: string; source_status: string; deleted_at: string | null };
    expect(f).toMatchObject({ source_status: "deleted_at_source", deleted_at: null });
    softDelete(st.svc.ctx, "file", f.id);
    restore(st.svc.ctx, "file", f.id);
    expect(db().prepare("SELECT source_status, deleted_at FROM files WHERE id = ?").get(f.id)).toEqual({ source_status: "deleted_at_source", deleted_at: null });
  });

  it("deleting a conversation takes its messages along and restore returns exactly those", () => {
    const d = db();
    d.prepare("INSERT INTO conversations(id, platform, account, conv_key, kind, coverage, created_at, updated_at) VALUES ('cv','line','me','k','dm','complete','t','t')").run();
    d.prepare("INSERT INTO messages(id, conversation_id, msg_key, sender, sent_at, captured_at, text) VALUES ('m1','cv','1','a','t','t','one'), ('m2','cv','2','a','t','t','two')").run();
    softDelete(st.svc.ctx, "message", "m1"); // deleted earlier on its own
    softDelete(st.svc.ctx, "conversation", "cv");
    expect(d.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 'cv' AND deleted_at IS NOT NULL").get()).toEqual({ n: 2 });
    restore(st.svc.ctx, "conversation", "cv");
    expect(d.prepare("SELECT id FROM messages WHERE conversation_id = 'cv' AND deleted_at IS NULL").all()).toEqual([{ id: "m2" }]);
  });

  it("permanent delete is only offered for items in the bin", () => {
    db().prepare("INSERT INTO calls(id, device_id, direction, number, started_at, duration_s, captured_at) VALUES ('c1', 'd', 'incoming', '+1', 't', 1, 't')").run();
    expect(() => purge(st.svc.ctx, "call", "c1")).toThrow(/recovery bin first/);
  });

  it("permanent delete removes the row, extracted text, FTS entries, the original, the thumbnail and the blob", async () => {
    const img = new Uint8Array([...PNG_1x1, ...randomBytes(500)]);
    const b = dev.blob(img, "screenshot", 256);
    await dev.put("screenshot", { sourcePath: "C:\\shots\\zebra-offer.png", sha256: "x", blobOid: b.oid });
    await dev.putBlob(b);
    await st.svc.ingester.poll();
    await st.svc.idle();
    db().prepare("UPDATE media SET ocr_text = 'quokka contract text' WHERE blob_oid = ?").run(b.oid);
    const m = db().prepare("SELECT id, local_path, thumb_path FROM media WHERE blob_oid = ?").get(b.oid) as { id: string; local_path: string; thumb_path: string };
    expect(existsSync(m.local_path) && existsSync(m.thumb_path)).toBe(true);
    expect(fts("media_fts", '"quokka"')).toBe(1);
    expect(fts("media_fts", '"zebra"')).toBe(1);

    softDelete(st.svc.ctx, "screenshot", m.id);
    const r = await api(st.svc, "DELETE", `/api/bin/screenshot/${m.id}`);
    expect(r.status).toBe(200);
    expect(r.json.removedFiles).toBe(2);
    expect(db().prepare("SELECT COUNT(*) AS n FROM media WHERE id = ?").get(m.id)).toEqual({ n: 0 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM blobs WHERE oid = ?").get(b.oid)).toEqual({ n: 0 });
    expect(fts("media_fts", '"quokka"')).toBe(0);
    expect(fts("media_fts", '"zebra"')).toBe(0);
    expect(db().prepare("INSERT INTO media_fts(media_fts, rank) VALUES ('integrity-check', 1)").run()).toBeTruthy();
    expect(existsSync(m.local_path)).toBe(false);
    expect(existsSync(m.thumb_path)).toBe(false);
    expect(st.svc.ctx.events.recent({ limit: 1000 }).some((e) => JSON.stringify(e.data).includes(m.id))).toBe(false);
    expect((await search(st.svc.ctx, { q: "quokka" })).total).toBe(0);
  });

  it("permanent delete of a cached file removes its local copy and thumbnail", async () => {
    const thumb = dev.blob(PNG_1x1, "thumbnail", 64);
    await dev.put("file_meta", { path: "C:\\docs\\secret-plan.pdf", name: "secret-plan.pdf", ext: "pdf", size: 3, mtime: iso(), quickHash: "s", thumbBlobOid: thumb.oid });
    await dev.putBlob(thumb);
    await st.svc.ingester.poll();
    const fileId = (db().prepare("SELECT id FROM files WHERE name = 'secret-plan.pdf'").get() as { id: string }).id;
    const req = await api(st.svc, "POST", `/api/files/${fileId}/request`, {});
    const orig = dev.blob(new TextEncoder().encode("abc"), "file_original", 64);
    await dev.putBlob(orig);
    await dev.put("command_status", { commandId: req.json.command.id, status: "uploaded", resultOid: orig.oid, reportedAt: iso() });
    await st.svc.ingester.poll();
    const f = db().prepare("SELECT local_path, thumb_path, status FROM files WHERE id = ?").get(fileId) as { local_path: string; thumb_path: string; status: string };
    expect(f.status).toBe("cached");
    softDelete(st.svc.ctx, "file", fileId);
    purge(st.svc.ctx, "file", fileId);
    expect(existsSync(f.local_path)).toBe(false);
    expect(existsSync(f.thumb_path)).toBe(false);
    expect(fts("files_fts", '"secret-plan"')).toBe(0);
    expect(JSON.stringify(db().prepare("SELECT params FROM commands WHERE id = ?").get(req.json.command.id))).not.toContain("secret-plan");
  });

  it("the retention sweep permanently deletes items older than the retention period", () => {
    setRetentionDays(st.svc.ctx, 7);
    db().prepare("INSERT INTO usage_events(id, device_id, app, title, title_state, started_at, ended_at, captured_at, deleted_at) VALUES ('old', 'd', 'A', 'walrus', 'captured', 't1', 't', 't', ?), ('new', 'd', 'A', 'narwhal', 'captured', 't2', 't', 't', ?)")
      .run(new Date(Date.now() - 8 * 86400_000).toISOString(), new Date().toISOString());
    expect(sweep(st.svc.ctx).purged).toBe(1);
    expect(db().prepare("SELECT id FROM usage_events WHERE id IN ('old','new')").all()).toEqual([{ id: "new" }]);
    expect(fts("usage_events_fts", '"walrus"')).toBe(0);
  });

  it("bin API: list, settings, restore and bad types", async () => {
    expect((await api(st.svc, "PUT", "/api/bin/settings", { retentionDays: 45 })).json).toEqual({ retentionDays: 45 });
    expect((await api(st.svc, "PUT", "/api/bin/settings", { retentionDays: 0 })).status).toBe(409);
    expect((await api(st.svc, "DELETE", "/api/items/bogus/x")).status).toBe(400);
    expect((await api(st.svc, "DELETE", "/api/items/call/nope")).status).toBe(404);
    expect((await api(st.svc, "DELETE", "/api/items/call/c1")).status).toBe(200);
    expect((await api(st.svc, "GET", "/api/bin")).json.items.map((i: { id: string }) => i.id)).toContain("c1");
    expect((await api(st.svc, "POST", "/api/bin/call/c1/restore")).json).toEqual({ restored: true });
  });
});
