/** Settings sections for the AI layer (A3, M4) and the Activity Vault import (S7), plus the coverage row. */
import { useEffect, useState, type FormEvent } from "react";
import { errText } from "../api.ts";
import { useApi, useLoad } from "../ctx.tsx";
import { Dot, ErrorLine, Mono, Time } from "../ui.tsx";

export function AiSettings() {
  const api = useApi();
  const s = useLoad<any>((a) => a.get("/api/ai/settings"), []);
  const d = s.data;
  const on = !!d?.cloudEnabled;
  const models = useLoad<any>((a) => (on && d?.apiKeySet ? a.get("/api/ai/models") : Promise.resolve(null)), [on, d?.apiKeySet]);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const put = async (body: Record<string, unknown>, ok?: string) => {
    try { await api.put("/api/ai/settings", body); s.reload(); setMsg(ok ?? null); } catch (x) { setMsg(errText(x)); }
  };
  const saveKey = async (e: FormEvent) => { e.preventDefault(); await put({ apiKey: key.trim() }, "API key saved (sealed; it is never shown again)."); setKey(""); };
  const m = models.data;
  return (
    <section className="panel" aria-label="AI">
      <h2>AI (cloud, OpenAI)</h2>
      <ErrorLine error={s.error} />
      <p><strong>Cloud AI is {on ? "ON" : "off"}.</strong> {on ? "" : "Nothing leaves this Mac. Search, timeline, OCR and browsing work fully without it."}</p>
      <p className="small" data-testid="ai-what-is-sent">{d?.whatIsSent ?? "What would be sent: your question, and the passages and records the assistant retrieves while answering."}</p>
      <label className="check"><input type="checkbox" checked={on} onChange={() => void put({ cloudEnabled: !on })} disabled={!d} /> Allow cloud AI processing (OpenAI API)</label>

      <form onSubmit={saveKey} className="toolbar">
        <label>OpenAI API key <span className="small">{d?.apiKeySet ? "stored (sealed under the identity key)" : "not set"}</span>
          <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} aria-label="OpenAI API key" placeholder={d?.apiKeySet ? "enter a new key to replace it" : "sk-..."} />
        </label>
        <button type="submit" disabled={!key.trim()}>Save key</button>
        {d?.apiKeySet && <button type="button" onClick={() => void put({ apiKey: "" }, "API key removed.")}>Remove key</button>}
      </form>

      <label>Model
        <select aria-label="Model" value={d?.model ?? ""} onChange={(e) => void put({ model: e.target.value || null })} disabled={!m}>
          <option value="">default: {m?.defaultModel ?? d?.modelDefault ?? "newest GPT-5-class model"}</option>
          {(m?.models ?? []).map((id: string) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      {!m && <p className="small muted">{on ? (d?.apiKeySet ? (models.error ? `Model list unavailable: ${errText(models.error)}` : "Loading the model list…") : "Save an API key to load the model list.") : "The model list is read from the API once cloud AI is on."}</p>}

      <h3>Semantic search (embeddings)</h3>
      <label className="check"><input type="checkbox" checked={!!d?.embeddings} onChange={() => void put({ embeddings: !d?.embeddings })} disabled={!d} /> Compute embeddings with OpenAI {on ? "" : "(needs cloud AI on)"}</label>
      <p className="small">{d?.embeddingsSend ?? ""}</p>
      {msg && <p role="status" className="small">{msg}</p>}
    </section>
  );
}

export function ActivityVaultSettings() {
  const api = useApi();
  const s = useLoad<any>((a) => a.get("/api/imports/activity-vault"), []);
  const [path, setPath] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s.data) setPath(s.data.settings.path ?? ""); }, [s.data]);
  const put = async (body: Record<string, unknown>) => { try { await api.put("/api/imports/activity-vault/settings", body); s.reload(); setMsg("Saved."); } catch (x) { setMsg(errText(x)); } };
  const run = async () => {
    setBusy(true);
    try { const r = await api.post<any>("/api/imports/activity-vault/run", {}); setMsg(r.status === "ok" ? `Imported ${r.rowsAdded} new row(s) of ${r.rowsSeen}.` : `Import failed: ${r.error}`); s.reload(); }
    catch (x) { setMsg(errText(x)); } finally { setBusy(false); }
  };
  const d = s.data;
  const last = d?.runs?.[0];
  return (
    <section className="panel" aria-label="Activity Vault import">
      <h2>Activity Vault import</h2>
      <p className="small">Copies Google activity (YouTube, Search, Maps, …) from a local Activity Vault archive into IVY, daily and on demand. The archive is opened read-only and never modified.</p>
      <ErrorLine error={s.error} />
      <label className="check"><input type="checkbox" checked={!!d?.settings.enabled} onChange={() => void put({ enabled: !d?.settings.enabled })} disabled={!d} /> Import daily</label>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); void put({ path }); }}>
        <label>Archive path (SQLite or JSON file, or its folder) <input aria-label="Archive path" className="mono" value={path} onChange={(e) => setPath(e.target.value)} /></label>
        <button type="submit">Save path</button>
        <button type="button" onClick={() => void run()} disabled={busy || !d?.settings.path}>{busy ? "Importing…" : "Import now"}</button>
      </form>
      {d?.detected && <p className="small">Detected: <Mono>{d.detected.format}</Mono>{d.detected.table ? <> table <Mono>{d.detected.table}</Mono></> : null} in <Mono>{d.detected.file}</Mono></p>}
      {d?.detectError && <p className="small warn">{d.detectError}</p>}
      {last && <p className="small">Last run <Time at={last.startedAt} />: {last.status}{last.status === "ok" ? ` · ${last.rowsAdded} added of ${last.rowsSeen}${last.rowsSkipped ? ` · ${last.rowsSkipped} skipped` : ""}` : last.error ? ` · ${last.error}` : ""}</p>}
      {msg && <p role="status" className="small">{msg}</p>}
    </section>
  );
}

/** Coverage page rows for imports that are not devices (S7 / D1-D3). */
export function ImportsCoverage({ imports }: { imports?: any[] }) {
  if (!imports?.length) return null;
  return (
    <section aria-label="Imports">
      <h3>Imports</h3>
      <table>
        <thead><tr><th></th><th>Source</th><th>Status</th><th>Last run</th><th>Last success</th><th>Rows</th><th>Days without rows (last {imports[0].gapWindowDays})</th><th>Captures</th></tr></thead>
        <tbody>{imports.map((im) => (
          <tr key={im.source} data-testid={`import-${im.source}`}>
            <td><Dot s={im.status} label={`${im.name} ${im.status}`} /></td>
            <td>{im.name}{im.location ? <div className="small mono">{im.location}</div> : null}</td>
            <td>{im.statusReason}</td>
            <td><Time at={im.lastRunAt} /></td>
            <td><Time at={im.lastSuccessAt} /></td>
            <td>{im.rowsTotal}{im.lastRowsAdded !== null ? <span className="small muted"> (+{im.lastRowsAdded} last run)</span> : null}</td>
            <td className="small">
              {im.gaps.length === 0 ? <span className="muted">none{im.firstRowAt ? "" : " (nothing imported yet)"}</span> : (
                <ul>{im.gaps.map((g: any) => <li key={g.date}><Mono>{g.date}</Mono> {g.state === "gap" ? <strong className="warn">gap</strong> : <span className="muted">unknown</span>} · {g.note}</li>)}</ul>
              )}
              {im.captureReported === null && im.lastSuccessAt ? <div className="muted">the source does not report its capture status</div> : null}
            </td>
            <td className="small">{im.captures}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}
