/** Request-original state per file (F2/F3), driven by the command view and by live events. */
import type { ServiceEvent } from "./events.ts";

export interface CommandView {
  id: string; fileId: string | null; status: string; display: string; waitingOn: "mac" | "device" | "transfer" | null;
  detail: string | null; resultOid: string | null; lastError?: string | null;
  progress: { committedParts: number; totalChunks: number | null; committedBytes: number; totalSize: number | null } | null;
}

export interface RequestState {
  commandId: string;
  phase: "queued" | "in_progress" | "done" | "failed";
  status: string;
  waitingOn: CommandView["waitingOn"];
  resultOid: string | null;
  bytes: number | null;
  total: number | null;
  detail: string | null;
}

const FAILED = new Set(["not_found", "access_denied", "too_large", "error", "expired", "cancelled"]);

export function phaseOf(status: string): RequestState["phase"] {
  if (status === "queued" || status === "sent") return "queued";
  if (status === "uploaded") return "in_progress";
  if (status === "done") return "done";
  return FAILED.has(status) ? "failed" : "queued";
}

export function fromCommand(c: CommandView): RequestState {
  return {
    commandId: c.id, phase: phaseOf(c.status), status: c.status, waitingOn: c.waitingOn, resultOid: c.resultOid,
    bytes: c.progress?.committedBytes ?? null, total: c.progress?.totalSize ?? null, detail: c.detail ?? c.lastError ?? null,
  };
}

/** Apply one service event to a request; returns the same object when it does not concern it. */
export function applyEvent(s: RequestState, ev: ServiceEvent): RequestState {
  const d = ev.data ?? {};
  if (ev.type === "command.sent" && d.commandId === s.commandId) return { ...s, status: "sent", phase: "queued", waitingOn: "device" };
  if (ev.type === "command.status" && d.commandId === s.commandId && typeof d.status === "string") {
    const st = d.status as string;
    return { ...s, status: st, phase: phaseOf(st), waitingOn: st === "uploaded" ? "transfer" : null, resultOid: (d.resultOid as string) ?? s.resultOid, detail: (d.detail as string) ?? s.detail };
  }
  if (ev.type === "command.cancelled" && d.commandId === s.commandId) return { ...s, status: "cancelled", phase: "failed" };
  if ((ev.type === "blob.progress" || ev.type === "blob.complete") && s.resultOid && d.oid === s.resultOid && s.phase !== "done") {
    return { ...s, phase: "in_progress", bytes: (d.committedBytes as number) ?? s.bytes, total: (d.totalSize as number) ?? s.total };
  }
  if ((ev.type === "command.completed" || ev.type === "file.cached") && d.commandId === s.commandId) {
    return { ...s, phase: "done", status: "done", waitingOn: null, bytes: s.total ?? s.bytes };
  }
  return s;
}

export function describe(s: RequestState): string {
  if (s.phase === "queued") return s.waitingOn === "mac" ? "queued on the Mac (not yet written to R2)" : "queued: waiting for the device (picked up when it is online)";
  if (s.phase === "in_progress") {
    if (s.bytes !== null && s.total) return `in progress: ${s.bytes} of ${s.total} bytes (${Math.round((s.bytes / s.total) * 100)}%)`;
    return "in progress: the device uploaded it; transferring";
  }
  if (s.phase === "done") return "done: local copy available";
  return `failed: ${s.status}${s.detail ? ` (${s.detail})` : ""}`;
}
