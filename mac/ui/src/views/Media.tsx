import { useState } from "react";
import { errText } from "../api.ts";
import { useApi, useDebounced, useEvents, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { Chip, Empty, ErrorLine, Link, Mono, Pager, Time } from "../ui.tsx";
import type { Item } from "./items.tsx";

export function MediaView() {
  const api = useApi();
  const { query } = useLocation();
  const kind = query.get("kind") ?? "";
  const page = Number(query.get("page") ?? 1) || 1;
  const focus = query.get("focus") ?? "";
  const r = useLoad<any>((a) => a.get("/api/media", { kind, page, pageSize: 60 }), [kind, page]);
  const reload = useDebounced(r.reload, 1000);
  useEvents(() => reload(), ["blob.complete", "ingest.committed", "bin."]);
  const items = (r.data?.items ?? []) as Item[];
  const [msg, setMsg] = useState<string | null>(null);
  const go = (patch: Record<string, string | number | undefined>) => navigate(href("/media", { kind, page, focus, ...patch }));
  const sel = items.find((i) => i.id === focus);
  const bin = async (it: Item) => {
    try { await api.del(`/api/items/${it.type}/${it.id}`); setMsg(`Moved ${it.type} to the recovery bin.`); go({ focus: undefined }); r.reload(); }
    catch (e) { setMsg(errText(e)); }
  };
  return (
    <div>
      <div className="toolbar">
        <label>Kind
          <select value={kind} onChange={(e) => go({ kind: e.target.value || undefined, page: undefined })}>
            <option value="">all</option><option value="screenshot">screenshots</option><option value="photo">photos</option>
          </select>
        </label>
        <span className="small muted">hover a tile for its OCR text; click for details and origin</span>
      </div>
      <ErrorLine error={r.error} />
      {msg && <p className="muted" role="status">{msg}</p>}
      {r.data && r.data.total === 0 && <Empty>No screenshots or photos in the vault yet.</Empty>}
      <div className="media-cols">
        <div className="grid">
          {items.map((it) => (
            <button key={it.id} className={`tile${it.id === focus ? " active" : ""}`} title={it.ocrText || "(no OCR text)"} onClick={() => go({ focus: it.id })} aria-label={`${it.type} ${it.title ?? it.id}`}>
              {it.detail.thumbUrl ? <img src={it.detail.thumbUrl} alt="" loading="lazy" /> : <span className="small muted">no preview yet</span>}
              <span className="small"><Time at={it.eventTime} field={it.timeField} captured={it.capturedAt} imported={it.detail.importedAt} /></span>
            </button>
          ))}
        </div>
        {sel && <MediaPanel it={sel} onBin={() => void bin(sel)} />}
      </div>
      {r.data && r.data.pages > 1 && <Pager page={r.data.page} pages={r.data.pages} total={r.data.total} onPage={(p) => go({ page: p })} />}
    </div>
  );
}

function MediaPanel({ it, onBin }: { it: Item; onBin: () => void }) {
  const d = it.detail;
  const o = useLoad<any>((a) => a.get(`/api/media/${it.id}/origin`), [it.id]);
  return (
    <aside className="panel side" aria-label="Media details">
      {d.contentUrl ? <a href={d.contentUrl} target="_blank" rel="noreferrer"><img className="preview" src={d.thumbUrl ?? d.contentUrl} alt={it.type} /></a> : <p className="muted">Original not received yet.</p>}
      <dl>
        <dt>Kind</dt><dd>{it.type}</dd>
        <dt>Source path</dt><dd><Mono>{d.sourcePath ?? "—"}</Mono></dd>
        <dt>Taken</dt><dd><Time at={d.takenAt} /></dd>
        <dt>Saved</dt><dd><Time at={d.savedAt} /></dd>
        <dt>Captured</dt><dd><Time at={it.capturedAt} /></dd>
        <dt>Imported</dt><dd><Time at={d.importedAt} /></dd>
        <dt>Size</dt><dd>{d.width && d.height ? `${d.width}×${d.height}` : "—"}</dd>
        <dt>OCR</dt><dd>{d.ocrStatus}</dd>
      </dl>
      <h3>OCR text</h3>
      <pre className="ocr">{it.ocrText || "(none)"}</pre>
      <h3>Origin</h3>
      <ErrorLine error={o.error} />
      {o.data && (
        <>
          <h4>Evidenced</h4>
          {o.data.evidenced.length === 0 ? <Empty>No evidence links this image to a message.</Empty> : (
            <ul>{o.data.evidenced.map((e: any) => (
              <li key={e.attachmentId}><Chip kind="ok">evidenced: {e.evidence}</Chip> received via {e.platform} from {e.sender} on <Time at={e.sentAt} /> in{" "}
                <Link to={href(`/conversations/${e.conversationId}`, { around: e.messageId })}>{e.peer ?? "conversation"}</Link> ({e.account})</li>
            ))}</ul>
          )}
          <h4>Inferred</h4>
          {o.data.inferred.length === 0 ? <Empty>No inferred links{o.data.inferenceAvailable === false ? " (inference is not built yet; nothing is guessed)" : ""}.</Empty> : (
            <ul>{o.data.inferred.map((e: any, i: number) => <li key={i}><Chip kind="warn">inferred</Chip> {JSON.stringify(e)}</li>)}</ul>
          )}
        </>
      )}
      <button onClick={onBin}>Move to bin</button>
    </aside>
  );
}
