/** Mac -> device commands: wrapped to the paired device's public key, written to ivy-cmd-<role>. */
import { randomUUID } from "node:crypto";
import { cmdKey, encryptEnvelope, fromBase64, newOid, utf8, validateRecordKind } from "@ivy/protocol";
import type { CommandRecordT } from "@ivy/protocol";
import { Bucket } from "./s3.ts";
import { readPublicIdentity, requireState, writeCommand, type CommandFile, type DeviceEntry, type State } from "./local.ts";
import { withEndpoint } from "./endpoint.ts";

export type CommandParams = CommandRecordT["params"];

export function pickDevice(state: State, deviceId?: string): DeviceEntry {
  const mine = state.devices.filter((d) => d.role === state.role);
  if (deviceId) {
    const d = mine.find((x) => x.deviceId === deviceId);
    if (!d) throw new Error(`no paired ${state.role} device ${deviceId}; paired: ${mine.map((x) => x.deviceId).join(", ") || "none"}`);
    return d;
  }
  const d = [...mine].sort((a, b) => a.pairedAt.localeCompare(b.pairedAt)).pop();
  if (!d) throw new Error(`no paired ${state.role} device yet; pair one with the code printed by \`serve\``);
  return d;
}

export interface SentCommand { key: string; oid: string; commandId: string; deviceId: string; record: CommandRecordT; live: boolean }

export async function sendCommand(root: string, params: CommandParams, opts: { deviceId?: string } = {}): Promise<SentCommand> {
  const state = requireState(root);
  readPublicIdentity(root); // the root must hold a Mac identity
  const device = pickDevice(state, opts.deviceId);
  const oid = newOid();
  const key = cmdKey(oid);
  const now = new Date().toISOString();
  const record = validateRecordKind("command", {
    v: 1, kind: "command", deviceId: device.deviceId, eventTime: now, captureTime: now,
    commandId: randomUUID(), issuedAt: now, params,
  });
  const envelope = encryptEnvelope({
    recipientPublicKey: fromBase64(device.publicKey), kind: "command", objectKey: key, plaintext: utf8(JSON.stringify(record)),
  });
  const live = await withEndpoint(root, state, async (endpoint, live) => {
    const cmd = new Bucket(endpoint, state.buckets.cmd, state.tokens.mac);
    try { await cmd.put(key, envelope); } finally { cmd.close(); }
    return live;
  });
  const file: CommandFile = {
    oid, key, commandId: record.commandId, deviceId: device.deviceId, role: state.role, issuedAt: now,
    params: record.params as CommandFile["params"],
  };
  writeCommand(root, file);
  return { key, oid, commandId: record.commandId, deviceId: device.deviceId, record, live };
}
