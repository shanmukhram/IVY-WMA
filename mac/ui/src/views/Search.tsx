/**
 * Search (Q1-Q6): one large field, filter chips (device, app, type, date, more), results as
 * cards grouped by type with highlighted passages, exact matches first, close (typo-tolerant)
 * matches after, a labeled semantic section only when the API reports it, pagination over all.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errText } from "../api.ts";
import { useApi, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { TYPE_PLURAL, platformLabel } from "../format.ts";
import { Icon, TYPE_ICON } from "../components/Icon.tsx";
import { Field, SearchField } from "../components/Controls.tsx";
import { Empty, ErrorLine, Pager, Notice } from "../components/Feedback.tsx";
import { RecordCard, type Item } from "./records.tsx";
import { AiDrawer } from "./Ai.tsx";

const TYPES = ["message", "notification", "screenshot", "photo", "file", "usage", "call", "browsing"];
const FILTERS = ["device", "app", "account", "person", "conversation", "from", "to", "type", "sort"] as const;

interface SearchResult {
  q: string; page: number; pages: number; total: number; exactTotal: number; fuzzyTotal: number; tookMs: number;
  counts: Record<string, { exact: number; fuzzy: number }>;
  items: Item[];
  semantic: { enabled: boolean; label: string; items: Array<{ type: string; id: string; score: number; title?: string | null; snippet?: string | null; eventTime?: string | null }> };
}

/** Group a run of items by type, keeping the first-seen order of types. */
function byType(items: Item[]): Array<[string, Item[]]> {
  const m = new Map<string, Item[]>();
  for (const it of items) m.set(it.type, [...(m.get(it.type) ?? []), it]);
  return [...m.entries()];
}

