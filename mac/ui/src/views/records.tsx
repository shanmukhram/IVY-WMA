/**
 * One record as a card (search results, notification stream, per-device lists), and the same
 * record in a sheet (AI record chips). Direct access to the record (Q4), source and capture
 * time kept apart (T4), file availability (F4), deleted at source vs in the vault (B4).
 */
import { createContext, useContext } from "react";
import { deviceLabel } from "../scope.tsx";
import { href } from "../router.ts";
import { Icon, TYPE_ICON } from "../components/Icon.tsx";
import { AppIcon } from "../components/AppIcon.tsx";
import { Link } from "../components/Controls.tsx";
import { CallRow, type MsgCall } from "../components/CallRow.tsx";
import { Badge, Time } from "../components/Feedback.tsx";
import { Sheet } from "../components/Overlay.tsx";
import { TYPE_LABEL, bytes, hm, platformLabel, roleLabel, shortId } from "../format.ts";

export interface Item {
  type: string; id: string; deviceId: string | null; app: string | null;
  eventTime: string | null; timeField: string | null; capturedAt: string | null;
  title: string | null; body: string | null; person: string | null;
  detail: Record<string, any>;
  match?: "exact" | "fuzzy"; typos?: number; snippet?: string | null; snippetHtml?: string | null;
  ocrText?: string | null;
  /** set on a message that is a call event; body is then already the call label */
  call?: MsgCall | null;
}
export interface DeviceLite { id: string; role: string; fingerprint?: string; name?: string | null }

export const AVAILABILITY: Record<string, string> = {
  reference: "reference only (original on the device)",
  preview: "preview cached (original on the device)",
  local: "local copy",
  stale_local: "older local copy (current version on the device)",
};
export const AVAILABILITY_SHORT: Record<string, string> = { reference: "Reference only", preview: "Preview cached", local: "Local copy", stale_local: "Older local copy" };

/** Paired devices, provided once by the shell so every card can name the device. */
export const DevicesContext = createContext<DeviceLite[] | undefined>(undefined);

/** A record's device: the owner's name for it when set, else the role (with a short id when the role has several devices). */
export function deviceName(id: string | null, devices?: DeviceLite[]): string {
  const d = devices?.find((x) => x.id === id);
  if (!d) return id ? `device ${shortId(id)}` : "no device";
  if (d.name?.trim()) return deviceLabel(d);
  const sameRole = devices!.filter((x) => x.role === d.role).length;
  return sameRole > 1 ? `${roleLabel(d.role)} ${shortId(id)}` : roleLabel(d.role);
}

export function titleOf(it: Item): string {
  const d = it.detail ?? {};
  if (it.type === "message") { const who = it.person && it.person === d.account ? "You" : it.person; return `${it.title ?? ""}${who && who !== it.title ? ` · ${who}` : ""}`; }
  if (it.type === "notification") return `${it.title ?? "(no title)"}${it.person && it.person !== it.title ? ` · ${it.person}` : ""}`;
  if (it.type === "call") return `${d.direction ? `${String(d.direction)[0]!.toUpperCase()}${String(d.direction).slice(1)} call` : "Call"} · ${it.title ?? d.number ?? ""} · ${d.durationS ?? 0}s`;
  if (it.type === "usage") return `${it.app ?? ""}${d.endedAt ? ` until ${hm(d.endedAt)}` : ""}${d.titleState === "excluded" ? " · title excluded" : ""}`;
  if (it.type === "screenshot" || it.type === "photo" || it.type === "file") {
    const t = it.detail?.name ?? it.title ?? it.id;
    return String(t).split(/[\\/]/).pop() || String(t);
  }
  return it.title ?? it.id;
}

/** Where a record opens: the chat at the message, the file entry, the media lightbox, ... */
export function recordHref(it: Item): string | null {
  const d = it.detail ?? {};
  if (it.type === "message" && d.conversationId) return href("/conversations", { chat: d.conversationId, around: it.id });
  if (it.type === "file") return href("/files", { focus: it.id });
  if (it.type === "screenshot" || it.type === "photo") return href("/media", { focus: it.id });
  if (it.type === "notification") return href("/notifications", { app: it.app ?? undefined });
  return null;
}

