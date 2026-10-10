import { useEffect, useState, type FormEvent } from "react";
import { errText } from "../api.ts";
import { useApi, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { Empty, ErrorLine, Pager } from "../ui.tsx";
import { ItemRow, type Item } from "./items.tsx";

const TYPES = ["message", "notification", "screenshot", "photo", "file", "usage", "call"];
const FILTERS = ["device", "app", "account", "person", "conversation", "from", "to", "type", "sort"] as const;

interface SearchResult {
  q: string; page: number; pages: number; total: number; exactTotal: number; fuzzyTotal: number; tookMs: number;
  counts: Record<string, { exact: number; fuzzy: number }>;
  items: Item[];
  semantic: { enabled: boolean; label: string; items: Array<{ type: string; id: string; score: number }> };
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

  const go = (patch: Record<string, string | number | undefined>) => {
    const next: Record<string, string | number | undefined> = { q, ...params, page: undefined, ...patch };
    navigate(href("/", next));
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go({ q: text }); };
  const types = params.type ? params.type.split(",") : [];
  const toggleType = (t: string) => go({ type: (types.includes(t) ? types.filter((x) => x !== t) : [...types, t]).join(",") || undefined });
  const devices = (facets.data?.devices ?? []) as Array<{ id: string; role: string }>;

  const bin = async (it: Item) => {
    try { await api.del(`/api/items/${it.type}/${it.id}`); setBinMsg(`Moved ${it.type} to the recovery bin.`); go({ page }); }
    catch (e) { setBinMsg(errText(e)); }
  };

  const items = res?.items ?? [];
  const firstFuzzy = items.findIndex((i) => i.match === "fuzzy");
  return (
    <div className="search">
      <form onSubmit={submit} className="searchbar" role="search">
        <input aria-label="Search" placeholder='Search everything: words, "exact phrase", -exclude' value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <button type="submit">Search</button>
      </form>
      <div className="search-cols">
        <aside className="rail" aria-label="Filters">
          <label>Device
            <select value={params.device} onChange={(e) => go({ device: e.target.value || undefined })}>
              <option value="">any</option><option value="windows">Windows</option><option value="android">Android</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.role} {d.id.slice(0, 8)}</option>)}
            </select>
          </label>
          <label>App
            <input list="facet-apps" value={params.app} onChange={(e) => go({ app: e.target.value || undefined })} />
            <datalist id="facet-apps">{(facets.data?.apps ?? []).map((a: string) => <option key={a} value={a} />)}</datalist>
          </label>
          <label>Account
            <input list="facet-accounts" value={params.account} onChange={(e) => go({ account: e.target.value || undefined })} />
            <datalist id="facet-accounts">{(facets.data?.accounts ?? []).map((a: string) => <option key={a} value={a} />)}</datalist>
          </label>
          <label>Person <input value={params.person} onChange={(e) => go({ person: e.target.value || undefined })} /></label>
          <label>Conversation
            <select value={params.conversation} onChange={(e) => go({ conversation: e.target.value || undefined })}>
              <option value="">any</option>
              {(facets.data?.conversations ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.platform} · {c.name}</option>)}
            </select>
          </label>
          <label>From <input type="date" value={params.from} onChange={(e) => go({ from: e.target.value || undefined })} /></label>
          <label>To <input type="date" value={params.to} onChange={(e) => go({ to: e.target.value || undefined })} /></label>
          <fieldset><legend>Type</legend>
            {TYPES.map((t) => (
              <label key={t} className="check"><input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} /> {t}
                {res?.counts[t] ? <span className="muted"> ({res.counts[t].exact + res.counts[t].fuzzy})</span> : null}</label>
            ))}
          </fieldset>
          <label>Order
            <select value={params.sort} onChange={(e) => go({ sort: e.target.value || undefined })}>
              <option value="">relevance</option><option value="newest">newest</option><option value="oldest">oldest</option>
            </select>
          </label>
        </aside>
        <section className="results" aria-label="Results">
          {!q && <Empty>Type a word, a phrase in quotes, or -word to exclude. Every match is listed, exact matches first.</Empty>}
          {busy && <p className="muted">Searching…</p>}
          <ErrorLine error={err} />
          {binMsg && <p className="muted" role="status">{binMsg}</p>}
          {res && (
            <>
              <p className="muted small" data-testid="search-summary">{res.total} matches · {res.exactTotal} exact · {res.fuzzyTotal} close (typo-tolerant) · {res.tookMs} ms</p>
              {res.total === 0 && <Empty>No records match “{res.q}”.</Empty>}
              {items.map((it, i) => (
                <div key={`${it.type}:${it.id}`}>
                  {i === firstFuzzy && <h3 className="divider">Close matches (typo-tolerant), after all exact matches</h3>}
                  <ItemRow it={it} devices={devices} onBin={(x) => void bin(x)} />
                </div>
              ))}
              {res.pages > 1 && <Pager page={res.page} pages={res.pages} total={res.total} onPage={(p) => go({ page: p })} />}
              {res.semantic?.enabled && (
                <section aria-label="Semantic matches">
                  <h3 className="divider">{res.semantic.label || "Semantic matches"}</h3>
                  {res.semantic.items.length === 0 ? <Empty>No semantic matches.</Empty> : (
                    <ul>{res.semantic.items.map((s) => <li key={`${s.type}:${s.id}`}>{s.type} <span className="mono">{s.id}</span> · score {s.score.toFixed(3)}</li>)}</ul>
                  )}
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
