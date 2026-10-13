/**
 * Pairing issuance and consumption (PROTOCOL §7, PLAN decision 1).
 *
 * start(role): new pairing id + one-time secret; the sealed bootstrap (the
 * device's up-bucket WRITE token) goes to `pair/<id>` in the role's cmd-bucket;
 * the pairing string carries the endpoint, the cmd-bucket READ token, the Mac
 * public key + fingerprint, id, secret and a 10-minute expiry. The secret is
 * never stored: it exists only in the returned string.
 *
 * The device answers with `pair/<id>/device` in its up-bucket; ingest calls
 * `acceptDeviceRecord` inside the commit transaction. Exactly once: the pairing
 * row flips to consumed in the same transaction that records the device, a
 * second device object (an overwrite of that key) is refused by the ledger, and
 * the bootstrap is deleted from the cmd-bucket.
 */
import {
  encodePairingString, encryptPairingBootstrap, fingerprintFromB64, newPairingId, newPairingSecret,
  pairingBootstrapKey, toBase64, utf8,
} from "@ivy/protocol";
import type { PairingDeviceRecordT, PairingPayload } from "@ivy/protocol";
import type { Ctx } from "../context.ts";
import { bucketName, endpointOf, type Role } from "../r2/config.ts";
import { nowIso, msOf } from "../util/time.ts";
import { sendUnpair } from "../commands/commands.ts";

export class PairingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface PairingRow {
  id: string; role: Role; created_at: string; expires_at: string;
  status: "pending" | "consumed" | "expired" | "cancelled"; device_id: string | null; consumed_at: string | null; bootstrap_deleted: number;
}

export interface DeviceRow {
  id: string; role: Role; public_key: string; fingerprint: string; pairing_id: string | null; paired_at: string;
  last_seen: string | null; last_report_at: string | null; app_version: string | null; queue_depth_total: number | null;
  name: string | null;
}

export async function startPairing(ctx: Ctx, role: Role): Promise<{
  pairingId: string; role: Role; pairingString: string; macFingerprint: string; expiresAt: string;
}> {
  if (role !== "windows" && role !== "android") throw new PairingError("bad_role", "role must be windows or android");
  const r2 = ctx.r2();
  if (!r2) throw new PairingError("r2_unavailable", ctx.keystore.isUnlocked() ? "configure R2 first" : "the vault is locked");
  const dev = r2.config.deviceTokens[role];
  if (!dev) throw new PairingError("no_device_tokens", `no ${role} device tokens configured (deviceTokens.${role}.upWrite / cmdRead)`);
  const cmd = r2.bucket("cmd", role);
  if (!cmd) throw new PairingError("no_mac_token", `no Mac token for the ${role} cmd-bucket`);

  // one live code per role: an older unused code is cancelled and its bootstrap removed
  for (const p of ctx.db.prepare("SELECT id FROM pairings WHERE role = ? AND status = 'pending'").all(role) as Array<{ id: string }>) {
    await cancelPairing(ctx, p.id, "superseded");
  }

  const pairingId = newPairingId();
  const secret = newPairingSecret();
  const created = Date.now();
  const exp = created + ctx.config.pairingTtlMs;
  const upBucket = bucketName(r2.config, "up", role);
  const sealed = encryptPairingBootstrap({ v: 1, upBucket, upWriteToken: dev.upWrite, pairingId }, secret);
  await cmd.put(pairingBootstrapKey(pairingId), utf8(JSON.stringify(sealed)));
  ctx.db.prepare(`INSERT INTO pairings(id, role, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'pending')`)
    .run(pairingId, role, new Date(created).toISOString(), new Date(exp).toISOString());

  const macPub = ctx.keystore.macPublicKey();
  const payload: PairingPayload = {
    v: 1,
    r2Endpoint: r2.config.deviceEndpoint ?? endpointOf(r2.config),
    role,
    cmdBucket: bucketName(r2.config, "cmd", role),
    upBucket,
    cmdReadToken: dev.cmdRead,
    macPublicKey: toBase64(macPub),
    macFingerprint: ctx.keystore.macFingerprint(),
    pairingId,
    secret: toBase64(secret),
    exp,
  };
  secret.fill(0);
  const pairingString = encodePairingString(payload);
  ctx.events.emit("pairing.started", { pairingId, role, expiresAt: new Date(exp).toISOString() });
  return { pairingId, role, pairingString, macFingerprint: payload.macFingerprint, expiresAt: new Date(exp).toISOString() };
}

