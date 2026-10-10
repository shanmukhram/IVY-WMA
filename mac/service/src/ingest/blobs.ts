/**
 * Chunked-object assembly (PROTOCOL §2.2, PRD S5) with bounded memory.
 *
 * - The manifest arrives first; its ENVELOPE (ciphertext) is stored in `blobs`
 *   and decrypted again when needed, so the content key never sits in the
 *   database in the clear.
 * - Each part is verified on its own (length, SHA-256 from the manifest, header
 *   index/total/object id, AES-GCM with the per-index nonce and AAD) and its
 *   plaintext is written at offset index*chunkSize into data/blobs/<oid>.part.
 *   Only one part is ever in memory. `committed_parts` records progress in the
 *   same transaction as the part's ledger row, so a restart resumes where it
 *   stopped and an already-committed part that is listed again is only deleted.
 * - When every part is in, the file is checked (size, streaming SHA-256), moved
 *   to its home (media/, thumbs/, files/, attachments/) and linked to the rows
 *   that reference it.
 * - Hash or auth failure quarantines the part and the blob; parts with no
 *   manifest are left in R2 and quarantined after 7 days (orphans).
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  aesGcmDecrypt, blobChunkKey, blobManifestKey, chunkNonce, concatBytes, decryptEnvelope, fromBase64, fromCrockford,
  fromUtf8, kindId, parseChunkHeader, timingSafeEqual, toHex, u32be, utf8, validateManifest,
} from "@ivy/protocol";
import { PAYLOAD_KINDS } from "@ivy/protocol";
import type { ManifestRecordT } from "@ivy/protocol";
import type { Ctx } from "../context.ts";
import { dirs } from "../config.ts";
import { getSetting } from "../db/index.ts";
import { ensureDir, sha256File, sha256Hex, removeQuietly } from "../util/fsx.ts";
import { nowIso } from "../util/time.ts";
import { baseName, extOf, sniffFile, IMAGE_EXTS } from "../util/ext.ts";

const CHUNK_HEADER_LEN = 32;
const GCM_TAG_LEN = 16;
const KNOWN_PAYLOAD_KINDS = new Set<string>(PAYLOAD_KINDS);

export interface BlobRow {
  rid: number; oid: string; bucket: string; role: string; device_id: string | null;
  status: "awaiting_manifest" | "assembling" | "complete" | "quarantined";
  payload_kind: string | null; total_size: number | null; chunk_size: number | null; total_chunks: number | null;
  manifest_env: Buffer | null; committed_parts: string; committed_bytes: number; tmp_path: string | null;
  local_path: string | null; ext: string | null; sha256: string | null; first_seen_at: string; updated_at: string;
  completed_at: string | null; detail: string | null; command_id: string | null;
}

/** PROTOCOL §2.2 AAD_chunk(i) = "ivy/v1/chunk" || 0x00 || object_id || u32be(i) || u32be(total) || kind_id(blob_chunk) */
function chunkAad(objectId: Uint8Array, index: number, total: number): Uint8Array {
  return concatBytes(utf8("ivy/v1/chunk"), new Uint8Array([0]), objectId, u32be(index), u32be(total), new Uint8Array([kindId("blob_chunk")]));
}

export function getBlob(ctx: Ctx, bucket: string, oid: string): BlobRow | undefined {
  return ctx.db.prepare("SELECT * FROM blobs WHERE bucket = ? AND oid = ?").get(bucket, oid) as BlobRow | undefined;
}

export function committedSet(row: BlobRow): Set<number> {
  return new Set(JSON.parse(row.committed_parts) as number[]);
}

// ------------------------------------------------------------------ media originals kept in R2 (PLAN decision 6)

/**
 * Payload kinds whose reassembled original is kept in its up-bucket after commit, so the Mac can
 * fetch it again at full quality on demand. Thumbnails and avatars stay cached small and are
 * deleted from R2 as before; screenshots and file_request results are also deleted as before.
 */
export const ARCHIVE_PAYLOAD_KINDS = new Set<string>(["photo", "document", "attachment", "media"]);

