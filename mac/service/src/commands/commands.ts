/**
 * Mac -> device commands (PRD F2/F3, PROTOCOL §6 command / command_status).
 *
 * Lifecycle: queued (row written; R2 not reached yet) -> sent (cmd/<oid> is in
 * the device's cmd-bucket) -> uploaded / done / not_found / access_denied /
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
import { getDevice } from "../pairing/pairing.ts";
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
  const device = getDevice(ctx, c.device_id);
  const cmd = device ? ctx.r2()?.bucket("cmd", device.role) : undefined;
  if (!cmd) return false;
  try {
    await cmd.delete(c.object_key);
    ctx.db.prepare("UPDATE commands SET cmd_deleted = 1 WHERE id = ?").run(c.id);
    return true;
  } catch { return false; }
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
  if (!c || !["queued", "sent"].includes(c.status)) return false;
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
  const display = c.status === "queued" || c.status === "sent" ? "queued" : c.status === "uploaded" ? "transferring" : c.status;
  return {
    id: c.id, deviceId: c.device_id, type: c.type, params: rec.params, fileId: c.file_id, status: c.status, display,
    waitingOn: c.status === "queued" ? "mac" : c.status === "sent" ? "device" : c.status === "uploaded" ? "transfer" : null,
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
  const f = ctx.db.prepare("SELECT id, device_id, path, status, local_path, deleted_at FROM files WHERE id = ?").get(fileId) as
    { id: string; device_id: string; path: string; status: string; local_path: string | null; deleted_at: string | null } | undefined;
  if (!f) throw new CommandError("unknown_file", `no file ${fileId}`);
  if (f.deleted_at) throw new CommandError("file_in_bin", "the file is in the recovery bin");
  if (!getDevice(ctx, f.device_id)) throw new CommandError("device_revoked", "the file's device is no longer paired");
  if (!opts.force) {
    const open = ctx.db.prepare("SELECT * FROM commands WHERE file_id = ? AND status IN ('queued','sent','uploaded') ORDER BY issued_at DESC LIMIT 1").get(fileId) as CommandRow | undefined;
    if (open) return { command: commandView(ctx, open), reused: true };
    if (f.status === "cached" && f.local_path) return { command: null, reused: false, alreadyCached: true };
  }
  // The vault file id is not the device's file id; the device locates the file by path.
  const c = await issueCommand(ctx, f.device_id, { type: "file_request", path: f.path }, { fileId });
  return { command: commandView(ctx, c), reused: false };
}