async function deleteBootstrap(ctx: Ctx, p: { id: string; role: Role }): Promise<boolean> {
  const cmd = ctx.r2()?.bucket("cmd", p.role);
  if (!cmd) return false;
  try {
    await cmd.delete(pairingBootstrapKey(p.id));
    ctx.db.prepare("UPDATE pairings SET bootstrap_deleted = 1 WHERE id = ?").run(p.id);
    return true;
  } catch { return false; }
}

export async function cancelPairing(ctx: Ctx, id: string, reason = "cancelled"): Promise<boolean> {
  const p = ctx.db.prepare("SELECT * FROM pairings WHERE id = ?").get(id) as PairingRow | undefined;
  if (!p || p.status !== "pending") return false;
  ctx.db.prepare("UPDATE pairings SET status = 'cancelled' WHERE id = ?").run(id);
  await deleteBootstrap(ctx, p);
  ctx.events.emit("pairing.cancelled", { pairingId: id, role: p.role, reason });
  return true;
}

/** Expire pending pairings past exp + grace and remove their bootstraps; retry leftover bootstrap deletes. */
export async function expireStalePairings(ctx: Ctx, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - ctx.config.pairingGraceMs).toISOString();
  const stale = ctx.db.prepare("SELECT * FROM pairings WHERE status = 'pending' AND expires_at < ?").all(cutoff) as PairingRow[];
  for (const p of stale) {
    ctx.db.prepare("UPDATE pairings SET status = 'expired' WHERE id = ?").run(p.id);
    ctx.events.emit("pairing.expired", { pairingId: p.id, role: p.role });
  }
  const leftovers = ctx.db.prepare("SELECT * FROM pairings WHERE status != 'pending' AND bootstrap_deleted = 0").all() as PairingRow[];
  for (const p of leftovers) await deleteBootstrap(ctx, p);
  return stale.length;
}

export function listPairings(ctx: Ctx): PairingRow[] {
  return ctx.db.prepare("SELECT id, role, created_at, expires_at, status, device_id, consumed_at, bootstrap_deleted FROM pairings ORDER BY created_at DESC LIMIT 50").all() as PairingRow[];
}

/**
 * Validate a decrypted pairing_device record and, if acceptable, record the
 * device. Runs INSIDE the ingest transaction. Returns a rejection reason or the
 * accepted device.
 */
