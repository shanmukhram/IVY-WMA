/** Small shared pieces: status dot, times, chips, pager, errors. */
import type { ReactNode } from "react";
import { errText } from "./api.ts";
import { navigate } from "./router.ts";

export type DotColor = "green" | "amber" | "red" | "off";
export function Dot({ s, label }: { s: DotColor | string; label?: string }) {
  return <span className={`dot dot-${s}`} role="img" aria-label={label ?? `status ${s}`} title={label ?? s} />;
}

export function fmtTime(iso: string | null | undefined, withDate = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withDate ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}` : t;
}

/** Original event time, with the capture/import time on hover (T4). */
export function Time({ at, field, captured, imported, withDate = true }: { at: string | null | undefined; field?: string | null; captured?: string | null; imported?: string | null; withDate?: boolean }) {
  const hover = [
    field ? `original time (${field}): ${fmtTime(at)}` : `time: ${fmtTime(at)}`,
    captured ? `captured: ${fmtTime(captured)}` : null,
    imported ? `imported: ${fmtTime(imported)}` : null,
  ].filter(Boolean).join("\n");
  return <time className="mono" dateTime={at ?? undefined} title={hover}>{fmtTime(at, withDate)}</time>;
}

export function Chip({ children, kind }: { children: ReactNode; kind?: string }) {
  return <span className={`chip${kind ? ` chip-${kind}` : ""}`}>{children}</span>;
}

export function Mono({ children }: { children: ReactNode }) { return <span className="mono">{children}</span>; }

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="error" role="alert">{errText(error)}</p>;
}

export function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p>; }

export function Pager({ page, pages, onPage, total }: { page: number; pages: number; total?: number; onPage: (p: number) => void }) {
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>page {page} of {pages}{total !== undefined ? ` · ${total} total` : ""}</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(to); }}>{children}</a>;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

/** Device chip: role + short id. */
export function DeviceChip({ id, devices }: { id: string | null; devices?: Array<{ id: string; role: string }> }) {
  const d = devices?.find((x) => x.id === id);
  return <Chip kind="device">{d ? `${d.role} ${shortId(id)}` : id ? `device ${shortId(id)}` : "no device"}</Chip>;
}
