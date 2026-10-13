/**
 * Mac -> device commands (PRD F2/F3, PROTOCOL §6 command / command_status).
 *
 * Lifecycle: queued (row written; R2 not reached yet) -> sent (cmd/<oid> is in
 * the device's cmd-bucket) -> [transferring: a file_original manifest naming this
 * command arrived (PROTOCOL §2.2 commandId); parts are committing] -> uploaded / done / not_found / access_denied /
 * too_large / error (from the device's command_status). For file_request,
 * "uploaded" turns into "done" when the file_original blob is reassembled and
 * the file is cached locally. An offline device simply leaves the command at
 * "sent": the UI shows it as queued (waiting on the device). The Mac deletes
 * cmd/<oid> when it ingests the matching status (PLAN decision 4); a command
 * still unanswered after the 30-day cmd lifecycle is marked expired.
 */
import { randomUUID } from "node:crypto";
import { cmdKey, encryptEnvelope, fromBase64, newOid, utf8, validateRecordKind } from "@ivy/protocol";
import type { CommandRecordT } from "@ivy/protocol";
import type { Ctx } from "../context.ts";
import { getDevice, type DeviceRow } from "../pairing/pairing.ts";
import type { Role } from "../r2/config.ts";
import { getArchive, refetchArchived } from "../ingest/blobs.ts";
import { nowIso } from "../util/time.ts";

export type CommandParams = CommandRecordT["params"];

export class CommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface CommandRow {
  id: string; device_id: string; oid: string; object_key: string; type: string; params: string; file_id: string | null;
  status: string; detail: string | null; result_oid: string | null; issued_at: string; sent_at: string | null;
  status_at: string | null; completed_at: string | null; cmd_deleted: number; send_attempts: number; last_error: string | null;
}

const CMD_LIFECYCLE_MS = 30 * 24 * 3600_000;