export function acceptDeviceRecord(
  ctx: Ctx,
  rec: PairingDeviceRecordT,
  ctx2: { keyPairingId: string; bucketRole: Role; writtenAt?: string; now?: number },
): { ok: true; deviceId: string; fingerprint: string; pairingId: string; role: Role } | { ok: false; reason: string } {
  const now = ctx2.now ?? Date.now();
  if (rec.pairingId !== ctx2.keyPairingId) return { ok: false, reason: `record pairingId ${rec.pairingId} does not match its key` };
  const p = ctx.db.prepare("SELECT * FROM pairings WHERE id = ?").get(rec.pairingId) as PairingRow | undefined;
  if (!p) return { ok: false, reason: "unknown pairing id" };
  if (p.status !== "pending") return { ok: false, reason: `pairing already ${p.status} (single use)` };
  if (rec.role !== p.role || rec.role !== ctx2.bucketRole) return { ok: false, reason: `role ${rec.role} does not match pairing role ${p.role} / bucket ${ctx2.bucketRole}` };
  const exp = msOf(p.expires_at)!;
  const written = msOf(ctx2.writtenAt);
  if (written !== null ? written > exp + ctx.config.pairingGraceMs : now > exp + ctx.config.pairingGraceMs) {
    return { ok: false, reason: "pairing code had expired when the device answered" };
  }
  let fp: string;
  try { fp = fingerprintFromB64(rec.publicKey); } catch { return { ok: false, reason: "bad device public key" }; }
  if (fp !== rec.fingerprint) return { ok: false, reason: `device fingerprint ${rec.fingerprint} does not match its public key (${fp})` };
  // a forgotten device id never comes back: a device pairing again chooses a new id (the companions do)
  if (ctx.db.prepare("SELECT 1 FROM forgotten_devices WHERE id = ?").get(rec.deviceId)) return { ok: false, reason: "this device id was forgotten; pair again from the device to get a new id" };

  const at = nowIso();
  ctx.db.prepare(`INSERT INTO devices(id, role, public_key, fingerprint, pairing_id, paired_at, last_seen)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET role = excluded.role, public_key = excluded.public_key, fingerprint = excluded.fingerprint,
                    pairing_id = excluded.pairing_id, paired_at = excluded.paired_at, last_seen = excluded.last_seen`)
    .run(rec.deviceId, rec.role, rec.publicKey, fp, rec.pairingId, at, at);
  ctx.db.prepare("UPDATE pairings SET status = 'consumed', device_id = ?, consumed_at = ? WHERE id = ?").run(rec.deviceId, at, rec.pairingId);
  // a revoked device that pairs again under the same id is no longer "recently removed"
  ctx.db.prepare("DELETE FROM revoked_devices WHERE id = ?").run(rec.deviceId);
  // and an unpair command it has not answered must not reset it now: cancelled here, its cmd object is deleted by
  // the next command maintenance pass
  ctx.db.prepare(`UPDATE commands SET status = 'cancelled', status_at = ?, detail = 'device paired again'
                  WHERE device_id = ? AND type = 'unpair' AND status IN ('queued','sent')`).run(at, rec.deviceId);
  return { ok: true, deviceId: rec.deviceId, fingerprint: fp, pairingId: rec.pairingId, role: rec.role };
}

/** After commit: remove the consumed bootstrap from the cmd-bucket. */
export async function finishPairing(ctx: Ctx, pairingId: string, role: Role): Promise<void> {
  await deleteBootstrap(ctx, { id: pairingId, role });
}

// ---------------------------------------------------------------- devices

export function listDevices(ctx: Ctx): DeviceRow[] {
  return ctx.db.prepare("SELECT id, role, public_key, fingerprint, pairing_id, paired_at, last_seen, last_report_at, app_version, queue_depth_total, name FROM devices ORDER BY paired_at").all() as DeviceRow[];
}

export function getDevice(ctx: Ctx, id: string): DeviceRow | undefined {
  return ctx.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
}

/** Longest device name the owner can set. */
export const DEVICE_NAME_MAX = 60;

/**
 * Set or clear the owner's name for a paired device. Trims; an empty string or
 * null clears it. Throws PairingError not_found / bad_value. The name lives only
 * in the Mac's database.
 */
export function renameDevice(ctx: Ctx, id: string, name: unknown): { deviceId: string; name: string | null } {
  if (name !== null && typeof name !== "string") throw new PairingError("bad_value", "name must be a string or null");
  const trimmed = name === null ? "" : name.trim();
  if (trimmed.length > DEVICE_NAME_MAX) throw new PairingError("bad_value", `name must be at most ${DEVICE_NAME_MAX} characters`);
  if (!getDevice(ctx, id)) throw new PairingError("not_found", "no such device");
  const value = trimmed === "" ? null : trimmed;
  ctx.db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(value, id);
  ctx.events.emit("device.renamed", { deviceId: id, name: value });
  return { deviceId: id, name: value };
}

/** Shown after a revoke or a forget: the Mac cannot invalidate a device's R2 tokens itself. */
export const TOKEN_WARNING = "The device's R2 tokens remain valid until you rotate them in the Cloudflare dashboard.";

/**
 * Revoke a device: tell it to reset (an `unpair` command, when R2 is reachable), then forget its public key (no
 * further commands can be wrapped to it and its uploads are quarantined as from an unknown device), cancel its
 * other outstanding commands and remove them from the cmd-bucket. The unpair command is exempt: it stays in the
 * cmd-bucket until the device's command_status for it arrives (accepted although the device is gone; see the
 * ingester) or the 30-day lifecycle rule removes it. The device is remembered in revoked_devices so the
 * Devices page can show whether it confirmed the reset. Captured content is kept. The device's R2 tokens stay
 * valid until rotated in Cloudflare; the UI must say so.
 */