function Popover({ label, active, children }: { label: string; active?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="filter-pop" ref={ref}>
      <button type="button" className={`chip chip-outline${active ? " active" : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{label}<Icon name="chevronDown" size={11} /></button>
      {open && <div className="filter-panel" role="group" aria-label={label}>{children}</div>}
    </div>
  );
}

export function SearchView() {
  const api = useApi();
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const page = Number(query.get("page") ?? 1) || 1;
  const params = Object.fromEntries(FILTERS.map((k) => [k, query.get(k) ?? ""])) as Record<(typeof FILTERS)[number], string>;
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const facets = useLoad((a) => a.get("/api/facets"), []);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [binMsg, setBinMsg] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const key = query.toString();

  useEffect(() => {
    if (!q.trim()) { setRes(null); setErr(null); return; }
    let live = true;
    setBusy(true);
    api.get<SearchResult>("/api/search", { q, page, pageSize: 25, ...params }).then(
      (r) => { if (live) { setRes(r); setErr(null); } },
      (e) => { if (live) { setErr(e); setRes(null); } },
    ).finally(() => live && setBusy(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  useEffect(() => setAiOpen(false), [q, params.device, params.app, params.type, params.from, params.to]);

  const go = (patch: Record<string, string | number | undefined>) => {
    const next: Record<string, string | number | undefined> = { q, ...params, page: undefined, ...patch };
    navigate(href("/", next));
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go({ q: text }); };
  const types = params.type ? params.type.split(",") : [];
  const toggleType = (t: string) => go({ type: (types.includes(t) ? types.filter((x) => x !== t) : [...types, t]).join(",") || undefined });
  const devices = (facets.data?.devices ?? []) as Array<{ id: string; role: string }>;
  const anyFilter = FILTERS.some((k) => k !== "sort" && params[k]);

  const bin = async (it: Item) => {
    try { await api.del(`/api/items/${it.type}/${it.id}`); setBinMsg(`Moved ${it.type} to the recovery bin.`); go({ page }); }
    catch (e) { setBinMsg(errText(e)); }
  };

  const items = res?.items ?? [];
  const exact = items.filter((i) => i.match !== "fuzzy");
  const fuzzy = items.filter((i) => i.match === "fuzzy");
  const count = (t: string) => res?.counts[t] ? res.counts[t].exact + res.counts[t].fuzzy : 0;
  const groups = (list: Item[]) => byType(list).map(([t, its]) => (
    <section key={t} className="result-group" aria-label={TYPE_PLURAL[t] ?? t}>
      <h2><Icon name={TYPE_ICON[t] ?? "info"} size={14} />{TYPE_PLURAL[t] ?? t}<span className="faint">{count(t)}</span></h2>
      {its.map((it) => <RecordCard key={`${it.type}:${it.id}`} it={it} devices={devices} onBin={(x) => void bin(x)} />)}
    </section>
  ));

  return (
    <div className="page">
      <div className="with-drawer">
        <div className="content">
          <div className="search-hero">
            <form onSubmit={submit} role="search">
              <SearchField large aria-label="Search" placeholder='Search everything: words, "exact phrase", -exclude' value={text} onChange={(e) => setText(e.target.value)} autoFocus />
              <button type="submit" className="btn btn-primary btn-lg">Search</button>
            </form>
            <div className="filter-bar" aria-label="Filters" role="group">
              <select className="select chip-select" aria-label="Device" value={params.device} onChange={(e) => go({ device: e.target.value || undefined })}>
                <option value="">Any device</option><option value="windows">Windows</option><option value="android">Android</option>
                {devices.map((d) => <option key={d.id} value={d.id}>{d.role} {d.id.slice(0, 8)}</option>)}
              </select>
              <select className="select" aria-label="App" value={params.app} onChange={(e) => go({ app: e.target.value || undefined })}>
                <option value="">Any app</option>
                {(facets.data?.apps ?? []).map((a: string) => <option key={a} value={a}>{platformLabel(a) || a}</option>)}
                {params.app && !(facets.data?.apps ?? []).includes(params.app) && <option value={params.app}>{params.app}</option>}
              </select>
              <Popover label={params.from || params.to ? `${params.from || "…"} – ${params.to || "…"}` : "Date"} active={!!(params.from || params.to)}>
                <Field label="From"><input className="input" type="date" aria-label="From" value={params.from} onChange={(e) => go({ from: e.target.value || undefined })} /></Field>
                <Field label="To"><input className="input" type="date" aria-label="To" value={params.to} onChange={(e) => go({ to: e.target.value || undefined })} /></Field>
              </Popover>
              <Popover label="More" active={!!(params.account || params.person || params.conversation || params.sort)}>
                <Field label="Account">
                  <select className="select" aria-label="Account" value={params.account} onChange={(e) => go({ account: e.target.value || undefined })}>
                    <option value="">Any</option>{(facets.data?.accounts ?? []).map((a: string) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </Field>
                <Field label="Person"><input className="input" aria-label="Person" defaultValue={params.person} onKeyDown={(e) => { if (e.key === "Enter") go({ person: (e.target as HTMLInputElement).value || undefined }); }} onBlur={(e) => { if (e.target.value !== params.person) go({ person: e.target.value || undefined }); }} /></Field>
                <Field label="Conversation">
                  <select className="select" aria-label="Conversation" value={params.conversation} onChange={(e) => go({ conversation: e.target.value || undefined })}>
                    <option value="">Any</option>{(facets.data?.conversations ?? []).map((c: any) => <option key={c.id} value={c.id}>{platformLabel(c.platform)} · {c.name}</option>)}
                  </select>
                </Field>
                <Field label="Order">
                  <select className="select" aria-label="Order" value={params.sort} onChange={(e) => go({ sort: e.target.value || undefined })}>
                    <option value="">Relevance</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option>
                  </select>
                </Field>
              </Popover>
              <span className="vsep" aria-hidden="true" />
              {TYPES.map((t) => (
                <button key={t} type="button" className="chip" aria-pressed={types.includes(t)} onClick={() => toggleType(t)}>
                  {TYPE_PLURAL[t]}{res && count(t) ? <span style={{ opacity: 0.7 }}> {count(t)}</span> : null}
                </button>
              ))}
              {anyFilter && <button type="button" className="btn btn-plain btn-sm" onClick={() => navigate(href("/", { q }))}>Clear filters</button>}
            </div>
          </div>

          {!q && (
            <Empty icon="search" title="Search everything">
              Messages, notifications, screenshots (by their text), photos, files and captured titles. Use "quotes" for a phrase and -word to exclude. Every match is listed, exact matches first.
            </Empty>
          )}
          {busy && !res && <p className="muted">Searching…</p>}
          <ErrorLine error={err} />
          {binMsg && <Notice role="status">{binMsg}</Notice>}
          {res && (
            <>
              <div className="results-head">
                <p className="muted small" data-testid="search-summary">{res.total} matches · {res.exactTotal} exact · {res.fuzzyTotal} close (typo-tolerant) · {res.tookMs} ms</p>
                <span className="spacer" />
                <button className="btn btn-sm" aria-expanded={aiOpen} onClick={() => setAiOpen((v) => !v)}><Icon name="sparkles" size={13} />AI overview</button>
              </div>
              {res.total === 0 && <Empty icon="search" title={`No results for “${res.q}”`}>Try fewer words, another spelling, or clear the filters.</Empty>}
              {groups(exact)}
              {fuzzy.length > 0 && (
                <>
                  <h2 className="section-divider">Close matches (typo-tolerant), after all exact matches</h2>
                  {groups(fuzzy)}
                </>
              )}
              {res.pages > 1 && <Pager page={res.page} pages={res.pages} total={res.total} onPage={(p) => go({ page: p })} />}
              {res.semantic?.enabled && (
                <section aria-label="Semantic matches">
                  <h2 className="section-divider">{res.semantic.label || "Semantic matches"}</h2>
                  {res.semantic.items.length === 0 ? <p className="muted small">No semantic matches.</p> : (
                    <div className="group">{res.semantic.items.map((s) => (
                      <div key={`${s.type}:${s.id}`} className="list-row">
                        <span className={`rec-icon t-${s.type}`}><Icon name={TYPE_ICON[s.type] ?? "info"} size={14} /></span>
                        <div style={{ flex: 1, minWidth: 0 }}><div className="ellipsis" style={{ fontWeight: 500 }}>{s.title ?? s.id}</div>{s.snippet ? <div className="small muted ellipsis">{s.snippet}</div> : null}</div>
                        <span className="badge">score {s.score.toFixed(3)}</span>
                      </div>
                    ))}</div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
        {res && <AiDrawer open={aiOpen} onClose={() => setAiOpen(false)} context={{ searchQuery: res.q, filters: Object.fromEntries(Object.entries(params).filter(([, v]) => v)) }} />}
      </div>
    </div>
  );
}
