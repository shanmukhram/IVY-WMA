/**
 * Media originals persist in R2 (PLAN decision 6): a completed photo, document, attachment or media
 * original is kept in its up-bucket instead of being deleted after commit, recorded in media_archive,
 * and re-fetchable at full quality on demand. Thumbnails and avatars stay cached small and are deleted
 * from R2 as before. With keepMediaInR2 = false the original is deleted after commit, as it used to be.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fullStack, pairNew, api } from "./helpers/harness.ts";
import { PNG_1x1, iso, type SimDevice } from "./helpers/device.ts";
import { setSetting } from "../src/db/index.ts";

type Stack = Awaited<ReturnType<typeof fullStack>>;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let st: Stack | undefined;
afterEach(async () => { await st?.cleanup(); st = undefined; });

const db = () => st!.svc.ctx.db;
const upKeys = () => st!.s3.mock.listAll("ivy-up-windows").map((o) => o.key);

/** A photo payload that starts with the PNG magic (so it is sniffed as a png) and spans several parts. */
const photoBytes = new Uint8Array([...PNG_1x1, ...randomBytes(600)]);

async function meta(dev: SimDevice, path: string, size: number, quickHash: string, originalBlobOid: string) {
  const name = path.split("\\").pop()!;
  await dev.put("file_meta", { path, name, ext: name.split(".").pop()!, size, mtime: iso(), quickHash, originalBlobOid });
}

/** Ingest one photo original (record first, then blob) and return its oid and media id. */
async function ingestPhoto(s: Stack, dev: SimDevice) {
  const blob = dev.blob(photoBytes, "photo", 256);
  await meta(dev, "C:\\Users\\bunny\\Pictures\\reef.png", photoBytes.length, "qh-reef", blob.oid);
  await dev.putBlob(blob);
  await s.svc.ingester.poll();
  await s.svc.idle();
  const m = db().prepare("SELECT id, local_path, thumb_path FROM media WHERE blob_oid = ?").get(blob.oid) as { id: string; local_path: string; thumb_path: string | null };
  return { blob, mediaId: m.id, media: m };
}

