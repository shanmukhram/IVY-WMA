/** Status and feedback: dots, badges, progress, empty states, notices, pager, original/capture time. */
import type { ReactNode } from "react";
import { errText } from "../api.ts";
import { fmtTime, friendlyTime, hm } from "../format.ts";
import { Icon, type IconName } from "./Icon.tsx";

export type DotColor = "green" | "amber" | "red" | "off";
export function Dot({ s, label }: { s: DotColor | string; label?: string }) {
  return <span className={`dot dot-${s}`} role="img" aria-label={label ?? `status ${s}`} title={label ?? s} />;
}

export function Badge({ children, tone, title }: { children: ReactNode; tone?: "green" | "amber" | "red" | "blue" | "purple"; title?: string }) {
  return <span className={`badge${tone ? ` badge-${tone}` : ""}`} title={title}>{children}</span>;
}

export function Progress({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Empty({ icon = "inbox", title, children, action }: { icon?: IconName | string; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" role="note">
      <span className="empty-icon"><Icon name={icon} size={36} /></span>
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone, children, role }: { tone?: "warn" | "error" | "ok"; children: ReactNode; role?: string }) {
  const icon = tone === "ok" ? "check" : tone === "error" || tone === "warn" ? "warn" : "info";
  return <div className={`notice${tone ? ` notice-${tone}` : ""}`} role={role}><Icon name={icon} /><div>{children}</div></div>;
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <Notice tone="error" role="alert">{errText(error)}</Notice>;
}

export function Pager({ page, pages, onPage, total }: { page: number; pages: number; total?: number; onPage: (p: number) => void }) {
  return (
    <nav className="pager" aria-label="Pages">
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>Page {page} of {pages}{total !== undefined ? ` · ${total} total` : ""}</span>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}

/** Original event time, with capture and import times on hover (T4). */
export function Time({ at, field, captured, imported, withDate = true, short }: {
  at: string | null | undefined; field?: string | null; captured?: string | null; imported?: string | null; withDate?: boolean; short?: boolean;
}) {
  const hover = [
    field ? `original time (${field}): ${fmtTime(at)}` : `time: ${fmtTime(at)}`,
    captured ? `captured: ${fmtTime(captured)}` : null,
    imported ? `imported: ${fmtTime(imported)}` : null,
  ].filter(Boolean).join("\n");
  return <time className="tnum" dateTime={at ?? undefined} title={hover}>{short ? hm(at) : withDate ? friendlyTime(at) : fmtTime(at, false)}</time>;
}