export async function revokeDevice(ctx: Ctx, id: string): Promise<{
  revoked: boolean; cancelledCommands: number; tokenWarning: string;
  unpairSent: boolean; unpairCommandId: string | null; unpairSentAt: string | null; unpairReason: string | null;
}> {
  const d = getDevice(ctx, id);
  const tokenWarning = TOKEN_WARNING;
  if (!d) return { revoked: false, cancelledCommands: 0, tokenWarning, unpairSent: false, unpairCommandId: null, unpairSentAt: null, unpairReason: "no such device" };
  const unpair = await sendUnpair(ctx, d);
  const keep = unpair.unpairCommandId ?? "";
  const open = ctx.db.prepare("SELECT id, object_key, cmd_deleted FROM commands WHERE device_id = ? AND id <> ? AND status IN ('queued','sent','transferring','uploaded')").all(id, keep) as Array<{ id: string; object_key: string; cmd_deleted: number }>;
  const cmd = ctx.r2()?.bucket("cmd", d.role);
  for (const c of open) {
    if (cmd && !c.cmd_deleted) { try { await cmd.delete(c.object_key); ctx.db.prepare("UPDATE commands SET cmd_deleted = 1 WHERE id = ?").run(c.id); } catch { /* lifecycle is the backstop */ } }
  }
  const at = nowIso();
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE commands SET status = 'cancelled', detail = 'device revoked', status_at = ? WHERE device_id = ? AND id <> ? AND status IN ('queued','sent','transferring','uploaded')").run(at, id, keep);
    ctx.db.prepare("DELETE FROM collector_state WHERE device_id = ?").run(id);
    ctx.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    ctx.db.prepare(`INSERT INTO revoked_devices(id, role, fingerprint, name, revoked_at, unpair_command_id, unpair_sent_at, unpair_detail, unpair_confirmed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT(id) DO UPDATE SET role = excluded.role, fingerprint = excluded.fingerprint, name = excluded.name, revoked_at = excluded.revoked_at,
                      unpair_command_id = excluded.unpair_command_id, unpair_sent_at = excluded.unpair_sent_at, unpair_detail = excluded.unpair_detail, unpair_confirmed_at = NULL`)
      .run(id, d.role, d.fingerprint, d.name, at, unpair.unpairCommandId, unpair.unpairSentAt, unpair.unpairReason);
  })();
  ctx.events.emit("device.revoked", { deviceId: id, role: d.role, fingerprint: d.fingerprint, unpairSent: unpair.unpairSent });
  return { revoked: true, cancelledCommands: open.length, tokenWarning, ...unpair };
}

/** How long a revoked or forgotten device stays in the Devices page's "Recently removed" list. */
export const REMOVED_LIST_MS = 30 * 24 * 3600_000;

export interface RemovedDevice {
  id: string; role: Role; name: string | null; fingerprint: string; removedAt: string; kind: "revoked" | "forgotten";
  unpairSentAt: string | null; unpairConfirmedAt: string | null; unpairDetail: string | null;
}

/** Devices revoked or forgotten in the last 30 days, newest first, with whether each confirmed its reset. */
export function listRemovedDevices(ctx: Ctx, now = Date.now()): RemovedDevice[] {
  const since = new Date(now - REMOVED_LIST_MS).toISOString();
  return ctx.db.prepare(`
    SELECT id, role, name, fingerprint, revoked_at AS removedAt, 'revoked' AS kind, unpair_sent_at AS unpairSentAt,
           unpair_confirmed_at AS unpairConfirmedAt, unpair_detail AS unpairDetail FROM revoked_devices WHERE revoked_at >= @since
    UNION ALL
    SELECT id, role, name, fingerprint, forgotten_at AS removedAt, 'forgotten' AS kind, unpair_sent_at AS unpairSentAt,
           unpair_confirmed_at AS unpairConfirmedAt, unpair_detail AS unpairDetail FROM forgotten_devices WHERE forgotten_at >= @since
    ORDER BY removedAt DESC`).all({ since }) as RemovedDevice[];
}
