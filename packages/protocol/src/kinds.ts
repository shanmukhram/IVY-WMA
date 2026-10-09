/**
 * Record-kind registry. Every encrypted object declares a kind. The kind is
 * bound into the envelope AAD (so an object cannot be reinterpreted as another
 * kind) and selects the key prefix in the up/cmd buckets.
 *
 * `id` is the single AAD byte; `prefix` is the object-key path segment. Both are
 * normative and shared across ports. Append-only: never reuse an id.
 */
export const KINDS = {
  file_meta:           { id: 0x01, prefix: "file" },
  screenshot:          { id: 0x02, prefix: "scr" },
  usage_event:         { id: 0x03, prefix: "usg" },
  windows_notification:{ id: 0x04, prefix: "wnotif" },
  android_notification:{ id: 0x05, prefix: "anotif" },
  call:                { id: 0x06, prefix: "call" },
  message_batch:       { id: 0x07, prefix: "msg" },
  manifest:            { id: 0x08, prefix: "blob" },
  blob_chunk:          { id: 0x09, prefix: "blob" },
  command:             { id: 0x0a, prefix: "cmd" },
  command_status:      { id: 0x0b, prefix: "cstat" },
  device_report:       { id: 0x0c, prefix: "status" },
  pairing_device:      { id: 0x0d, prefix: "pair" },
} as const;

export type Kind = keyof typeof KINDS;

export function kindId(kind: Kind): number {
  return KINDS[kind].id;
}

export function kindById(id: number): Kind {
  for (const k of Object.keys(KINDS) as Kind[]) {
    if (KINDS[k].id === id) return k;
  }
  throw new Error(`unknown kind id 0x${id.toString(16)}`);
}

export function kindPrefix(kind: Kind): string {
  return KINDS[kind].prefix;
}