function Badges({ it, devices, hideType }: { it: Item; devices?: DeviceLite[]; hideType?: boolean }) {
  const d = it.detail ?? {};
  const ctxDevices = useContext(DevicesContext);
  devices ??= ctxDevices;
  return (
    <>
      {!hideType && <Badge>{TYPE_LABEL[it.type] ?? it.type}</Badge>}
      {it.type !== "browsing" && <Badge title={it.deviceId ?? undefined}>{deviceName(it.deviceId, devices)}</Badge>}
      {it.app && <Badge><AppIcon app={it.app} size={14} />{it.type === "message" ? platformLabel(it.app) : it.app}</Badge>}
      {d.account && <Badge>{d.account}</Badge>}
      {it.type === "notification" && <Badge tone="amber">preview · partial record</Badge>}
      {it.type === "browsing" && <Badge tone="purple">Activity Vault import</Badge>}
      {it.match === "fuzzy" && <Badge tone="blue">close match{it.typos ? ` (${it.typos} edit${it.typos > 1 ? "s" : ""})` : ""}</Badge>}
      {d.sourceStatus === "deleted_at_source" && <Badge tone="red">deleted at source</Badge>}
      {it.type === "file" && <Badge tone={d.availability === "local" ? "green" : undefined}>{AVAILABILITY[d.availability] ?? d.availability}</Badge>}
    </>
  );
}

function Access({ it, inList }: { it: Item; inList?: boolean }) {
  const d = it.detail ?? {};
  const to = recordHref(it);
  if (inList && it.type === "notification") return d.linkedMessageId ? <span className="faint">linked message ({d.linkConfidence ?? "uncertain"})</span> : null;
  if (it.type === "message" && to) return <Link to={to}>Open thread at this message</Link>;
  if (it.type === "file") {
    return (
      <>
        <span className="faint">{bytes(d.size)}</span>
        <Link to={to!}>Open file entry</Link>
        {d.contentUrl && <a href={d.contentUrl} target="_blank" rel="noreferrer">Open local copy</a>}
      </>
    );
  }
  if (it.type === "notification") return <><Link to={to!}>All {it.app} notifications</Link>{d.linkedMessageId ? <span className="faint">linked message ({d.linkConfidence ?? "uncertain"})</span> : null}</>;
  if (it.type === "browsing") {
    // the link is captured activity data: shown as text, opened only in a new window with no referrer
    return d.link ? <>{d.subtitle ? <span className="faint">{d.subtitle}</span> : null}<a href={String(d.link)} target="_blank" rel="noreferrer noopener" className="ellipsis">{String(d.link)}</a></> : d.subtitle ? <span className="faint">{d.subtitle}</span> : null;
  }
  if (it.type === "screenshot" || it.type === "photo") {
    return <><Link to={to!}>Open in Media</Link>{d.ocrStatus && d.ocrStatus !== "done" ? <span className="faint">OCR {d.ocrStatus}</span> : null}{!d.original ? <span className="faint">original not yet received</span> : null}</>;
  }
  return null;
}

/** Messages, notifications and Google activity show their app; other records their type glyph. */
export function RecordIcon({ it, small }: { it: Pick<Item, "type" | "app">; small?: boolean }) {
  const byApp = (it.type === "message" || it.type === "notification" || it.type === "browsing" || it.type === "usage") && it.app;
  return (
    <span className={`${small ? "ev-icon" : "rec-icon"} t-${it.type}`}>
      {byApp ? <AppIcon app={it.app} size={small ? 16 : 20} /> : <Icon name={TYPE_ICON[it.type] ?? "info"} size={small ? 13 : 16} />}
    </span>
  );
}

