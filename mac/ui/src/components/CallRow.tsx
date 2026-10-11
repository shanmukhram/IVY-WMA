/** A call event carried as a message (PROTOCOL.md §6): a handset or camera icon and a short label. */
import { Icon } from "./Icon.tsx";

export interface MsgCall { kind: string; outcome: string; durationSec?: number; direction?: string }

/** A call's length: m:ss, or h:mm:ss from an hour up. */
export function callDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** The short label for a call ("Audio call · 2:35", "Missed audio call", ...). */
export function callLabel(c: MsgCall): string {
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

/** The call row shown in place of the message text: a handset or camera icon, then the label. */
export function CallRow({ call }: { call: MsgCall }) {
  return (
    <span className="call-row" data-testid="call-row" data-call-kind={call.kind} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Icon name={call.kind === "video" ? "video" : "call"} size={14} />
      <span>{callLabel(call)}</span>
    </span>
  );
}