export interface MediaArchiveRow {
  oid: string; bucket: string; manifest_key: string; part_keys: string; payload_kind: string;
  plaintext_sha256: string | null; total_size: number | null; filename: string | null; content_type: string | null;
  device_id: string | null; cached_local_path: string | null; cache_evicted: number; archived_at: string;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  heic: "image/heic", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff", mp4: "video/mp4",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function contentTypeOf(ext?: string | null): string {
  return (ext && CONTENT_TYPES[ext.toLowerCase()]) || "application/octet-stream";
}

/** Keep media originals in R2 (default true). When false, originals are deleted after commit as before. */
export function keepMediaInR2(ctx: Ctx): boolean {
  return getSetting(ctx.db, "ingest.keepMediaInR2") !== "false";
}

/** This payload kind is a media original the service keeps in R2 (given the current setting). */
export function archivesPayload(ctx: Ctx, payloadKind: string | null | undefined): boolean {
  return !!payloadKind && ARCHIVE_PAYLOAD_KINDS.has(payloadKind) && keepMediaInR2(ctx);
}

export function getArchive(ctx: Ctx, oid: string): MediaArchiveRow | undefined {
  return ctx.db.prepare("SELECT * FROM media_archive WHERE oid = ?").get(oid) as MediaArchiveRow | undefined;
}

/**
 * Record (or refresh) the archive row for a completed media original: the R2 keys that hold it and
 * where its full-size copy sits locally. Idempotent; called when the blob completes and again when a
 * record that references it is committed (so the filename and cached path follow the file to its home).
 */
export function recordArchive(ctx: Ctx, row: BlobRow): void {
  const total = row.total_chunks ?? 0;
  const partKeys = Array.from({ length: total }, (_, i) => blobChunkKey(row.oid, i));
  const path = row.local_path;
  const filename = path ? baseName(path) : `${row.oid}.${row.ext ?? "bin"}`;
  ctx.db.prepare(`INSERT INTO media_archive(oid, bucket, manifest_key, part_keys, payload_kind, plaintext_sha256, total_size,
                    filename, content_type, device_id, cached_local_path, cache_evicted, archived_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                  ON CONFLICT(oid) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type,
                    cached_local_path = excluded.cached_local_path, device_id = COALESCE(excluded.device_id, media_archive.device_id),
                    cache_evicted = 0`)
    .run(row.oid, row.bucket, blobManifestKey(row.oid), JSON.stringify(partKeys), row.payload_kind, row.sha256,
      row.total_size, filename, contentTypeOf(row.ext), row.device_id, path, nowIso());
}

/** Count and byte size of the media kept in R2, for the coverage/status view (principle 4). */
export function archiveStats(ctx: Ctx): { count: number; bytes: number; keepMediaInR2: boolean } {
  const r = ctx.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_size), 0) AS bytes FROM media_archive").get() as { count: number; bytes: number };
  return { count: r.count, bytes: r.bytes, keepMediaInR2: keepMediaInR2(ctx) };
}

/**
 * Drop the local full-size copy of an archived original to free disk; the object stays in R2 and is
 * re-fetched on the next download. Minimal and safe: only archived originals can be evicted.
 */
export function evictCachedOriginal(ctx: Ctx, oid: string): { evicted: boolean; freedPath?: string } {
  const arch = getArchive(ctx, oid);
  if (!arch) return { evicted: false };
  const row = getBlob(ctx, arch.bucket, oid);
  const path = row?.local_path ?? arch.cached_local_path;
  const freed = !!path && existsSync(path) && removeQuietly(path);
  ctx.db.prepare("UPDATE media_archive SET cache_evicted = 1, cached_local_path = NULL WHERE oid = ?").run(oid);
  if (row) ctx.db.prepare("UPDATE blobs SET local_path = NULL, updated_at = ? WHERE rid = ?").run(nowIso(), row.rid);
  return { evicted: true, ...(freed ? { freedPath: path! } : {}) };
}

