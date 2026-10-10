/**
 * Pairing + ingest round trip against the S3 mock. The test plays a Windows
 * device using only @ivy/protocol and the scoped tokens from the pairing string.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { newOid, upKey, decodePairingString } from "@ivy/protocol";
import { fullStack, pairNew, PASS } from "./helpers/harness.ts";
import { SimDevice, PNG_1x1, iso } from "./helpers/device.ts";
import { startPairing } from "../src/pairing/pairing.ts";
import { oidTime } from "../src/ingest/ingester.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
type Stack = Awaited<ReturnType<typeof fullStack>>;

let st: Stack;
let dev: SimDevice;
let pairing: Awaited<ReturnType<typeof startPairing>>;
const db = () => st.svc.ctx.db;
const upKeys = () => st.s3.mock.listAll("ivy-up-windows").map((o) => o.key);
const cmdKeys = () => st.s3.mock.listAll("ivy-cmd-windows").map((o) => o.key);
const ledger = (key: string) => db().prepare("SELECT status, kind FROM sync_objects WHERE object_key = ?").get(key) as { status: string; kind: string } | undefined;
const events: string[] = [];

beforeAll(async () => {
  st = await fullStack();
  st.svc.ctx.events.on((e) => events.push(e.type));
});
afterAll(async () => { dev?.close(); await st.cleanup(); });

describe("pairing issuance (§7)", () => {
  it("issues a pairing string, fingerprint and 10-minute expiry, and writes the sealed bootstrap", async () => {
    pairing = await startPairing(st.svc.ctx, "windows");
    expect(pairing.pairingString.startsWith("IVYPAIR1.")).toBe(true);
    expect(pairing.macFingerprint).toBe(st.svc.ctx.keystore.macFingerprint());
    const p = decodePairingString(pairing.pairingString);
    expect(p.exp - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(p.exp - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(p.cmdReadToken).toBe(st.tokens.winCmd);
    expect(JSON.stringify(p)).not.toContain(st.tokens.winUp); // the write token only travels inside the sealed bootstrap
    expect(cmdKeys()).toContain(`pair/${pairing.pairingId}`);
    const raw = st.s3.mock.readRaw("ivy-cmd-windows", `pair/${pairing.pairingId}`).toString();
    expect(raw).not.toContain(st.tokens.winUp.split(":")[1]);
  });

  it("the device opens the bootstrap with only the cmd-read token; scopes are enforced", async () => {
    dev = new SimDevice(pairing.pairingString);
    await dev.pair();
    await expect(dev.up.list()).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    await expect(dev.cmd.put("cmd/forged", new Uint8Array(4))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  });

  it("consumes pair/<id>/device once: records the device and fingerprint, deletes the bootstrap", async () => {
    const r = await st.svc.ingester.poll();
    expect(r.buckets.find((b) => b.bucket === "ivy-up-windows")!.committed).toBe(1);
    const d = db().prepare("SELECT * FROM devices").all() as Array<{ id: string; role: string; fingerprint: string; public_key: string }>;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ id: dev.deviceId, role: "windows", fingerprint: dev.fingerprint });
    expect(db().prepare("SELECT status FROM pairings WHERE id = ?").get(pairing.pairingId)).toEqual({ status: "consumed" });
    expect(cmdKeys()).not.toContain(`pair/${pairing.pairingId}`);
    expect(upKeys()).toEqual([]);
    expect(events).toContain("pairing.completed");
  });

  it("refuses a second device object for the same pairing id", async () => {
    const intruder = new SimDevice(pairing.pairingString);
    intruder.up = dev.up; // a leaked up-write token
    const key = await intruder.putPairingRecord(pairing.pairingId);
    const r = await st.svc.ingester.poll();
    expect(r.buckets[0]!.quarantined).toBe(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n).toBe(1);
    expect(upKeys()).not.toContain(key);
    expect(db().prepare("SELECT reason FROM quarantine WHERE object_key = ?").get(key)).toBeTruthy();
  });

  it("lists devices with fingerprints over the API", async () => {
    const r = await st.svc.app.inject({ method: "GET", url: "/api/fingerprints", headers: { authorization: `Bearer ${st.svc.token}`, host: "127.0.0.1" } });
    expect(r.json()).toMatchObject({ mac: pairing.macFingerprint, devices: [{ deviceId: dev.deviceId, fingerprint: dev.fingerprint }] });
  });
});

describe("ingest of every Windows kind (S1-S5)", () => {
  const screenshotBytes = new Uint8Array([...PNG_1x1, ...randomBytes(700)]);
  let shotBlob: ReturnType<SimDevice["blob"]>;
  let thumbBlob: ReturnType<SimDevice["blob"]>;

  it("commits file_meta, screenshot (+ blob), usage_event, windows_notification, device_report and a thumbnail blob", async () => {
    thumbBlob = dev.blob(PNG_1x1, "thumbnail", 64);
    await dev.put("file_meta", { path: "C:\\Users\\bunny\\Documents\\invoice-sept.pdf", name: "invoice-sept.pdf", ext: "pdf", size: 1234, mtime: "2026-09-20T08:00:00.000Z", quickHash: "qh1", thumbBlobOid: thumbBlob.oid });
    await dev.putBlob(thumbBlob);
    shotBlob = dev.blob(screenshotBytes, "screenshot", 256);
    await dev.put("screenshot", { sourcePath: "C:\\Users\\bunny\\Pictures\\Screenshots\\Screenshot (1).png", width: 1, height: 1, sha256: sha(screenshotBytes), blobOid: shotBlob.oid, takenAt: "2026-10-09T10:00:00.000Z", savedAt: "2026-10-09T10:00:01.000Z" });
    await dev.putBlob(shotBlob);
    await dev.put("usage_event", { app: "Notepad", exe: "notepad.exe", title: "notes.txt - Notepad", startedAt: "2026-10-09T09:00:00.000Z", endedAt: "2026-10-09T09:05:00.000Z" });
    await dev.put("usage_event", { app: "KeePass", exe: "keepass.exe", title: null, startedAt: "2026-10-09T09:06:00.000Z", endedAt: "2026-10-09T09:07:00.000Z" });
    await dev.put("windows_notification", { app: "Microsoft.Teams", title: "Robotics lab", text: "Collaboration offer attached", sender: "Kenji", postedAt: "2026-10-09T11:00:00.000Z" });
    await dev.report([{ name: "files", lastRunAt: iso() }, { name: "usage", lastRunAt: iso() }, { name: "screenshots", lastRunAt: iso() }, { name: "notifications", lastRunAt: iso(), queueDepth: 2 }]);

    const r = await st.svc.ingester.poll();
    const b = r.buckets[0]!;
    expect(b.quarantined).toBe(0);
    expect(upKeys()).toEqual([]);
    const f = db().prepare("SELECT * FROM files").get() as Record<string, unknown>;
    expect(f).toMatchObject({ device_id: dev.deviceId, name: "invoice-sept.pdf", size: 1234, status: "reference", source_status: "live", thumb_blob_oid: thumbBlob.oid });
    expect(existsSync(f.thumb_path as string)).toBe(true);
    expect(String(f.thumb_path)).toContain("/thumbs/");
    const u = db().prepare("SELECT app, title, title_state FROM usage_events ORDER BY started_at").all();
    expect(u).toEqual([{ app: "Notepad", title: "notes.txt - Notepad", title_state: "captured" }, { app: "KeePass", title: null, title_state: "excluded" }]);
    expect(db().prepare("SELECT source, app, title, preview, sender, posted_at FROM notifications").get()).toEqual({
      source: "windows", app: "Microsoft.Teams", title: "Robotics lab", preview: "Collaboration offer attached", sender: "Kenji", posted_at: "2026-10-09T11:00:00.000Z",
    });
    const cs = db().prepare("SELECT name, enabled, queue_depth FROM collector_state ORDER BY name").all();
    expect(cs).toHaveLength(4);
    expect(db().prepare("SELECT last_report_at, last_seen, queue_depth_total FROM devices").get()).toMatchObject({ queue_depth_total: 2 });
  });

  it("reassembles the screenshot into data/media/<oid>.png byte-for-byte and keeps its times apart", async () => {
    const m = db().prepare("SELECT * FROM media").get() as Record<string, string>;
    expect(m.local_path).toMatch(new RegExp(`/media/${shotBlob.oid}\\.png$`));
    expect(sha(readFileSync(m.local_path))).toBe(sha(screenshotBytes));
    expect(m.taken_at).toBe("2026-10-09T10:00:00.000Z");
    expect(m.saved_at).toBe("2026-10-09T10:00:01.000Z");
    expect(m.captured_at).not.toBe(m.taken_at);
    await st.svc.idle();
    const t = db().prepare("SELECT thumb_path FROM media").get() as { thumb_path: string };
    expect(existsSync(t.thumb_path)).toBe(true);
    const blob = db().prepare("SELECT status, committed_parts, sha256 FROM blobs WHERE oid = ?").get(shotBlob.oid) as { status: string; committed_parts: string; sha256: string };
    expect(blob.status).toBe("complete");
    expect(JSON.parse(blob.committed_parts)).toEqual([...Array(Math.ceil(screenshotBytes.length / 256)).keys()]);
    expect(blob.sha256).toBe(sha(screenshotBytes));
  });

  it("a file_meta deletion keeps the record as deleted-at-source, never drops it", async () => {
    await dev.put("file_meta", { path: "C:\\Users\\bunny\\Documents\\invoice-sept.pdf", name: "invoice-sept.pdf", ext: "pdf", deleted: true });
    await st.svc.ingester.poll();
    const f = db().prepare("SELECT source_status, source_deleted_at, size, deleted_at FROM files").get() as Record<string, unknown>;
    expect(f).toMatchObject({ source_status: "deleted_at_source", size: 1234, deleted_at: null });
    expect(f.source_deleted_at).toBeTruthy();
  });

  it("an older file_meta arriving late does not overwrite newer state", async () => {
    await dev.put("file_meta", { path: "C:\\Users\\bunny\\Documents\\invoice-sept.pdf", name: "invoice-sept.pdf", ext: "pdf", size: 1, mtime: "2026-01-01T00:00:00.000Z", quickHash: "old" }, { eventTime: "2026-01-01T00:00:00.000Z" });
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT source_status, quick_hash FROM files").get()).toEqual({ source_status: "deleted_at_source", quick_hash: "qh1" });
  });

  it("advances the bucket marker to the highest committed oid", async () => {
    const marker = db().prepare("SELECT value FROM settings WHERE key = 'marker:ivy-up-windows'").get() as { value: string };
    const maxCommitted = (db().prepare("SELECT object_key FROM sync_objects WHERE status = 'committed' AND object_key LIKE 'up/%'").all() as Array<{ object_key: string }>)
      .map((r) => r.object_key.split("/")[2]!).sort().pop()!;
    expect(marker.value).toBe(maxCommitted);
    expect(oidTime(marker.value)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("an object uploaded late with an older oid is still listed (lookback) and committed", async () => {
    const oldOid = newOid(Date.now() - 3 * 86400_000); // 3 days older than the marker
    await dev.put("windows_notification", { app: "Outlook", title: "Late", text: "queued while offline", postedAt: iso(Date.now() - 3 * 86400_000) }, { oid: oldOid });
    const r = await st.svc.ingester.poll();
    expect(r.buckets[0]!.committed).toBe(1);
    expect(ledger(upKey("windows_notification", oldOid))).toMatchObject({ status: "committed" });
  });

  it("a replayed object (same bytes, same key) is ignored by the ledger and only deleted", async () => {
    const s = dev.seal("windows_notification", { app: "Slack", title: "Replay me", text: "once", postedAt: iso() });
    await dev.up.put(s.key, s.bytes);
    await st.svc.ingester.poll();
    const n0 = (db().prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n;
    await dev.up.put(s.key, s.bytes); // replay
    const r = await st.svc.ingester.poll();
    expect(r.buckets[0]!.replayed).toBe(1);
    expect(r.buckets[0]!.committed).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n).toBe(n0);
    expect(upKeys()).not.toContain(s.key);
  });

  it("different bytes under an already-committed key are quarantined (overwrite)", async () => {
    const s = dev.seal("windows_notification", { app: "Slack", title: "Original", text: "1", postedAt: iso() });
    await dev.up.put(s.key, s.bytes);
    await st.svc.ingester.poll();
    const forged = dev.seal("windows_notification", { app: "Slack", title: "Forged", text: "2", postedAt: iso() }, { oid: s.key.split("/")[2] });
    await dev.up.put(forged.key, forged.bytes);
    const r = await st.svc.ingester.poll();
    expect(r.buckets[0]!.quarantined).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = 'Forged'").get()).toEqual({ n: 0 });
    expect(ledger(s.key)).toMatchObject({ status: "committed" });
  });

  it("quarantines a garbage object, keeps its ciphertext, and does not stall the queue", async () => {
    const garbageKey = upKey("usage_event", newOid());
    await dev.up.put(garbageKey, new Uint8Array(randomBytes(300)));
    const okKey = await dev.put("usage_event", { app: "Chrome", startedAt: "2026-10-09T12:00:00.000Z", endedAt: "2026-10-09T12:01:00.000Z" });
    const r = await st.svc.ingester.poll();
    expect(r.buckets[0]!.quarantined).toBe(1);
    expect(ledger(okKey)).toMatchObject({ status: "committed" });
    const q = db().prepare("SELECT reason, stored_path FROM quarantine WHERE object_key = ?").get(garbageKey) as { reason: string; stored_path: string };
    expect(q.reason).toMatch(/undecryptable/);
    expect(existsSync(q.stored_path)).toBe(true);
    expect(upKeys()).toEqual([]);
    expect(events).toContain("ingest.quarantined");
  });

  it("quarantines unrecognised keys found by the full sweep", async () => {
    await dev.up.put("up/zzz/whatever", new Uint8Array([1, 2, 3]));
    await dev.up.put("random-junk", new Uint8Array([4]));
    const r = await st.svc.ingester.poll({ full: true });
    expect(r.buckets[0]!.quarantined).toBe(2);
    expect(upKeys()).toEqual([]);
  });

  it("quarantines a record whose device id is not paired", async () => {
    const realId = dev.deviceId;
    dev.deviceId = "11111111-2222-3333-4444-555555555555";
    const key = await dev.put("usage_event", { app: "Ghost", startedAt: iso(), endedAt: iso() });
    dev.deviceId = realId;
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT reason FROM quarantine WHERE object_key = ?").get(key)).toMatchObject({ reason: expect.stringMatching(/unknown or revoked device/) });
  });

  it("refuses Android-only kinds in the Windows bucket", async () => {
    const key = await dev.put("call", { direction: "incoming", number: "+81000", startedAt: iso(), durationS: 3 });
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT reason FROM quarantine WHERE object_key = ?").get(key)).toMatchObject({ reason: expect.stringMatching(/not accepted from a windows device/) });
  });

  it("locking mid-pass leaves objects in the bucket instead of quarantining them", async () => {
    const key = await dev.put("usage_event", { app: "WhileLocked", startedAt: iso(), endedAt: iso() });
    const bucket = st.svc.ctx.r2()!.bucket("up", "windows");
    st.svc.ctx.keystore.lock("test", { full: true });
    const r = await (st.svc.ingester as unknown as { pollBucket: (s: unknown, f: boolean) => Promise<{ quarantined: number; errors: number }> })
      .pollBucket({ bucket, bucketName: "ivy-up-windows", role: "windows" }, false);
    expect(r.quarantined).toBe(0);
    expect(r.errors).toBe(1);
    expect(upKeys()).toContain(key);
    expect((await st.svc.ingester.poll()).skipped).toBe("locked");
    await st.svc.ctx.keystore.unlock(PASS);
    await st.svc.ingester.poll();
    expect(ledger(key)).toMatchObject({ status: "committed" });
  });

  it("retries a quarantined object locally from its stored ciphertext", async () => {
    // a valid record that failed only because the device was unknown at the time
    const ghost = "99999999-2222-3333-4444-555555555555";
    const realId = dev.deviceId;
    dev.deviceId = ghost;
    const key = await dev.put("usage_event", { app: "Retry", startedAt: iso(), endedAt: iso() });
    dev.deviceId = realId;
    await st.svc.ingester.poll();
    const q = db().prepare("SELECT id FROM quarantine WHERE object_key = ?").get(key) as { id: string };
    db().prepare("INSERT INTO devices(id, role, public_key, fingerprint, paired_at) VALUES (?, 'windows', 'x', 'x', ?)").run(ghost, iso());
    const r = await st.svc.ingester.retryQuarantined(q.id);
    expect(r.outcome).toBe("committed");
    expect(db().prepare("SELECT app FROM usage_events WHERE device_id = ?").get(ghost)).toEqual({ app: "Retry" });
    db().prepare("DELETE FROM devices WHERE id = ?").run(ghost);
  });
});

describe("chunked blobs (S5)", () => {
  it("resumes a blob across two polls with a service restart in between", async () => {
    const data = new Uint8Array(randomBytes(1000));
    const b = dev.blob(data, "screenshot", 512); // 2 parts
    await dev.put("screenshot", { sourcePath: "C:\\shots\\two-polls.png", sha256: sha(data), blobOid: b.oid });
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    await st.svc.ingester.poll();
    let row = db().prepare("SELECT status, committed_parts FROM blobs WHERE oid = ?").get(b.oid) as { status: string; committed_parts: string };
    expect(row).toEqual({ status: "assembling", committed_parts: "[0]" });
    expect(upKeys()).toEqual([]); // manifest and part 0 already left the bucket

    await st.restart();
    await dev.up.put(b.parts[1]!.key, b.parts[1]!.bytes);
    await st.svc.ingester.poll();
    row = db().prepare("SELECT status, committed_parts FROM blobs WHERE oid = ?").get(b.oid) as { status: string; committed_parts: string };
    expect(row).toEqual({ status: "complete", committed_parts: "[0,1]" });
    const m = db().prepare("SELECT local_path FROM media WHERE blob_oid = ?").get(b.oid) as { local_path: string };
    expect(sha(readFileSync(m.local_path))).toBe(sha(data));
  });

  it("a part listed again after it was committed is only deleted", async () => {
    const data = new Uint8Array(randomBytes(600));
    const b = dev.blob(data, "screenshot", 512);
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    await st.svc.ingester.poll();
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes); // re-upload of a committed part
    const r = await st.svc.ingester.poll();
    expect(r.buckets[0]!.replayed).toBe(1);
    expect(upKeys()).toEqual([]);
  });

  it("parts without a manifest wait in the bucket", async () => {
    const b = dev.blob(new Uint8Array(randomBytes(300)), "screenshot", 256);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    const r = await st.svc.ingester.poll();
    expect(r.buckets[0]!.waiting).toBe(1);
    expect(upKeys()).toContain(b.parts[0]!.key);
    expect(db().prepare("SELECT status FROM blobs WHERE oid = ?").get(b.oid)).toEqual({ status: "awaiting_manifest" });
    // the manifest arrives: everything completes
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await dev.up.put(b.parts[1]!.key, b.parts[1]!.bytes);
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT status FROM blobs WHERE oid = ?").get(b.oid)).toEqual({ status: "complete" });
  });

  it("orphan parts are quarantined after 7 days", async () => {
    const b = dev.blob(new Uint8Array(randomBytes(300)), "screenshot", 256);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    await st.svc.ingester.poll();
    db().prepare("UPDATE blobs SET first_seen_at = ? WHERE oid = ?").run(new Date(Date.now() - 8 * 86400_000).toISOString(), b.oid);
    const r = await st.svc.ingester.poll();
    expect(r.buckets[0]!.quarantined).toBe(1);
    expect(db().prepare("SELECT status FROM blobs WHERE oid = ?").get(b.oid)).toEqual({ status: "quarantined" });
    expect(upKeys()).not.toContain(b.parts[0]!.key);
  });

  it("a tampered part quarantines the blob and the rest of the queue continues", async () => {
    const b = dev.blob(new Uint8Array(randomBytes(600)), "screenshot", 256);
    const bad = new Uint8Array(b.parts[1]!.bytes);
    bad[bad.length - 1]! ^= 0xff;
    await dev.up.put(b.manifest.key, b.manifest.bytes);
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    await dev.up.put(b.parts[1]!.key, bad);
    await dev.up.put(b.parts[2]!.key, b.parts[2]!.bytes);
    const okKey = await dev.put("usage_event", { app: "AfterTamper", startedAt: iso(), endedAt: iso() });
    await st.svc.ingester.poll();
    const row = db().prepare("SELECT status, detail FROM blobs WHERE oid = ?").get(b.oid) as { status: string; detail: string };
    expect(row.status).toBe("quarantined");
    expect(row.detail).toMatch(/hash mismatch/);
    expect(ledger(okKey)).toMatchObject({ status: "committed" });
    expect(upKeys()).toEqual([]);
    expect(existsSync(`${st.dataDir}/blobs/ivy-up-windows-${b.oid}.part`)).toBe(false);
  });

  it("a manifest that does not decrypt quarantines it with its parts", async () => {
    const b = dev.blob(new Uint8Array(randomBytes(300)), "screenshot", 256);
    const other = dev.blob(new Uint8Array(randomBytes(300)), "screenshot", 256);
    await dev.up.put(b.manifest.key, other.manifest.bytes); // relocated manifest: AAD binds the key
    await dev.up.put(b.parts[0]!.key, b.parts[0]!.bytes);
    await st.svc.ingester.poll();
    for (const k of [b.manifest.key, b.parts[0]!.key]) expect(db().prepare("SELECT COUNT(*) AS n FROM quarantine WHERE object_key = ?").get(k)).toEqual({ n: 1 });
    expect(upKeys()).toEqual([]);
  });
});

describe("pairing edge cases and Android kinds", () => {
  it("expires stale pairings and deletes their bootstrap", async () => {
    const p = await startPairing(st.svc.ctx, "android");
    db().prepare("UPDATE pairings SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600_000).toISOString(), p.pairingId);
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT status, bootstrap_deleted FROM pairings WHERE id = ?").get(p.pairingId)).toEqual({ status: "expired", bootstrap_deleted: 1 });
    expect(st.s3.mock.listAll("ivy-cmd-android").map((o) => o.key)).not.toContain(`pair/${p.pairingId}`);
  });

  it("a device answering after expiry is refused", async () => {
    const p = await startPairing(st.svc.ctx, "android");
    const late = new SimDevice(p.pairingString);
    await late.pair();
    db().prepare("UPDATE pairings SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600_000).toISOString(), p.pairingId);
    // keep it pending to exercise the ingest-side check (the sweep would expire it first)
    const r = await (st.svc.ingester as unknown as { pollBucket: (s: unknown, f: boolean) => Promise<{ quarantined: number }> })
      .pollBucket({ bucket: st.svc.ctx.r2()!.bucket("up", "android"), bucketName: "ivy-up-android", role: "android" }, false);
    expect(r.quarantined).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS n FROM devices WHERE id = ?").get(late.deviceId)).toEqual({ n: 0 });
    late.close();
  });

  it("commits Android notifications, calls and message batches (with edits and replies)", async () => {
    const phone = await pairNew(st.svc, "android");
    expect(db().prepare("SELECT role FROM devices WHERE id = ?").get(phone.deviceId)).toEqual({ role: "android" });
    await phone.put("android_notification", { app: "jp.naver.line.android", title: "Aki", sender: "Aki", preview: "see the robotics offer", notifKey: "k1", postedAt: "2026-09-24T14:00:00.000Z" });
    await phone.put("call", { direction: "missed", contact: "Aki", number: "+819000", startedAt: "2026-09-24T15:00:00.000Z", durationS: 0 });
    const batch = (text: string) => ({
      platform: "line", account: "bunny", convKey: "c-aki", peer: "Aki", convKind: "dm", coverage: "complete", cursor: "42",
      messages: [
        { msgId: "1", sender: "Aki", sentAt: "2026-09-24T14:00:00.000Z", text, sourceStatus: "live", attachments: [] },
        { msgId: "2", sender: "bunny", sentAt: "2026-09-24T14:01:00.000Z", text: "thanks!", replyTo: "1", sourceStatus: "live", attachments: [{ attId: "a1", kind: "image", filename: "offer.jpg", size: 10 }] },
      ],
    });
    await phone.put("message_batch", batch("robotics collaboration offer"));
    await st.svc.ingester.poll();
    await phone.put("message_batch", batch("robotics collaboration offer (edited)"));
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 2 });
    expect(db().prepare("SELECT text FROM messages WHERE msg_key = '1'").get()).toEqual({ text: "robotics collaboration offer (edited)" });
    expect(db().prepare("SELECT text FROM message_edits").get()).toEqual({ text: "robotics collaboration offer" });
    const reply = db().prepare("SELECT reply_to FROM messages WHERE msg_key = '2'").get() as { reply_to: string };
    expect(reply.reply_to).toBe((db().prepare("SELECT id FROM messages WHERE msg_key = '1'").get() as { id: string }).id);
    expect(db().prepare("SELECT status FROM attachments").get()).toEqual({ status: "on_demand" });
    expect(db().prepare("SELECT source, preview FROM notifications WHERE source = 'android'").get()).toEqual({ source: "android", preview: "see the robotics offer" });
    expect(db().prepare("SELECT direction, number FROM calls").get()).toEqual({ direction: "missed", number: "+819000" });
    phone.close();
  });

  it("revoking a device quarantines its later uploads and keeps its content", async () => {
    const r = await st.svc.app.inject({ method: "DELETE", url: `/api/devices/${dev.deviceId}`, headers: { authorization: `Bearer ${st.svc.token}`, host: "127.0.0.1" } });
    expect(r.json()).toMatchObject({ revoked: true });
    const key = await dev.put("usage_event", { app: "AfterRevoke", startedAt: iso(), endedAt: iso() });
    await st.svc.ingester.poll();
    expect(db().prepare("SELECT reason FROM quarantine WHERE object_key = ?").get(key)).toMatchObject({ reason: expect.stringMatching(/unknown or revoked/) });
    expect((db().prepare("SELECT COUNT(*) AS n FROM files WHERE device_id = ?").get(dev.deviceId) as { n: number }).n).toBe(1);
    expect(st.svc.ctx.events.recent({ types: ["device.revoked"] })).toHaveLength(1);
  });
});
