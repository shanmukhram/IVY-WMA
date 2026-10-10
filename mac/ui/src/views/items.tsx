/** One record as a passage with source chips and direct access (Q4), shared by search, timeline and lists. */
import { href } from "../router.ts";
import { Chip, DeviceChip, Link, Time, bytes } from "../ui.tsx";

export interface Item {
  type: string; id: string; deviceId: string | null; app: string | null;
  eventTime: string | null; timeField: string | null; capturedAt: string | null;
  title: string | null; body: string | null; person: string | null;
  detail: Record<string, any>;
  match?: "exact" | "fuzzy"; typos?: number; snippet?: string | null; snippetHtml?: string | null;
  ocrText?: string | null;
}
export interface DeviceLite { id: string; role: string }

export const AVAILABILITY: Record<string, string> = {
  reference: "reference only (original on the device)",
  preview: "preview cached (original on the device)",
  local: "local copy",
  stale_local: "older local copy (current version on the device)",
};

const TYPE_LABEL: Record<string, string> = {
  message: "Message", notification: "Notification", screenshot: "Screenshot", photo: "Photo", file: "File", usage: "App usage", call: "Call",
  browsing: "Google activity",
};

export function ItemRow({ it, devices, onBin }: { it: Item; devices?: DeviceLite[]; onBin?: (it: Item) => void }) {
  const d = it.detail ?? {};
  const account = d.account as string | undefined;
  return (
    <article className="item" data-type={it.type} data-testid={`item-${it.type}`}>
      <div className="item-head">
        <strong>{TYPE_LABEL[it.type] ?? it.type}</strong>
        <Time at={it.eventTime} field={it.timeField} captured={it.capturedAt} imported={d.importedAt} />
        {it.type !== "browsing" && <DeviceChip id={it.deviceId} devices={devices} />}
        {it.app && <Chip kind="app">{it.app}</Chip>}
        {account && <Chip kind="account">{account}</Chip>}
        {it.type === "notification" && <Chip kind="partial">preview · partial record</Chip>}
        {it.type === "browsing" && <Chip kind="ref">Activity Vault import</Chip>}
        {it.match === "fuzzy" && <Chip kind="fuzzy">close match{it.typos ? ` (${it.typos} edit${it.typos > 1 ? "s" : ""})` : ""}</Chip>}
        {d.sourceStatus === "deleted_at_source" && <Chip kind="warn">deleted at source</Chip>}
        <span className="spacer" />
        {onBin && <button className="small" onClick={() => onBin(it)}>Move to bin</button>}
      </div>
      <div className="item-body">
        {(it.type === "screenshot" || it.type === "photo") && d.thumbUrl && (
          <Link to={href("/media", { focus: it.id })}><img className="thumb" src={d.thumbUrl} alt={`${it.type} ${it.title ?? ""}`} loading="lazy" /></Link>
        )}
        <div>
          <div className="item-title">{titleOf(it)}</div>
          {it.snippetHtml != null
            ? <p className="snippet" dangerouslySetInnerHTML={{ __html: it.snippetHtml }} />
            : it.body ? <p className="snippet">{it.body}</p> : null}
          <Access it={it} />
        </div>
      </div>
    </article>
  );
}

function titleOf(it: Item): string {
  const d = it.detail ?? {};
  if (it.type === "message") return `${d.platform ?? it.app ?? ""} · ${it.title ?? ""}${it.person ? ` · from ${it.person}` : ""}`;
  if (it.type === "notification") return `${it.title ?? "(no title)"}${it.person ? ` · ${it.person}` : ""}`;
  if (it.type === "call") return `${d.direction ?? ""} call · ${it.title ?? d.number ?? ""} · ${d.durationS ?? 0}s`;
  if (it.type === "usage") return `${it.app ?? ""}${d.endedAt ? ` until ${new Date(d.endedAt).toLocaleTimeString()}` : ""}${d.titleState === "excluded" ? " · title excluded" : ""}`;
  return it.title ?? it.id;
}

function Access({ it }: { it: Item }) {
  const d = it.detail ?? {};
  if (it.type === "message" && d.conversationId) {
    return <p className="small"><Link to={href(`/conversations/${d.conversationId}`, { around: it.id })}>Open thread at this message</Link>{d.attachments ? ` · ${d.attachments} attachment(s)` : ""}</p>;
  }
  if (it.type === "file") {
    return (
      <p className="small">
        <Chip kind={d.availability === "local" ? "ok" : "ref"}>{AVAILABILITY[d.availability] ?? d.availability}</Chip>{" "}
        {bytes(d.size)} · <Link to={href("/files", { focus: it.id })}>Open file entry</Link>
        {d.contentUrl && <> · <a href={d.contentUrl} target="_blank" rel="noreferrer">Open local copy</a></>}
      </p>
    );
  }
  if (it.type === "notification") {
    return <p className="small"><Link to={href("/notifications", { app: it.app ?? undefined })}>All {it.app} notifications</Link>{d.linkedMessageId ? ` · linked message (${d.linkConfidence ?? "uncertain"})` : ""}</p>;
  }
  if (it.type === "browsing") {
    // the link is captured activity data: shown as text, opened only in a new window with no referrer
    return d.link ? <p className="small">{d.subtitle ? `${d.subtitle} · ` : ""}<a href={String(d.link)} target="_blank" rel="noreferrer noopener" className="mono">{String(d.link)}</a></p> : d.subtitle ? <p className="small">{d.subtitle}</p> : null;
  }
  if (it.type === "screenshot" || it.type === "photo") {
    return <p className="small"><Link to={href("/media", { focus: it.id })}>Open in media</Link>{d.ocrStatus && d.ocrStatus !== "done" ? ` · OCR ${d.ocrStatus}` : ""}{!d.original ? " · original not yet received" : ""}</p>;
  }
  return null;
}