/**
 * Re-fetch an archived original from R2 into the local cache: GET each part, verify it against the
 * stored manifest (length, SHA-256, header, AES-GCM), reassemble, check the whole-file size and
 * hash, move it to its home and relink the rows that reference it. Returns where the local copy sits.
 */
export async function refetchArchived(ctx: Ctx, oid: string): Promise<{ ok: true; path: string; already?: boolean } | { ok: false; reason: string }> {
  const arch = getArchive(ctx, oid);
  if (!arch) return { ok: false, reason: "not archived in R2" };
  const row = getBlob(ctx, arch.bucket, oid);
  if (!row || !row.manifest_env || row.total_chunks === null || row.total_size === null) return { ok: false, reason: "blob record is incomplete" };
  if (!arch.cache_evicted && row.local_path && existsSync(row.local_path)) return { ok: true, path: row.local_path, already: true };
  const bucket = ctx.r2()?.bucket("up", row.role as "windows" | "android");
  if (!bucket) return { ok: false, reason: "R2 is not configured" };
  const partKeys = JSON.parse(arch.part_keys) as string[];
  const tmp = join(dirs(ctx.config).blobsTmp, `${arch.bucket}-${oid}.refetch`);
  removeQuietly(tmp);
  const assembling: BlobRow = { ...row, status: "assembling", tmp_path: tmp };
  for (let i = 0; i < partKeys.length; i++) {
    const bytes = await bucket.get(partKeys[i]!, ctx.config.maxPartBytes);
    if (!bytes) { removeQuietly(tmp); return { ok: false, reason: `part ${i} is missing from R2` }; }
    const w = writePart(ctx, assembling, i, bytes);
    if (w.kind === "reject") { removeQuietly(tmp); return { ok: false, reason: `part ${i}: ${w.reason}` }; }
  }
  if (!existsSync(tmp)) { ensureDir(dirname(tmp)); closeSync(openSync(tmp, "w", 0o600)); } // a zero-length original
  const size = statSync(tmp).size;
  if (size !== row.total_size) { removeQuietly(tmp); return { ok: false, reason: `reassembled size ${size} != manifest ${row.total_size}` }; }
  const sha = await sha256File(tmp);
  if (arch.plaintext_sha256 && sha !== arch.plaintext_sha256) { removeQuietly(tmp); return { ok: false, reason: "reassembled hash does not match the archive record" }; }
  const holding = join(dirs(ctx.config).blobsTmp, `${arch.bucket}-${oid}.done`);
  renameSync(tmp, holding);
  ctx.db.prepare("UPDATE blobs SET status = 'complete', local_path = ?, sha256 = COALESCE(sha256, ?), ext = COALESCE(ext, ?), updated_at = ? WHERE rid = ?")
    .run(holding, sha, sniffFile(holding) ?? null, nowIso(), row.rid);
  const placed = placeAndLink(ctx, oid) ?? holding;
  ctx.db.prepare("UPDATE media_archive SET cached_local_path = ?, cache_evicted = 0 WHERE oid = ?").run(placed, oid);
  return { ok: true, path: placed };
}

/** Decrypt + validate a manifest envelope stored at `up/blob/<oid>/manifest`. Throws with a reason. */
export function openManifest(secret: Uint8Array, oid: string, env: Uint8Array): ManifestRecordT {
  const key = `up/blob/${oid}/manifest`;
  const pt = decryptEnvelope({ recipientSecretKey: secret, objectKey: key, envelope: env, expectedKind: "manifest" }).plaintext;
  const m = validateManifest(JSON.parse(fromUtf8(pt)));
  const oidBytes = fromCrockford(oid);
  if (oidBytes.length !== 16) throw new Error("oid did not decode to 16 bytes");
  if (m.objectId !== toHex(oidBytes)) throw new Error(`manifest objectId ${m.objectId} does not match key oid`);
  if (!KNOWN_PAYLOAD_KINDS.has(m.payloadKind)) throw new Error(`unknown payloadKind ${m.payloadKind}`);
  if (m.chunks.length !== m.totalChunks) throw new Error("manifest chunk list length differs from totalChunks");
  m.chunks.forEach((c, i) => { if (c.index !== i) throw new Error(`manifest chunk ${i} misordered`); });
  if (fromBase64(m.cek).length !== 32) throw new Error("manifest cek must be 32 bytes");
  const minSize = (m.totalChunks - 1) * m.chunkSize;
  if (m.totalSize > m.totalChunks * m.chunkSize || (m.totalChunks > 1 && m.totalSize <= minSize)) throw new Error("manifest sizes are inconsistent");
  return m;
}

