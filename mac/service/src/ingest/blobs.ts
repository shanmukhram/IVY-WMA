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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  aesGcmDecrypt, chunkNonce, concatBytes, decryptEnvelope, fromBase64, fromCrockford, fromUtf8, kindId,
  parseChunkHeader, timingSafeEqual, toHex, u32be, utf8, validateManifest,
} from "@ivy/protocol";
import type { ManifestRecordT } from "@ivy/protocol";
import type { Ctx } from "../context.ts";
import { dirs } from "../config.ts";
import { ensureDir, sha256File, sha256Hex, removeQuietly } from "../util/fsx.ts";
import { nowIso } from "../util/time.ts";
import { baseName, extOf, sniffFile, IMAGE_EXTS } from "../util/ext.ts";

const CHUNK_HEADER_LEN = 32;
const GCM_TAG_LEN = 16;
const KNOWN_PAYLOAD_KINDS = new Set(["file_original", "screenshot", "thumbnail", "photo", "attachment", "media"]);

export interface BlobRow {
  rid: number; oid: string; bucket: string; role: string; device_id: string | null;
  status: "awaiting_manifest" | "assembling" | "complete" | "quarantined";
  payload_kind: string | null; total_size: number | null; chunk_size: number | null; total_chunks: number | null;
  manifest_env: Buffer | null; committed_parts: string; committed_bytes: number; tmp_path: string | null;
  local_path: string | null; ext: string | null; sha256: string | null; first_seen_at: string; updated_at: string;
  completed_at: string | null; detail: string | null;
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
  return { ok: true, path: placed ?? holding };
}

interface Ref { kind: "media" | "thumb" | "file_original" | "attachment"; id: string; devicePath?: string; deviceId?: string }

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
  return refs;
}

/** Where a completed blob belongs, given what references it. */
function homeFor(ctx: Ctx, row: BlobRow, refs: Ref[]): string | null {
  const d = dirs(ctx.config);
  const sniffed = row.ext ?? undefined;
  const kind = row.payload_kind;
  if (kind === "thumbnail") return join(d.thumbs, `${row.oid}.${sniffed ?? "jpg"}`);
  if (kind === "file_original") {
    const ref = refs.find((r) => r.kind === "file_original" && r.devicePath);
    if (!ref) return null; // wait for the command_status that names it
    return join(d.files, row.oid, safeFileName(baseName(ref.devicePath!)));
  }
  if (kind === "attachment") {
    const ref = refs.find((r) => r.kind === "attachment");
    return join(d.attachments, `${row.oid}.${extOf(ref?.devicePath) ?? sniffed ?? "bin"}`);
  }
  // screenshot / photo / media
  const ref = refs.find((r) => r.kind === "media");
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
        } else if (r.kind === "attachment") {
          ctx.db.prepare("UPDATE attachments SET local_path = ?, status = 'cached' WHERE id = ?").run(path, r.id);
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
    for (const r of refs) if (r.kind === "media" && IMAGE_EXTS.has(extOf(path) ?? "")) ctx.mediaReady?.(r.id, path);
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
