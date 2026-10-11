/**
 * Call events carried as messages (LINE call records, PROTOCOL.md §6): the stored columns, the `call`
 * object the UI reads, and the short label shown in place of the platform's own system text.
 * The label wording matches the UI's callLabel in mac/ui/src/components/CallRow.tsx.
 */

/** The stored call columns of a message (all null for an ordinary message). */
export type CallCols = { call_kind: string | null; call_outcome: string | null; call_duration_s: number | null; call_direction: string | null };

export interface CallView { kind: string; outcome: string; durationSec?: number; direction?: string }

/** The message's `call` object as the UI reads it, or null when the message is not a call. */
export function callView(r: CallCols): CallView | null {
  if (r.call_kind == null) return null;
  return {
    kind: r.call_kind, outcome: r.call_outcome ?? "unknown",
    ...(r.call_duration_s != null ? { durationSec: r.call_duration_s } : {}),
    ...(r.call_direction != null ? { direction: r.call_direction } : {}),
  };
}

/** A call's length: m:ss, or h:mm:ss from an hour up. */
export function callDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** "Audio call · 2:35", "Missed video call", ... */
export function callLabel(c: CallView): string {
  const noun = c.kind === "audio" ? "audio call" : c.kind === "video" ? "video call" : "call";
  const Noun = noun[0]!.toUpperCase() + noun.slice(1);
  switch (c.outcome) {
    case "completed": return c.durationSec != null ? `${Noun} · ${callDuration(c.durationSec)}` : Noun;
    case "missed": return `Missed ${noun}`;
    case "declined": return `Declined ${noun}`;
    case "cancelled": return `Cancelled ${noun}`;
    default: return Noun;
  }
}
