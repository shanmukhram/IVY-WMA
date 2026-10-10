/**
 * Media gallery (M1-M3, M6, M7): thumbnails grouped by day with sticky day headers, filters by kind
 * and device, a lightbox with prev/next and metadata (OCR text, origin, every time kept apart), and a
 * picker mode with a selection count and bulk actions (request originals, send to the recovery bin).
 */
import { useEffect, useMemo, useState } from "react";
import { errText } from "../api.ts";
import { useApi, useDebounced, useEvents, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { dayKey, dayLabel, fmtTime, platformLabel } from "../format.ts";
import { Icon } from "../components/Icon.tsx";
import { Link, Segmented } from "../components/Controls.tsx";
import { Badge, Empty, ErrorLine, Notice, Pager } from "../components/Feedback.tsx";
import type { Item } from "./records.tsx";

const PAGE = 120;

export interface MediaProps { device?: string; kind?: "screenshot" | "photo"; embedded?: boolean; emptyText?: string }

export function MediaView(props: MediaProps = {}) {
  const api = useApi();
  const loc = useLocation();
  const [st, setSt] = useState({ kind: props.kind ?? "", device: props.device ?? "", page: 1 });
  // standalone: the URL holds the filters (shareable, back button); embedded in a device view: local state
  const kind = props.embedded ? st.kind : props.kind ?? loc.query.get("kind") ?? "";
  const device = props.embedded ? st.device : loc.query.get("device") ?? "";
  const page = props.embedded ? st.page : Number(loc.query.get("page") ?? 1) || 1;
  const focus = props.embedded ? null : loc.query.get("focus");
  const set = (patch: Partial<{ kind: string; device: string; page: number; focus: string | null }>) => {
    if (props.embedded) { setSt((s) => ({ ...s, ...patch } as typeof s)); return; }
    navigate(href("/media", { kind, device, page: page > 1 ? page : undefined, focus: focus ?? undefined, ...patch, ...(patch.focus === null ? { focus: undefined } : {}) }));
  };

  const r = useLoad<any>((a) => a.get("/api/views/records", { type: kind || "screenshot,photo", device, page, pageSize: PAGE }), [kind, device, page]);
  const reload = useDebounced(r.reload, 1000);
  useEvents(() => reload(), ["blob.complete", "ingest.committed", "bin.", "media.ocr"]);
  const items = (r.data?.items ?? []) as Item[];
  const days = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) { const k = dayKey(it.eventTime); m.set(k, [...(m.get(k) ?? []), it]); }
    return [...m.entries()];
  }, [items]);

  const [picking, setPicking] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone?: "ok" | "error" } | null>(null);
  useEffect(() => { if (focus) setOpen(focus); }, [focus]);
  useEffect(() => { setSel(new Set()); }, [kind, device, page]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = items.filter((i) => sel.has(i.id));

  const requestOriginals = async (list: Item[]) => {
    let asked = 0, have = 0, cannot = 0; const errs: string[] = [];
    for (const it of list) {
      if (it.detail?.original) { have++; continue; }
      if (!it.deviceId || !it.detail?.sourcePath) { cannot++; continue; }
      try { await api.post("/api/commands", { deviceId: it.deviceId, params: { type: "file_request", path: it.detail.sourcePath } }); asked++; }
      catch (e) { errs.push(errText(e)); }
    }
    setMsg({ tone: errs.length ? "error" : "ok", text: `Requested ${asked} original(s)${have ? `; ${have} already on this Mac` : ""}${cannot ? `; ${cannot} without a device path` : ""}.${errs.length ? ` Failed: ${errs[0]}` : ""} Originals arrive when the device is online.` });
  };
  const toBin = async (list: Item[]) => {
    let n = 0; const errs: string[] = [];
    for (const it of list) { try { await api.del(`/api/items/${it.type}/${it.id}`); n++; } catch (e) { errs.push(errText(e)); } }
    setMsg({ tone: errs.length ? "error" : "ok", text: `Moved ${n} item(s) to the recovery bin.${errs.length ? ` Failed: ${errs[0]}` : ""}` });
    setSel(new Set()); setOpen(null); r.reload();
  };

  const idx = open ? items.findIndex((i) => i.id === open) : -1;
  const close = () => { setOpen(null); if (focus) set({ focus: null }); };

  return (
    <div className={props.embedded ? "" : "full"} style={props.embedded ? undefined : { display: "block" }}>
      <div className="media-toolbar" style={props.embedded ? { position: "static", padding: "0 0 12px", background: "none", border: 0, backdropFilter: "none" } : undefined}>
        {!props.embedded && <h1 style={{ fontSize: "var(--text-xl)", marginRight: 8 }}>Media</h1>}
        {!props.kind && <Segmented label="Kind" value={kind} onChange={(v) => set({ kind: v, page: 1 })} options={[["", "All"], ["screenshot", "Screenshots"], ["photo", "Photos"]]} />}
        {!props.device && (
          <select className="select" aria-label="Device" value={device} onChange={(e) => set({ device: e.target.value, page: 1 })}>
            <option value="">All devices</option><option value="windows">Windows</option><option value="android">Android</option>
          </select>
        )}
        <span className="spacer" />
        {r.data && <span className="small faint">{r.data.total} item(s)</span>}
        <button className="btn" aria-pressed={picking} onClick={() => { setPicking((v) => !v); setSel(new Set()); }}>{picking ? "Done" : "Select"}</button>
      </div>
      <ErrorLine error={r.error} />
      {msg && <div style={{ padding: props.embedded ? "0 0 12px" : "12px 32px 0" }}><Notice tone={msg.tone} role="status">{msg.text}</Notice></div>}
      {r.data && r.data.total === 0 && (
        <Empty icon="photo" title="No media yet">{props.emptyText ?? "Screenshots and photos appear here as the devices send them. Each one is OCR'd on this Mac so you can search what is written in it."}</Empty>
      )}
      {days.map(([day, its]) => (
        <section key={day} className="media-day" aria-label={day === "unknown" ? "Unknown date" : dayLabel(day)}>
          <h3 style={props.embedded ? { position: "static", padding: "12px 0 8px", background: "none" } : undefined}>
            {day === "unknown" ? "Unknown date" : dayLabel(day)}<span className="faint">{its.length}</span>
          </h3>
          <div className="media-grid" style={props.embedded ? { padding: "0 0 12px" } : undefined}>
            {its.map((it) => (
              <button key={it.id} className="tile" aria-pressed={picking ? sel.has(it.id) : undefined} title={it.ocrText || "(no OCR text)"}
                aria-label={`${it.type} ${it.title ?? it.id}`} onClick={() => (picking ? toggle(it.id) : setOpen(it.id))}>
                {it.detail.thumbUrl ? <img src={it.detail.thumbUrl} alt="" loading="lazy" /> : <span className="tile-none"><Icon name="hourglass" size={18} />no preview yet</span>}
                {it.type === "screenshot" && <span className="tile-kind">Screenshot</span>}
                {picking && <span className="check-circle">{sel.has(it.id) && <Icon name="check" size={13} />}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
      {r.data && r.data.pages > 1 && <Pager page={r.data.page} pages={r.data.pages} total={r.data.total} onPage={(p) => set({ page: p })} />}
      {picking && (
        <div className="picker-bar" role="toolbar" aria-label="Selection">
          <span className="count" data-testid="selection-count">{sel.size} selected</span>
          <button className="btn btn-plain btn-sm" onClick={() => setSel(new Set(sel.size === items.length ? [] : items.map((i) => i.id)))}>{sel.size === items.length && items.length ? "Select none" : "Select all"}</button>
          <button className="btn btn-sm" disabled={!sel.size} onClick={() => void requestOriginals(chosen)}><Icon name="download" size={13} />Request originals</button>
          <button className="btn btn-sm btn-danger" disabled={!sel.size} onClick={() => void toBin(chosen)}><Icon name="trash" size={13} />Move to recovery bin</button>
        </div>
      )}
      {open && (idx >= 0
        ? <Lightbox it={items[idx]!} index={idx} count={items.length} onPrev={() => setOpen(items[idx - 1]?.id ?? open)} onNext={() => setOpen(items[idx + 1]?.id ?? open)}
            onClose={close} onBin={() => void toBin([items[idx]!])} onRequest={() => void requestOriginals([items[idx]!])} />
        : <FocusedLightbox id={open} onClose={close} />)}
    </div>
  );
}

/** A media item that is not on the loaded page (opened from search or the timeline). */
function FocusedLightbox({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useLoad<Item | null>(async (a) => {
    for (const t of ["screenshot", "photo"]) { try { return await a.get<Item>(`/api/items/${t}/${id}`); } catch { /* try the other kind */ } }
    return null;
  }, [id]);
  if (!r.data) return null;
  return <Lightbox it={r.data} index={0} count={1} onPrev={() => undefined} onNext={() => undefined} onClose={onClose} />;
}

function Lightbox({ it, index, count, onPrev, onNext, onClose, onBin, onRequest }: {
  it: Item; index: number; count: number; onPrev: () => void; onNext: () => void; onClose: () => void; onBin?: () => void; onRequest?: () => void;
}) {
  const d = it.detail ?? {};
  const o = useLoad<any>((a) => a.get(`/api/media/${it.id}/origin`), [it.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "ArrowRight") onNext();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose, onPrev, onNext]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Media viewer">
      <div className="lb-stage">
        <button className="btn btn-sm lb-close" onClick={onClose} aria-label="Close viewer" autoFocus><Icon name="close" size={13} />Close</button>
        <span className="lb-count tnum">{index + 1} of {count}</span>
        <button className="lb-nav lb-prev" onClick={onPrev} disabled={index <= 0} aria-label="Previous"><Icon name="chevronLeft" size={18} /></button>
        {d.contentUrl || d.thumbUrl ? <img src={d.contentUrl ?? d.thumbUrl} alt={`${it.type} ${it.title ?? ""}`} /> : <p className="muted">The original has not been received yet.</p>}
        <button className="lb-nav lb-next" onClick={onNext} disabled={index >= count - 1} aria-label="Next"><Icon name="chevronRight" size={18} /></button>
      </div>
      <aside className="lb-side" aria-label="Media details">
        <div className="stack-sm">
          <div className="row"><Badge tone="blue">{it.type}</Badge>{d.ocrStatus && <Badge>OCR {d.ocrStatus}</Badge>}{!d.original && <Badge tone="amber">original not received</Badge>}</div>
          <p className="mono small" style={{ overflowWrap: "anywhere" }}>{d.sourcePath ?? it.title ?? it.id}</p>
        </div>
        <section className="stack-sm">
          <h3>Times</h3>
          <dl className="kv small">
            <dt>Taken</dt><dd className="tnum">{fmtTime(d.takenAt)}</dd>
            <dt>Saved</dt><dd className="tnum">{fmtTime(d.savedAt)}</dd>
            <dt>Captured</dt><dd className="tnum">{fmtTime(it.capturedAt)}</dd>
            <dt>Imported</dt><dd className="tnum">{fmtTime(d.importedAt)}</dd>
            <dt>Size</dt><dd>{d.width && d.height ? `${d.width}×${d.height}` : "—"}</dd>
          </dl>
        </section>
        <section className="stack-sm">
          <h3>Text in the image (OCR)</h3>
          <pre className="ocr">{it.ocrText || "(none)"}</pre>
        </section>
        <section className="stack-sm" aria-label="Origin">
          <h3>Origin</h3>
          <ErrorLine error={o.error} />
          {o.data && (o.data.evidenced.length === 0
            ? <p className="small muted">No evidence links this image to a message.</p>
            : <ul className="stack-sm small">{o.data.evidenced.map((e: any) => (
                <li key={e.attachmentId}><Badge tone="green">evidenced: {e.evidence}</Badge><br />Received via {platformLabel(e.platform)} from {e.sender} on {fmtTime(e.sentAt)} in{" "}
                  <Link to={href("/conversations", { chat: e.conversationId, around: e.messageId })} onClick={onClose}>{e.peer ?? "conversation"}</Link> ({e.account})</li>
              ))}</ul>)}
          {o.data && (o.data.inferred.length === 0
            ? <p className="small muted">No inferred links{o.data.inferenceAvailable === false ? " (inference is not built yet; nothing is guessed)" : ""}.</p>
            : <ul className="small">{o.data.inferred.map((e: any, i: number) => <li key={i}><Badge tone="purple">inferred</Badge> {JSON.stringify(e)}</li>)}</ul>)}
        </section>
        <div className="row-wrap">
          {d.contentUrl && <a className="btn btn-sm" href={d.contentUrl} target="_blank" rel="noreferrer"><Icon name="external" size={13} />Open original</a>}
          {!d.original && onRequest && <button className="btn btn-sm" onClick={onRequest}><Icon name="download" size={13} />Request original</button>}
          {onBin && <button className="btn btn-sm" onClick={onBin}><Icon name="trash" size={13} />Move to bin</button>}
        </div>
      </aside>
    </div>
  );
}