export function RecordCard({ it, devices, onBin, inList }: { it: Item; devices?: DeviceLite[]; onBin?: (it: Item) => void; inList?: boolean }) {
  const d = it.detail ?? {};
  const isMedia = it.type === "screenshot" || it.type === "photo";
  return (
    <article className="rec" data-type={it.type} data-testid={`item-${it.type}`} aria-label={`${TYPE_LABEL[it.type] ?? it.type}: ${titleOf(it)}`}>
      <RecordIcon it={it} />
      <div className="rec-main">
        <div className="rec-top">
          <span className="rec-title" title={titleOf(it)}>{titleOf(it)}</span>
          <span className="rec-time"><Time at={it.eventTime} field={it.timeField} captured={it.capturedAt} imported={d.importedAt} /></span>
        </div>
        {it.call ? <p className="rec-snippet"><CallRow call={it.call} /></p>
          : it.snippetHtml != null
          ? <p className="rec-snippet" dangerouslySetInnerHTML={{ __html: it.snippetHtml }} />
          : it.body ? <p className="rec-snippet">{it.body}</p> : null}
        <div className="rec-meta"><Badges it={it} devices={devices} hideType={inList} /></div>
        <div className="rec-actions"><Access it={it} inList={inList} />{onBin && <button className="btn btn-ghost btn-sm rec-more" onClick={() => onBin(it)}>Move to bin</button>}</div>
      </div>
      {isMedia && d.thumbUrl && (
        <Link to={recordHref(it)!} aria-label={`Open ${it.type} in Media`}><img className="rec-thumb" src={d.thumbUrl} alt={`${it.type} ${it.title ?? ""}`} loading="lazy" /></Link>
      )}
    </article>
  );
}

/** A record opened from an AI chip: everything the card shows, plus where it opens. */
export function RecordSheet({ it, onClose, devices }: { it: Item; onClose: () => void; devices?: DeviceLite[] }) {
  const d = it.detail ?? {};
  const ctxDevices = useContext(DevicesContext);
  devices ??= ctxDevices;
  const to = recordHref(it);
  return (
    <Sheet title={TYPE_LABEL[it.type] ?? it.type} label="Opened record" onClose={onClose}
      footer={<>{to && <Link to={to} className="btn btn-primary" onClick={onClose}>Open in place</Link>}<button className="btn" onClick={onClose}>Done</button></>}>
      <div className="stack-sm">
        <h3>{titleOf(it)}</h3>
        <div className="rec-meta"><Badges it={it} devices={devices} /></div>
      </div>
      {(it.type === "screenshot" || it.type === "photo") && d.thumbUrl && <img src={d.thumbUrl} alt={`${it.type} ${it.title ?? ""}`} style={{ borderRadius: 8, maxHeight: 260, objectFit: "contain" }} />}
      {(it.snippet ?? it.body) && <p style={{ whiteSpace: "pre-wrap" }}>{it.snippet ?? it.body}</p>}
      <dl className="kv">
        <dt>Original time</dt><dd><Time at={it.eventTime} field={it.timeField} captured={it.capturedAt} /> {it.timeField ? <span className="faint">({it.timeField})</span> : null}</dd>
        {it.capturedAt && <><dt>Captured</dt><dd><Time at={it.capturedAt} /></dd></>}
        {d.importedAt && <><dt>Imported</dt><dd><Time at={d.importedAt} /></dd></>}
        {it.deviceId && <><dt>Device</dt><dd>{deviceName(it.deviceId, devices)}</dd></>}
        {d.platform && <><dt>App</dt><dd>{platformLabel(d.platform)}{d.account ? ` · ${d.account}` : ""}</dd></>}
        {Array.isArray(d.sources) && d.sources.length > 0 && <><dt>Sources</dt><dd>{(d.sources as string[]).join(", ")}</dd></>}
        {d.path && <><dt>Path</dt><dd className="path">{d.path}</dd></>}
        {d.sourcePath && <><dt>Path</dt><dd className="path">{d.sourcePath}</dd></>}
      </dl>
      {(it.type === "file" || it.type === "browsing") && <div className="rec-actions"><Access it={it} /></div>}
    </Sheet>
  );
}