export async function issueCommand(ctx: Ctx, deviceId: string, params: CommandParams, opts: { fileId?: string } = {}): Promise<CommandRow> {
  const device = getDevice(ctx, deviceId);
  if (!device) throw new CommandError("unknown_device", `no paired device ${deviceId}`);
  const now = nowIso();
  const oid = newOid();
  const key = cmdKey(oid);
  // validate the exact record we will send (schema is the protocol's)
  const record = validateRecordKind("command", {
    v: 1, kind: "command", deviceId, eventTime: now, captureTime: now, commandId: randomUUID(), issuedAt: now, params,
  });
  ctx.db.prepare(`INSERT INTO commands(id, device_id, oid, object_key, type, params, file_id, status, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
    .run(record.commandId, deviceId, oid, key, params.type, JSON.stringify(record), opts.fileId ?? null, now);
  ctx.events.emit("command.issued", { commandId: record.commandId, deviceId, type: params.type, fileId: opts.fileId ?? null });
  await sendCommand(ctx, record.commandId);
  return getCommand(ctx, record.commandId)!;
}

/** Write a queued command to the device's cmd-bucket. Leaves it queued on failure (retried every poll). */
export async function sendCommand(ctx: Ctx, commandId: string): Promise<boolean> {
  const c = getCommand(ctx, commandId);
  if (!c || c.status !== "queued") return false;
  const device = getDevice(ctx, c.device_id);
  if (!device) return false;
  const cmd = ctx.r2()?.bucket("cmd", device.role);
  if (!cmd) {
    ctx.db.prepare("UPDATE commands SET last_error = ? WHERE id = ?").run(ctx.keystore.isUnlocked() ? "R2 is not configured" : "vault locked", c.id);
    return false;
  }
  const envelope = encryptEnvelope({
    recipientPublicKey: fromBase64(device.public_key), kind: "command", objectKey: c.object_key, plaintext: utf8(c.params),
  });
  try {
    await cmd.put(c.object_key, envelope);
  } catch (e) {
    ctx.db.prepare("UPDATE commands SET send_attempts = send_attempts + 1, last_error = ? WHERE id = ?").run((e as Error).message, c.id);
    return false;
  }
  ctx.db.prepare("UPDATE commands SET status = 'sent', sent_at = ?, send_attempts = send_attempts + 1, last_error = NULL WHERE id = ? AND status = 'queued'").run(nowIso(), c.id);
  ctx.events.emit("command.sent", { commandId: c.id, deviceId: c.device_id, type: c.type });
  return true;
}

export async function sendQueued(ctx: Ctx): Promise<number> {
  let n = 0;
  for (const r of ctx.db.prepare("SELECT id FROM commands WHERE status = 'queued' ORDER BY issued_at").all() as Array<{ id: string }>) {
    if (await sendCommand(ctx, r.id)) n++;
  }
  return n;
}

/** Delete cmd/<oid> after its status was committed (PLAN decision 4). */
export async function deleteCommandObject(ctx: Ctx, commandId: string): Promise<boolean> {
  const c = getCommand(ctx, commandId);
  if (!c || c.cmd_deleted) return false;
  const role = commandRole(ctx, c.device_id);
  const cmd = role ? ctx.r2()?.bucket("cmd", role) : undefined;
  if (!cmd) return false;
  try {
    await cmd.delete(c.object_key);
    ctx.db.prepare("UPDATE commands SET cmd_deleted = 1 WHERE id = ?").run(c.id);
    return true;
  } catch { return false; }
}

/**
 * The role (so the cmd-bucket) of a command's device. A device that was revoked or forgotten has no devices row,
 * but its unpair command still has to be deleted from its cmd-bucket when the device answers.
 */
function commandRole(ctx: Ctx, deviceId: string): Role | undefined {
  for (const t of ["devices", "revoked_devices", "forgotten_devices"]) {
    const r = ctx.db.prepare(`SELECT role FROM ${t} WHERE id = ?`).get(deviceId) as { role: Role } | undefined;
    if (r) return r.role;
  }
  return undefined;
}

/** What a revoke or forget reports about telling the device to reset. */
export interface UnpairOutcome {
  /** true when cmd/<oid> with the unpair command is in the device's cmd-bucket */
  unpairSent: boolean;
  unpairCommandId: string | null;
  unpairSentAt: string | null;
  /** why the device could not be told; null when it was sent */
  unpairReason: string | null;
}

/**
 * Tell a device it is being removed: issue and send an `unpair` command while its key is still known. Called by
 * revoke and forget before they drop the device. Never throws: when R2 is not reachable the removal goes ahead
 * and the outcome says the device could not be told. A command that could not be written is cancelled, so it is
 * not retried for a device that no longer exists. The sent command is left in the cmd-bucket until the device's
 * command_status arrives (then deleted, PLAN decision 4) or the 30-day lifecycle rule removes it.
 */
export async function sendUnpair(ctx: Ctx, device: DeviceRow): Promise<UnpairOutcome> {
  const notSent = (reason: string, id: string | null = null): UnpairOutcome => ({ unpairSent: false, unpairCommandId: id, unpairSentAt: null, unpairReason: reason });
  if (!ctx.r2()?.bucket("cmd", device.role)) {
    return notSent(ctx.keystore.isUnlocked()
      ? "R2 is not configured, so the device could not be told to reset. It still considers itself paired, and the Mac refuses its uploads."
      : "The vault is locked, so the device could not be told to reset. It still considers itself paired, and the Mac refuses its uploads.");
  }
  let c: CommandRow;
  try { c = await issueCommand(ctx, device.id, { type: "unpair" }); }
  catch (e) { return notSent(`The unpair command could not be created: ${(e as Error).message}`); }
  if (c.status === "sent") return { unpairSent: true, unpairCommandId: c.id, unpairSentAt: c.sent_at, unpairReason: null };
  const why = c.last_error ?? "unknown error";
  ctx.db.prepare("UPDATE commands SET status = 'cancelled', status_at = ?, cmd_deleted = 1, detail = ? WHERE id = ? AND status = 'queued'")
    .run(nowIso(), `could not be written to R2: ${why}`, c.id);
  return notSent(`The unpair command could not be written to R2 (${why}), so the device was not told to reset. It still considers itself paired, and the Mac refuses its uploads.`, c.id);
}

/** Retry deletes that failed earlier, and expire commands the 30-day lifecycle has removed. */
export async function maintainCommands(ctx: Ctx, now = Date.now()): Promise<void> {
  for (const r of ctx.db.prepare(`SELECT id FROM commands WHERE cmd_deleted = 0 AND status NOT IN ('queued','sent')`).all() as Array<{ id: string }>) {
    await deleteCommandObject(ctx, r.id);
  }
  const cutoff = new Date(now - CMD_LIFECYCLE_MS).toISOString();
  const expired = ctx.db.prepare(`UPDATE commands SET status = 'expired', status_at = ?, detail = 'no answer within the 30-day cmd lifecycle'
                                  WHERE status = 'sent' AND sent_at < ?`).run(nowIso(), cutoff);
  if (expired.changes) ctx.events.emit("command.status", { expired: expired.changes });
}

export async function cancelCommand(ctx: Ctx, commandId: string): Promise<boolean> {
  const c = getCommand(ctx, commandId);
  if (!c || !["queued", "sent", "transferring"].includes(c.status)) return false;
  ctx.db.prepare("UPDATE commands SET status = 'cancelled', status_at = ? WHERE id = ?").run(nowIso(), c.id);
  if (c.status === "sent") await deleteCommandObject(ctx, c.id);
  else ctx.db.prepare("UPDATE commands SET cmd_deleted = 1 WHERE id = ?").run(c.id);
  ctx.events.emit("command.cancelled", { commandId: c.id });
  return true;
}

export function getCommand(ctx: Ctx, id: string): CommandRow | undefined {
  return ctx.db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as CommandRow | undefined;
}

/** API view: device-side "queued" covers both queued and sent; transfer progress for file results. */
export function commandView(ctx: Ctx, c: CommandRow) {
  const rec = JSON.parse(c.params) as CommandRecordT;
  let progress: null | { committedParts: number; totalChunks: number | null; committedBytes: number; totalSize: number | null } = null;
  if (c.result_oid) {
    const b = ctx.db.prepare("SELECT committed_parts, total_chunks, committed_bytes, total_size, status FROM blobs WHERE oid = ?").get(c.result_oid) as
      { committed_parts: string; total_chunks: number | null; committed_bytes: number; total_size: number | null; status: string } | undefined;
    if (b) progress = { committedParts: (JSON.parse(b.committed_parts) as number[]).length, totalChunks: b.total_chunks, committedBytes: b.committed_bytes, totalSize: b.total_size };
  }
  const display = c.status === "queued" || c.status === "sent" ? "queued" : c.status === "uploaded" || c.status === "transferring" ? "transferring" : c.status;
  return {
    id: c.id, deviceId: c.device_id, type: c.type, params: rec.params, fileId: c.file_id, status: c.status, display,
    waitingOn: c.status === "queued" ? "mac" : c.status === "sent" ? "device" : c.status === "uploaded" || c.status === "transferring" ? "transfer" : null,
    detail: c.detail, resultOid: c.result_oid, issuedAt: c.issued_at, sentAt: c.sent_at, statusAt: c.status_at,
    completedAt: c.completed_at, cmdDeleted: !!c.cmd_deleted, lastError: c.last_error, progress,
  };
}

export function listCommands(ctx: Ctx, f: { deviceId?: string; status?: string; fileId?: string; limit?: number } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.deviceId) { where.push("device_id = ?"); args.push(f.deviceId); }
  if (f.status) { where.push("status = ?"); args.push(f.status); }
  if (f.fileId) { where.push("file_id = ?"); args.push(f.fileId); }
  const rows = ctx.db.prepare(`SELECT * FROM commands ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY issued_at DESC, rid DESC LIMIT ?`)
    .all(...args, Math.min(f.limit ?? 100, 1000)) as CommandRow[];
  return rows.map((r) => commandView(ctx, r));
}

/** F2: request the original of an indexed file. Reuses an outstanding request for the same file. */
export async function requestFile(ctx: Ctx, fileId: string, opts: { force?: boolean } = {}) {
  const f = ctx.db.prepare("SELECT id, device_id, path, status, local_path, original_blob_oid, deleted_at FROM files WHERE id = ?").get(fileId) as
    { id: string; device_id: string; path: string; status: string; local_path: string | null; original_blob_oid: string | null; deleted_at: string | null } | undefined;
  if (!f) throw new CommandError("unknown_file", `no file ${fileId}`);
  if (f.deleted_at) throw new CommandError("file_in_bin", "the file is in the recovery bin");
  if (!opts.force) {
    const open = ctx.db.prepare("SELECT * FROM commands WHERE file_id = ? AND status IN ('queued','sent','transferring','uploaded') ORDER BY issued_at DESC LIMIT 1").get(fileId) as CommandRow | undefined;
    if (open) return { command: commandView(ctx, open), reused: true };
    if (f.status === "cached" && f.local_path) return { command: null, reused: false, alreadyCached: true };
    // the original is kept in R2 (PLAN decision 6): re-fetch it from storage, no device needed
    if (f.original_blob_oid && getArchive(ctx, f.original_blob_oid)) {
      const r = await refetchArchived(ctx, f.original_blob_oid);
      if (r.ok) return { command: null, reused: false, fetchedFromR2: true, alreadyCached: r.already ?? false };
    }
  }
  if (!getDevice(ctx, f.device_id)) throw new CommandError("device_revoked", "the file's device is no longer paired");
  // The vault file id is not the device's file id; the device locates the file by path.
  const c = await issueCommand(ctx, f.device_id, { type: "file_request", path: f.path }, { fileId });
  return { command: commandView(ctx, c), reused: false };
}