/** Inside a transaction: record a verified manifest (resume state starts empty). */
export function recordManifest(ctx: Ctx, bucket: string, role: string, oid: string, env: Uint8Array, m: ManifestRecordT): void {
  const now = nowIso();
  const tmp = join(dirs(ctx.config).blobsTmp, `${bucket}-${oid}.part`);
  ctx.db.prepare(`INSERT INTO blobs(oid, bucket, role, status, payload_kind, total_size, chunk_size, total_chunks, manifest_env, tmp_path, first_seen_at, updated_at)
                  VALUES (?, ?, ?, 'assembling', ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(bucket, oid) DO UPDATE SET status = 'assembling', payload_kind = excluded.payload_kind, total_size = excluded.total_size,
                    chunk_size = excluded.chunk_size, total_chunks = excluded.total_chunks, manifest_env = excluded.manifest_env,
                    tmp_path = excluded.tmp_path, updated_at = excluded.updated_at
                  WHERE blobs.status = 'awaiting_manifest'`)
    .run(oid, bucket, role, m.payloadKind, m.totalSize, m.chunkSize, m.totalChunks, Buffer.from(env), tmp, now, now);
}

/** Parts seen before their manifest: remember when, so orphans can be quarantined after 7 days. */
export function noteAwaitingManifest(ctx: Ctx, bucket: string, role: string, oid: string): BlobRow {
  const now = nowIso();
  ctx.db.prepare(`INSERT INTO blobs(oid, bucket, role, status, first_seen_at, updated_at) VALUES (?, ?, ?, 'awaiting_manifest', ?, ?) ON CONFLICT(bucket, oid) DO NOTHING`)
    .run(oid, bucket, role, now, now);
  return getBlob(ctx, bucket, oid)!;
}

export type PartOutcome =
  | { kind: "written"; index: number; bytes: number }
  | { kind: "reject"; reason: string };

/**
 * Verify one part and write its plaintext into the blob's temp file. Does not
 * touch the database; the caller commits progress + ledger in one transaction.
 */
