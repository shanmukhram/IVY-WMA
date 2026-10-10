/**
 * Object-key layout for the four buckets.
 *
 *   ivy-up-windows / ivy-up-android  (device -> Mac):
 *     up/<prefix>/<oid>                 one capture record (file, scr, usg, ...)
 *     up/blob/<oid>/manifest            chunked-object manifest (trailer)
 *     up/blob/<oid>/p/<nnnnnnnn>        one encrypted chunk part (zero-padded index)
 *     up/status/<oid>                   device heartbeat / collector-state report
 *     up/cstat/<oid>                    command-status report (references a command id)
 *     pair/<pairingId>/device           pairing: device's public key, wrapped to Mac
 *
 *   ivy-cmd-windows / ivy-cmd-android (Mac -> device):
 *     cmd/<oid>                         one command (file_request, rescan, config)
 *     pair/<pairingId>                  pairing bootstrap, encrypted to the one-time secret
 *
 * oids are time-ordered, so a listing "since marker M" is every key whose oid
 * sorts after M. Prefixes let a reader page one kind at a time.
 */
import type { Kind } from "./kinds.js";
import { kindPrefix } from "./kinds.js";
import { OID_LEN } from "./oid.js";

export const CHUNK_INDEX_PAD = 8;

export interface ParsedKey {
  area: "up" | "cmd" | "pair";
  kind?: Kind;
  oid?: string;
  pairingId?: string;
  /** for blob keys: "manifest" or a chunk */
  blobPart?: "manifest" | "chunk";
  chunkIndex?: number;
}

/** Up-bucket key for a single capture record of the given kind. */
export function upKey(kind: Kind, oid: string): string {
  if (kind === "manifest" || kind === "blob_chunk" || kind === "pairing_device") {
    throw new Error(`use the dedicated builder for kind ${kind}`);
  }
  return `up/${kindPrefix(kind)}/${oid}`;
}

/** Up-bucket key for a chunked object's manifest/trailer. */
export function blobManifestKey(oid: string): string {
  return `up/blob/${oid}/manifest`;
}

/** Up-bucket key for a single chunk part. */
export function blobChunkKey(oid: string, index: number): string {
  return `up/blob/${oid}/p/${String(index).padStart(CHUNK_INDEX_PAD, "0")}`;
}

/** Up-bucket key for a command-status report. */
export function statusReportKey(oid: string): string {
  return `up/cstat/${oid}`;
}

/** Up-bucket key for a device heartbeat / collector-state report. */
export function deviceReportKey(oid: string): string {
  return `up/status/${oid}`;
}

/** Up-bucket key for the device half of pairing. */
export function pairingDeviceKey(pairingId: string): string {
  return `pair/${pairingId}/device`;
}

/** Cmd-bucket key for a command. */
export function cmdKey(oid: string): string {
  return `cmd/${oid}`;
}

/** Cmd-bucket key for the pairing bootstrap. */
export function pairingBootstrapKey(pairingId: string): string {
  return `pair/${pairingId}`;
}

const PREFIX_TO_KIND: Record<string, Kind> = {
  file: "file_meta",
  scr: "screenshot",
  usg: "usage_event",
  wnotif: "windows_notification",
  anotif: "android_notification",
  call: "call",
  msg: "message_batch",
  lineacct: "line_account",
  cstat: "command_status",
  status: "device_report",
};

export function parseKey(key: string): ParsedKey {
  const parts = key.split("/");
  if (parts[0] === "pair") {
    if (parts.length === 2) return { area: "pair", pairingId: parts[1] };
    if (parts.length === 3 && parts[2] === "device") {
      return { area: "pair", kind: "pairing_device", pairingId: parts[1] };
    }
    throw new Error(`unrecognised pair key: ${key}`);
  }
  if (parts[0] === "cmd" && parts.length === 2) {
    return { area: "cmd", kind: "command", oid: parts[1] };
  }
  if (parts[0] === "up") {
    const seg = parts[1];
    if (seg === "blob") {
      const oid = parts[2];
      if (parts[3] === "manifest" && parts.length === 4) {
        return { area: "up", kind: "manifest", oid, blobPart: "manifest" };
      }
      if (parts[3] === "p" && parts.length === 5) {
        return {
          area: "up",
          kind: "blob_chunk",
          oid,
          blobPart: "chunk",
          chunkIndex: parseInt(parts[4]!, 10),
        };
      }
      throw new Error(`unrecognised blob key: ${key}`);
    }
    const kind = seg ? PREFIX_TO_KIND[seg] : undefined;
    if (kind && parts.length === 3) {
      return { area: "up", kind, oid: parts[2] };
    }
  }
  throw new Error(`unrecognised object key: ${key}`);
}

/**
 * Compare two oids for "since marker" listing. Returns true if `oid` is strictly
 * after `marker` (i.e. should be ingested). oids are fixed-length so plain string
 * comparison is correct.
 */
export function oidAfter(oid: string, marker: string): boolean {
  if (oid.length !== OID_LEN || marker.length !== OID_LEN) {
    throw new Error("oids must be 26 chars");
  }
  return oid > marker;
}