describe("media originals kept in R2 (PLAN decision 6)", () => {
  it("archives a photo original: manifest + parts stay in R2, a media_archive row exists, the thumbnail is cached", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    const { blob, media } = await ingestPhoto(st, dev);

    // the blob is committed and placed, but its objects were NOT deleted from R2
    expect(db().prepare("SELECT status FROM blobs WHERE oid = ?").get(blob.oid)).toEqual({ status: "complete" });
    const keys = upKeys();
    expect(keys).toContain(blob.manifest.key);
    for (const p of blob.parts) expect(keys).toContain(p.key);
    expect(blob.parts.length).toBeGreaterThan(1);

    // the archive record names the keys that hold it and the full-size plaintext hash
    const arch = db().prepare("SELECT * FROM media_archive WHERE oid = ?").get(blob.oid) as Record<string, any>;
    expect(arch).toMatchObject({ oid: blob.oid, bucket: "ivy-up-windows", payload_kind: "photo", content_type: "image/png", cache_evicted: 0 });
    expect(arch.manifest_key).toBe(blob.manifest.key);
    expect(JSON.parse(arch.part_keys)).toEqual(blob.parts.map((p) => p.key));
    expect(arch.plaintext_sha256).toBe(sha(photoBytes));
    expect(arch.total_size).toBe(photoBytes.length);
    expect(arch.cached_local_path).toBe(media.local_path);

    // the full original is in the local cache byte-for-byte, and its thumbnail is cached too
    expect(sha(readFileSync(media.local_path))).toBe(sha(photoBytes));
    expect(media.thumb_path && existsSync(media.thumb_path)).toBe(true);

    // the status view reports the archive size
    const status = (await api(st.svc, "GET", "/api/ingest/status")).json;
    expect(status.mediaArchive).toMatchObject({ count: 1, bytes: photoBytes.length, keepMediaInR2: true });
    dev.close();
  });

  it("the ledger skips an archived blob on a second poll: no re-assembly, no deletion, no duplicate rows", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    const { blob } = await ingestPhoto(st, dev);
    const before = upKeys().filter((k) => k.startsWith(`up/blob/${blob.oid}/`)).sort();

    const r = await st.svc.ingester.poll({ full: true }); // a full listing lists the archived keys again
    const bucket = r.buckets.find((b) => b.bucket === "ivy-up-windows")!;
    expect(bucket.quarantined).toBe(0);
    expect(bucket.committed).toBe(0); // recognised as committed and skipped before any fetch
    expect(upKeys().filter((k) => k.startsWith(`up/blob/${blob.oid}/`)).sort()).toEqual(before);
    expect((db().prepare("SELECT COUNT(*) AS n FROM blobs WHERE oid = ?").get(blob.oid) as { n: number }).n).toBe(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM media WHERE blob_oid = ?").get(blob.oid) as { n: number }).n).toBe(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM media_archive WHERE oid = ?").get(blob.oid) as { n: number }).n).toBe(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM quarantine").get() as { n: number }).n).toBe(0);
    dev.close();
  });

  it("re-fetches a full original from R2 after the local cache is cleared, and the content endpoint serves it", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    const { blob, mediaId, media } = await ingestPhoto(st, dev);

    // drop the local copy (as an eviction or a lost cache would); the object stays in R2
    rmSync(media.local_path);
    expect(existsSync(media.local_path)).toBe(false);
    expect((await api(st.svc, "GET", `/api/media/${mediaId}/content`)).status).toBe(404);

    const fetched = await api(st.svc, "POST", `/api/media/${mediaId}/fetch`);
    expect(fetched.status).toBe(200);
    expect(fetched.json).toMatchObject({ cached: true, source: "r2" });

    const back = db().prepare("SELECT local_path FROM media WHERE id = ?").get(mediaId) as { local_path: string };
    expect(existsSync(back.local_path)).toBe(true);
    expect(sha(readFileSync(back.local_path))).toBe(sha(photoBytes)); // verified against the manifest on the way in

    const content = await api(st.svc, "GET", `/api/media/${mediaId}/content`);
    expect(content.status).toBe(200);
    expect(content.headers["content-type"]).toBe("image/png");
    expect(Number(content.headers["content-length"])).toBe(photoBytes.length);
    expect(blob.oid).toBeTruthy();
    dev.close();
  });

  it("evicts a local original to free disk while keeping it in R2, then re-fetches on demand", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    const { mediaId, media } = await ingestPhoto(st, dev);

    const ev = await api(st.svc, "POST", `/api/media/${mediaId}/evict`);
    expect(ev.status).toBe(200);
    expect(ev.json).toMatchObject({ evicted: true });
    expect(existsSync(media.local_path)).toBe(false);
    expect(db().prepare("SELECT cache_evicted FROM media_archive WHERE oid = (SELECT blob_oid FROM media WHERE id = ?)").get(mediaId)).toEqual({ cache_evicted: 1 });

    const fetched = await api(st.svc, "POST", `/api/media/${mediaId}/fetch`);
    expect(fetched.json).toMatchObject({ cached: true, source: "r2" });
    const back = db().prepare("SELECT local_path FROM media WHERE id = ?").get(mediaId) as { local_path: string };
    expect(sha(readFileSync(back.local_path))).toBe(sha(photoBytes));
    dev.close();
  });

  it("still deletes a thumbnail and an avatar from R2 after commit (they are not archived)", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    const thumb = dev.blob(PNG_1x1, "thumbnail", 64);
    const avatar = dev.blob(PNG_1x1, "avatar", 64);
    const att = dev.blob(PNG_1x1, "attachment", 64);
    await dev.put("file_meta", { path: "C:\\docs\\report.pdf", name: "report.pdf", ext: "pdf", size: 1234, mtime: iso(), quickHash: "qh1", thumbBlobOid: thumb.oid });
    await dev.putBlob(thumb);
    await dev.putBlob(avatar);
    await dev.putBlob(att);
    await dev.put("message_batch", {
      platform: "telegram", account: "42", convKey: "-100", peer: "Lab", convKind: "group",
      sourceSession: "windows:telegram-desktop", coverage: "complete", cursor: "1",
      chatMeta: { title: "Lab", avatarBlobOid: avatar.oid },
      messages: [{ msgId: "1", sender: "7", sentAt: iso(), sourceStatus: "live", text: "hi",
        attachments: [{ attId: "a1", kind: "image", filename: "pic.png", size: PNG_1x1.length, blobOid: att.oid }] }],
    });
    await st.svc.ingester.poll();
    await st.svc.idle();

    const keys = upKeys();
    expect(keys.filter((k) => k.startsWith(`up/blob/${thumb.oid}/`))).toEqual([]);   // thumbnail deleted
    expect(keys.filter((k) => k.startsWith(`up/blob/${avatar.oid}/`))).toEqual([]);  // avatar deleted
    expect(keys).toContain(att.manifest.key);                                        // attachment kept (archived)
    const archived = db().prepare("SELECT oid FROM media_archive ORDER BY oid").all() as Array<{ oid: string }>;
    expect(archived.map((a) => a.oid)).toEqual([att.oid]);
    dev.close();
  });

  it("with keepMediaInR2 = false, the original is deleted after commit as before (no archive row)", async () => {
    st = await fullStack();
    const dev = await pairNew(st.svc, "windows");
    setSetting(db(), "ingest.keepMediaInR2", "false");

    const { blob, media } = await ingestPhoto(st, dev);
    expect(upKeys().filter((k) => k.startsWith(`up/blob/${blob.oid}/`))).toEqual([]); // deleted after commit
    expect(db().prepare("SELECT COUNT(*) AS n FROM media_archive").get()).toEqual({ n: 0 });
    expect(sha(readFileSync(media.local_path))).toBe(sha(photoBytes)); // the local copy and thumbnail still cache as now

    const status = (await api(st.svc, "GET", "/api/ingest/status")).json;
    expect(status.mediaArchive).toMatchObject({ count: 0, keepMediaInR2: false });
    dev.close();
  });

  it("toggles keepMediaInR2 over the API", async () => {
    st = await fullStack();
    await pairNew(st.svc, "windows");
    expect((await api(st.svc, "PUT", "/api/ingest/settings", { keepMediaInR2: false })).json).toMatchObject({ keepMediaInR2: false });
    expect((await api(st.svc, "GET", "/api/ingest/status")).json.mediaArchive.keepMediaInR2).toBe(false);
    expect((await api(st.svc, "PUT", "/api/ingest/settings", { keepMediaInR2: true })).json).toMatchObject({ keepMediaInR2: true });
  });
});