export function writePart(ctx: Ctx, row: BlobRow, index: number, part: Uint8Array): PartOutcome {
  if (row.status !== "assembling" || !row.manifest_env || row.total_chunks === null || row.chunk_size === null || row.total_size === null) {
    return { kind: "reject", reason: `blob is ${row.status}` };
  }
  if (!Number.isInteger(index) || index < 0 || index >= row.total_chunks) return { kind: "reject", reason: `part ${index} outside the manifest's range 0..${row.total_chunks - 1}` };
  const sk = ctx.keystore.secretKey(); // throws when locked (the caller leaves the part in R2)
  let m: ManifestRecordT;
  try { m = openManifest(sk, row.oid, row.manifest_env); } catch (e) { return { kind: "reject", reason: `stored manifest unusable: ${(e as Error).message}` }; }
  const entry = m.chunks[index]!;
  if (part.length !== entry.ctLen) return { kind: "reject", reason: `part ${index} length ${part.length} != manifest ${entry.ctLen}` };
  if (sha256Hex(part) !== entry.sha256) return { kind: "reject", reason: `part ${index} hash mismatch (tampered or substituted)` };
  let h;
  try { h = parseChunkHeader(part); } catch (e) { return { kind: "reject", reason: `part ${index} header: ${(e as Error).message}` }; }
  const oidBytes = fromCrockford(row.oid);
  if (!timingSafeEqual(h.objectId, oidBytes)) return { kind: "reject", reason: `part ${index} object id does not match the key oid` };
  if (h.index !== index) return { kind: "reject", reason: `part ${index} header says index ${h.index} (reordered)` };
  if (h.totalChunks !== m.totalChunks) return { kind: "reject", reason: `part ${index} total ${h.totalChunks} != manifest ${m.totalChunks}` };
  let plain: Uint8Array;
  try {
    plain = aesGcmDecrypt(fromBase64(m.cek), chunkNonce(index), part.subarray(CHUNK_HEADER_LEN), chunkAad(oidBytes, index, m.totalChunks));
  } catch { return { kind: "reject", reason: `part ${index} failed authentication` }; }
  const expectLen = index < m.totalChunks - 1 ? m.chunkSize : m.totalSize - (m.totalChunks - 1) * m.chunkSize;
  if (plain.length !== expectLen || part.length !== plain.length + CHUNK_HEADER_LEN + GCM_TAG_LEN) {
    return { kind: "reject", reason: `part ${index} plaintext length ${plain.length} != expected ${expectLen}` };
  }
  const tmp = row.tmp_path!;
  ensureDir(dirname(tmp));
  const fd = openSync(tmp, existsSync(tmp) ? "r+" : "w+", 0o600);
  try {
    let off = 0;
    while (off < plain.length) off += writeSync(fd, plain, off, plain.length - off, index * m.chunkSize + off);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  plain.fill(0);
  return { kind: "written", index, bytes: expectLen };
}

/** Inside a transaction: mark a written part committed. Returns the new committed count. */
export function markPartCommitted(ctx: Ctx, row: BlobRow, index: number, bytes: number): number {
  const fresh = getBlob(ctx, row.bucket, row.oid)!;
  const set = committedSet(fresh);
  if (!set.has(index)) {
    set.add(index);
    ctx.db.prepare("UPDATE blobs SET committed_parts = ?, committed_bytes = committed_bytes + ?, updated_at = ? WHERE rid = ?")
      .run(JSON.stringify([...set].sort((a, b) => a - b)), bytes, nowIso(), fresh.rid);
  }
  return set.size;
}

export function quarantineBlob(ctx: Ctx, row: BlobRow, reason: string): void {
  ctx.db.prepare("UPDATE blobs SET status = 'quarantined', detail = ?, updated_at = ? WHERE rid = ?").run(reason, nowIso(), row.rid);
  removeQuietly(row.tmp_path);
  // a command whose transfer this was is not waiting any more: say so (principle 4)
  const cmdId = row.command_id ?? (ctx.db.prepare("SELECT command_id FROM blobs WHERE rid = ?").get(row.rid) as { command_id: string | null } | undefined)?.command_id;
  if (cmdId) {
    const r = ctx.db.prepare(`UPDATE commands SET status = 'error', detail = ?, status_at = ?, completed_at = ? WHERE id = ? AND status IN ('sent','transferring','uploaded')`)
      .run(`transfer failed: ${reason}`, nowIso(), nowIso(), cmdId);
    if (r.changes) ctx.events.emit("command.status", { commandId: cmdId, status: "error", detail: "transfer failed" });
  }
}

/**
 * PROTOCOL §2.2 manifest `commandId`: link a file_original blob to the command it
 * answers as soon as its manifest is in, so the command shows "transferring" with
 * part progress before the device's command_status arrives. Only a file_request
 * sent to a device of the bucket's role, still waiting, can be claimed.
 * Inside the manifest's transaction. Returns the command id when linked.
 */
export function linkManifestCommand(ctx: Ctx, bucket: string, role: string, oid: string, m: ManifestRecordT): string | null {
  if (!m.commandId || m.payloadKind !== "file_original") return null;
  const c = ctx.db.prepare(`SELECT c.id, c.status, c.result_oid, d.role FROM commands c JOIN devices d ON d.id = c.device_id WHERE c.id = ? AND c.type = 'file_request'`)
    .get(m.commandId) as { id: string; status: string; result_oid: string | null; role: string } | undefined;
  if (!c || c.role !== role || !["queued", "sent", "transferring"].includes(c.status)) return null;
  if (c.result_oid && c.result_oid !== oid) return null;
  ctx.db.prepare("UPDATE blobs SET command_id = ? WHERE bucket = ? AND oid = ?").run(c.id, bucket, oid);
  ctx.db.prepare("UPDATE commands SET status = 'transferring', result_oid = ?, status_at = ? WHERE id = ?").run(oid, nowIso(), c.id);
  return c.id;
}

/** All parts committed: verify the reassembled file and move it home. */
export async function finalizeBlob(ctx: Ctx, bucket: string, oid: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const row = getBlob(ctx, bucket, oid);
  if (!row || row.status !== "assembling") return { ok: false, reason: "not assembling" };
  if (committedSet(row).size !== row.total_chunks) return { ok: false, reason: "parts missing" };
  const tmp = row.tmp_path!;
  // a zero-length blob never had a byte written
  if (!existsSync(tmp)) { ensureDir(dirname(tmp)); closeSync(openSync(tmp, "w", 0o600)); }
  const size = statSync(tmp).size;
  if (size !== row.total_size) {
    quarantineBlob(ctx, row, `reassembled size ${size} != manifest ${row.total_size}`);
    return { ok: false, reason: "size mismatch" };
  }
  const sha = await sha256File(tmp);
  const ext = sniffFile(tmp);
  const holding = join(dirs(ctx.config).blobsTmp, `${bucket}-${oid}.done`);
  renameSync(tmp, holding);
  ctx.db.prepare("UPDATE blobs SET status = 'complete', sha256 = ?, ext = ?, local_path = ?, tmp_path = NULL, completed_at = ?, updated_at = ? WHERE rid = ?")
    .run(sha, ext ?? null, holding, nowIso(), nowIso(), row.rid);
  const placed = placeAndLink(ctx, oid);
  // a media original is kept in R2 (PLAN decision 6): record the keys that hold it so it can be
  // re-fetched later, even when it cannot be placed home yet (its naming record has not arrived)
  const done = getBlob(ctx, bucket, oid);
  if (done && archivesPayload(ctx, done.payload_kind)) recordArchive(ctx, done);
  return { ok: true, path: placed ?? holding };
}

/** `original`: a file whose file_meta.originalBlobOid names the blob (PLAN decision 8 photo / document).
 *  `avatar`: a conversation whose chatMeta named the blob as its peer/chat image. */
interface Ref { kind: "media" | "thumb" | "file_original" | "attachment" | "original" | "avatar"; id: string; devicePath?: string; deviceId?: string }

function referencesOf(ctx: Ctx, oid: string): Ref[] {
  const refs: Ref[] = [];
  for (const r of ctx.db.prepare("SELECT id, source_path, device_id FROM media WHERE blob_oid = ?").all(oid) as Array<{ id: string; source_path: string | null; device_id: string }>) {
    refs.push({ kind: "media", id: r.id, devicePath: r.source_path ?? undefined, deviceId: r.device_id });
  }
  for (const r of ctx.db.prepare("SELECT id, path, device_id FROM files WHERE thumb_blob_oid = ?").all(oid) as Array<{ id: string; path: string; device_id: string }>) {
    refs.push({ kind: "thumb", id: r.id, deviceId: r.device_id });
  }
  for (const r of ctx.db.prepare(`SELECT c.id, c.file_id, f.path, c.device_id FROM commands c LEFT JOIN files f ON f.id = c.file_id
                                   WHERE c.result_oid = ? AND c.type = 'file_request'`).all(oid) as Array<{ id: string; file_id: string | null; path: string | null; device_id: string }>) {
    refs.push({ kind: "file_original", id: r.id, devicePath: r.path ?? undefined, deviceId: r.device_id });
  }
  for (const r of ctx.db.prepare("SELECT id, filename FROM attachments WHERE blob_oid = ?").all(oid) as Array<{ id: string; filename: string }>) {
    refs.push({ kind: "attachment", id: r.id, devicePath: r.filename });
  }
  for (const r of ctx.db.prepare("SELECT id, path, device_id FROM files WHERE original_blob_oid = ? ORDER BY rid").all(oid) as Array<{ id: string; path: string; device_id: string }>) {
    refs.push({ kind: "original", id: r.id, devicePath: r.path, deviceId: r.device_id });
  }
  for (const r of ctx.db.prepare("SELECT id FROM conversations WHERE avatar_blob_oid = ?").all(oid) as Array<{ id: string }>) {
    refs.push({ kind: "avatar", id: r.id });
  }
  return refs;
}

/**
 * A `photo` original (PLAN decision 8) becomes one media row (kind photo), from the first file that names
 * it, so it is OCR'd and searchable like a screenshot. Copies of the same image share the row (blob_oid is
 * unique). Inside the caller's flow; idempotent.
 */
function ensurePhotoMedia(ctx: Ctx, row: BlobRow): void {
  if (row.payload_kind !== "photo") return;
  if (ctx.db.prepare("SELECT 1 FROM media WHERE blob_oid = ?").get(row.oid)) return;
  const f = ctx.db.prepare("SELECT device_id, path, mtime, captured_at FROM files WHERE original_blob_oid = ? ORDER BY rid LIMIT 1").get(row.oid) as
    { device_id: string; path: string; mtime: string | null; captured_at: string } | undefined;
  if (!f) return; // the file_meta naming it has not arrived yet
  ctx.db.prepare(`INSERT OR IGNORE INTO media(id, device_id, kind, source_path, sha256, blob_oid, saved_at, captured_at, imported_at)
                  VALUES (?, ?, 'photo', ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), f.device_id, f.path, row.sha256, row.oid, f.mtime, f.captured_at, nowIso());
  ctx.db.prepare("UPDATE blobs SET device_id = COALESCE(device_id, ?) WHERE rid = ?").run(f.device_id, row.rid);
}

/** Where a completed blob belongs, given what references it. */
function homeFor(ctx: Ctx, row: BlobRow, refs: Ref[]): string | null {
  const d = dirs(ctx.config);
  const sniffed = row.ext ?? undefined;
  const kind = row.payload_kind;
  if (kind === "thumbnail") return join(d.thumbs, `${row.oid}.${sniffed ?? "jpg"}`);
  if (kind === "avatar") return join(d.avatars, `${row.oid}.${sniffed ?? "jpg"}`);
  if (kind === "file_original") {
    const ref = refs.find((r) => r.kind === "file_original" && r.devicePath);
    if (!ref) return null; // wait for the command_status that names it
    return join(d.files, row.oid, safeFileName(baseName(ref.devicePath!)));
  }
  if (kind === "document") {
    const ref = refs.find((r) => r.kind === "original" && r.devicePath);
    if (!ref) return null; // wait for the file_meta that names it
    return join(d.files, row.oid, safeFileName(baseName(ref.devicePath!)));
  }
  if (kind === "attachment") {
    const ref = refs.find((r) => r.kind === "attachment");
    return join(d.attachments, `${row.oid}.${extOf(ref?.devicePath) ?? sniffed ?? "bin"}`);
  }
  // screenshot / photo / media
  const ref = refs.find((r) => r.kind === "media" || r.kind === "original");
  return join(d.media, `${row.oid}.${sniffed ?? extOf(ref?.devicePath) ?? "bin"}`);
}

function safeFileName(n: string): string {
  const s = n.replace(/[\u0000-\u001f/\\:]/g, "_").replace(/^\.+/, "_").slice(0, 200);
  return s || "file";
}

/**
 * Move a complete blob to its home (if known yet) and update every row that
 * references it. Idempotent; called when the blob completes and again whenever
 * a record referencing it is committed.
 */
export function placeAndLink(ctx: Ctx, oid: string): string | null {
  const rows = ctx.db.prepare("SELECT * FROM blobs WHERE oid = ? AND status = 'complete'").all(oid) as BlobRow[];
  let placed: string | null = null;
  for (const row of rows) {
    ensurePhotoMedia(ctx, row);
    const refs = referencesOf(ctx, oid);
    const home = homeFor(ctx, row, refs);
    let path = row.local_path;
    if (home && path !== home && path && existsSync(path)) {
      mkdirSync(dirname(home), { recursive: true });
      renameSync(path, home);
      path = home;
      ctx.db.prepare("UPDATE blobs SET local_path = ?, updated_at = ? WHERE rid = ?").run(home, nowIso(), row.rid);
    }
    if (!path || !home || path !== home) continue; // not placeable yet
    placed = path;
    const now = nowIso();
    ctx.db.transaction(() => {
      for (const r of refs) {
        if (r.kind === "media") {
          ctx.db.prepare("UPDATE media SET local_path = ? WHERE id = ?").run(path, r.id);
          if (r.deviceId) ctx.db.prepare("UPDATE blobs SET device_id = COALESCE(device_id, ?) WHERE rid = ?").run(r.deviceId, row.rid);
        } else if (r.kind === "thumb") {
          ctx.db.prepare("UPDATE files SET thumb_path = ? WHERE id = ?").run(path, r.id);
        } else if (r.kind === "avatar") {
          ctx.db.prepare("UPDATE conversations SET avatar_local_path = ? WHERE id = ?").run(path, r.id);
        } else if (r.kind === "attachment") {
          ctx.db.prepare("UPDATE attachments SET local_path = ?, status = 'cached' WHERE id = ?").run(path, r.id);
        } else if (r.kind === "original") {
          // the file's own copy: cached while its newest file_meta still names this blob
          const u = ctx.db.prepare(`UPDATE files SET local_path = ?, status = 'cached',
                                      extract_status = CASE WHEN ? = 'document' THEN COALESCE(extract_status, 'pending') ELSE extract_status END
                                    WHERE id = ? AND original_blob_oid = ? AND (local_path IS NOT ? OR status <> 'cached')`)
            .run(path, row.payload_kind, r.id, oid, path);
          if (u.changes) ctx.events.emit("file.cached", { fileId: r.id, blobOid: oid, payloadKind: row.payload_kind });
        } else if (r.kind === "file_original") {
          const c = ctx.db.prepare("SELECT id, file_id, status FROM commands WHERE id = ?").get(r.id) as { id: string; file_id: string | null; status: string };
          if (c.file_id) ctx.db.prepare("UPDATE files SET local_path = ?, status = 'cached' WHERE id = ?").run(path, c.file_id);
          if (c.status !== "done") {
            ctx.db.prepare("UPDATE commands SET status = 'done', completed_at = ? WHERE id = ?").run(now, c.id);
            ctx.events.emit("command.completed", { commandId: c.id, fileId: c.file_id, resultOid: oid });
            ctx.events.emit("file.cached", { fileId: c.file_id, commandId: c.id });
          }
        }
      }
    })();
    // keep the archive record's filename and cached path following a media original to its home
    if (archivesPayload(ctx, row.payload_kind)) recordArchive(ctx, getBlob(ctx, row.bucket, oid) ?? row);
    for (const r of refs) if (r.kind === "media" && IMAGE_EXTS.has(extOf(path) ?? "")) ctx.mediaReady?.(r.id, path);
    if (row.payload_kind === "document" && refs.some((r) => r.kind === "original")) {
      const waiting = ctx.db.prepare("SELECT 1 FROM files WHERE original_blob_oid = ? AND (extract_status IS NULL OR extract_status = 'pending') LIMIT 1").get(oid);
      if (waiting) ctx.documentReady?.(oid, path);
    }
  }
  return placed;
}

/** Progress for the coverage dashboard and file transfers. */
export function blobProgress(row: BlobRow) {
  return {
    oid: row.oid, bucket: row.bucket, status: row.status, payloadKind: row.payload_kind,
    committedParts: committedSet(row).size, totalChunks: row.total_chunks,
    committedBytes: row.committed_bytes, totalSize: row.total_size,
    firstSeenAt: row.first_seen_at, updatedAt: row.updated_at, detail: row.detail,
  };
}
