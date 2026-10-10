/** Settings, grouped like macOS System Settings: a pane list on the left, grouped rows on the right. */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errText } from "../api.ts";
import { useApi, useLoad } from "../ctx.tsx";
import { href, useLocation } from "../router.ts";
import { ago } from "../format.ts";
import { getTheme, setTheme, type ThemeChoice } from "../theme.ts";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Link, Segmented, Switch } from "../components/Controls.tsx";
import { Dot, ErrorLine, Notice, Time } from "../components/Feedback.tsx";

const TOKEN_FIELDS: Array<[string, string]> = [
  ["macTokens.all", "Mac token, all four buckets (fallback)"],
  ["macTokens.up.windows", "Mac token: ivy-up-windows (read + delete)"],
  ["macTokens.up.android", "Mac token: ivy-up-android (read + delete)"],
  ["macTokens.cmd.windows", "Mac token: ivy-cmd-windows (write)"],
  ["macTokens.cmd.android", "Mac token: ivy-cmd-android (write)"],
  ["deviceTokens.windows.upWrite", "Windows device: up-bucket write token"],
  ["deviceTokens.windows.cmdRead", "Windows device: cmd-bucket read token"],
  ["deviceTokens.android.upWrite", "Android device: up-bucket write token"],
  ["deviceTokens.android.cmdRead", "Android device: cmd-bucket read token"],
];

function getPath(o: any, path: string): any { return path.split(".").reduce((x, k) => (x == null ? x : x[k]), o); }
function setPath(o: any, path: string, v: unknown) {
  const ks = path.split("."); let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks[ks.length - 1]!] = v;
}

/** Builds the PUT /api/r2 body from the form; blank fields are left out. */
export function buildR2Config(f: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.endpoint?.trim()) out.endpoint = f.endpoint.trim();
  if (f.accountId?.trim()) out.accountId = f.accountId.trim();
  if (f.deviceEndpoint?.trim()) out.deviceEndpoint = f.deviceEndpoint.trim();
  for (const [k] of TOKEN_FIELDS) if (f[k]?.trim()) setPath(out, k, f[k].trim());
  // device tokens are a pair: drop a half-filled role so the schema error is clear
  for (const role of ["windows", "android"]) {
    const d = getPath(out, `deviceTokens.${role}`);
    if (d && (!d.upWrite || !d.cmdRead)) throw new Error(`${role} device tokens need both the up-write and the cmd-read token`);
  }
  return out;
}

const SECTIONS: Array<{ id: string; label: string; icon: IconName; tint: string }> = [
  { id: "r2", label: "Cloudflare R2", icon: "cloud", tint: "#f48120" },
  { id: "lock", label: "Auto-lock", icon: "lock", tint: "#8e8e93" },
  { id: "bin", label: "Recovery bin", icon: "trash", tint: "#ff3b30" },
  { id: "passphrase", label: "Passphrase", icon: "key", tint: "#5856d6" },
  { id: "ai", label: "AI", icon: "sparkles", tint: "#af52de" },
  { id: "imports", label: "Imports", icon: "download", tint: "#34c759" },
  { id: "appearance", label: "Appearance", icon: "appearance", tint: "#007aff" },
];

function Row({ label, sub, children, stacked }: { label: ReactNode; sub?: ReactNode; children?: ReactNode; stacked?: boolean }) {
  return (
    <div className={`group-row${stacked ? " stacked" : ""}`}>
      <div className="row-label"><div>{label}</div>{sub ? <div className="row-sub">{sub}</div> : null}</div>
      {children !== undefined && <div className="row-control">{children}</div>}
    </div>
  );
}

export function SettingsView() {
  const { query } = useLocation();
  const section = SECTIONS.some((s) => s.id === query.get("section")) ? query.get("section")! : "r2";
  const cur = SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="settings-panes">
      <nav className="settings-list" aria-label="Settings sections">
        <h2 style={{ fontSize: "var(--text-lg)", padding: "0 10px 12px" }}>Settings</h2>
        {SECTIONS.map((s) => (
          <Link key={s.id} to={href("/settings", { section: s.id })} aria-current={s.id === section ? "page" : undefined}>
            <span className="si" style={{ background: s.tint }}><Icon name={s.icon} size={13} /></span>{s.label}
          </Link>
        ))}
      </nav>
      <div className="settings-body">
        <div className="settings-inner">
          <h1>{cur.label}</h1>
          {section === "r2" && <R2Settings />}
          {section === "lock" && <LockSettings />}
          {section === "bin" && <BinSettings />}
          {section === "passphrase" && <PassphraseChange />}
          {section === "ai" && <AiSettings />}
          {section === "imports" && <ActivityVaultSettings />}
          {section === "appearance" && <Appearance />}
        </div>
      </div>
    </div>
  );
}

function Appearance() {
  const [t, setT] = useState<ThemeChoice>(getTheme);
  return (
    <section aria-label="Appearance">
      <div className="group">
        <Row label="Appearance" sub="Follows macOS unless you choose Light or Dark here (this browser only).">
          <Segmented label="Appearance" value={t} onChange={(v) => { setT(v); setTheme(v); }} options={[["system", "Auto"], ["light", "Light"], ["dark", "Dark"]]} />
        </Row>
      </div>
    </section>
  );
}

function R2Settings() {
  const api = useApi();
  const cur = useLoad<any>((a) => a.get("/api/r2"), []);
  const [f, setF] = useState<Record<string, string>>({});
  const [json, setJson] = useState("");
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const c = cur.data?.config;
  const save = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null);
    try {
      const body = mode === "json" ? JSON.parse(json) : buildR2Config(f);
      await api.put("/api/r2", body);
      setF({}); setJson(""); setMsg({ ok: true, text: "Saved. Secrets are stored sealed and shown masked from now on." }); cur.reload();
    } catch (x) { setMsg({ ok: false, text: `Not saved: ${errText(x)}` }); }
  };
  const runCheck = async () => {
    setBusy(true); setCheck(null);
    try { setCheck(await api.post("/api/r2/check", {})); } catch (x) { setCheck({ error: errText(x) }); } finally { setBusy(false); }
  };
  const masked = (path: string) => { const t = getPath(c, path); return t ? <span className="mono">{t.accessKeyId}:{t.secret}</span> : <span>not set</span>; };
  const input = (k: string, label: string, opts: { secret?: boolean; placeholder?: string } = {}) => (
    <input className="input" type={opts.secret ? "password" : "text"} autoComplete="off" aria-label={label} placeholder={opts.placeholder}
      value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
  );
  return (
    <section aria-label="R2" className="stack" style={{ gap: 20 }}>
      <ErrorLine error={cur.error} />
      <div>
        <div className="group">
          <Row label="Status" sub={cur.data?.configured ? <>Endpoint <span className="mono">{c.endpoint}</span>{c.deviceEndpoint ? <> · device endpoint <span className="mono">{c.deviceEndpoint}</span></> : null}</> : "Not configured: nothing is synced until the tokens are saved."}>
            <Dot s={cur.data?.configured ? "green" : "off"} label={cur.data?.configured ? "configured" : "not configured"} />
            <button type="button" className="btn btn-sm" onClick={() => void runCheck()} disabled={busy || !cur.data?.configured}>{busy ? "Checking…" : "Check connection"}</button>
          </Row>
        </div>
        {check?.error && <p className="group-foot error">{check.error}</p>}
        {check?.buckets && (
          <div className="group" style={{ marginTop: 12 }}>
            <table className="check-table" aria-label="Connection check">
              <thead><tr><th></th><th>Bucket</th><th>Result</th><th>ms</th></tr></thead>
              <tbody>{check.buckets.map((b: any) => <tr key={b.bucket}><td><Dot s={b.ok ? "green" : "red"} /></td><td className="mono">{b.bucket}</td><td>{b.ok ? "reachable" : `${b.status ?? ""} ${b.error ?? ""}`}</td><td className="tnum">{b.ms}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
      <form onSubmit={save} className="stack" style={{ gap: 20 }}>
        <div className="row"><Segmented label="Input mode" value={mode} onChange={setMode} options={[["fields", "Fields"], ["json", "Paste r2.json"]]} /></div>
        {mode === "json" ? (
          <div className="group"><Row stacked label="r2.json"><textarea className="textarea mono" rows={10} value={json} onChange={(e) => setJson(e.target.value)} aria-label="r2.json" style={{ width: "100%" }} /></Row></div>
        ) : (
          <>
            <div>
              <h4 className="group-title">Account</h4>
              <div className="group">
                <Row label="Account id" sub={c?.accountId ? `current: ${c.accountId}` : undefined}>{input("accountId", "Account id")}</Row>
                <Row label="Endpoint" sub="instead of the account id">{input("endpoint", "Endpoint (instead of account id)", { placeholder: "https://<account>.r2.cloudflarestorage.com" })}</Row>
                <Row label="Device endpoint" sub="optional">{input("deviceEndpoint", "Device endpoint (optional)")}</Row>
              </div>
            </div>
            <div>
              <h4 className="group-title">Tokens (accessKeyId:secret)</h4>
              <div className="group">
                {TOKEN_FIELDS.map(([k, label]) => <Row key={k} label={label} sub={<>current: {masked(k)}</>}>{input(k, label, { secret: true })}</Row>)}
              </div>
            </div>
          </>
        )}
        <p className="group-foot" style={{ marginTop: -12 }}>Saving replaces the whole R2 configuration: enter every token again.</p>
        <div className="row"><span className="spacer" />{msg && <span role="status" className={msg.ok ? "ok-text small" : "error small"}>{msg.text}</span>}<button type="submit" className="btn btn-primary">Save R2 configuration</button></div>
      </form>
    </section>
  );
}

function LockSettings() {
  const api = useApi();
  const ks = useLoad<any>((a) => a.get("/api/keystore"), []);
  const [min, setMin] = useState("");
  const [mode, setMode] = useState("ui");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (ks.data) { setMin(String(ks.data.autoLockMinutes ?? "")); setMode(ks.data.autoLockMode ?? "ui"); } }, [ks.data]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try { await api.put("/api/keystore/settings", { autoLockMinutes: Number(min), ...(ks.data?.autoLockMode !== undefined ? { autoLockMode: mode } : {}) }); setMsg("Saved."); ks.reload(); }
    catch (x) { setMsg(errText(x)); }
  };
  return (
    <form aria-label="Auto-lock" onSubmit={save} className="stack">
      <div className="group">
        <Row label="Lock after idle" sub="Minutes without activity; 0 = never.">
          <input className="input" style={{ width: 90 }} type="number" min={0} max={1440} value={min} onChange={(e) => setMin(e.target.value)} aria-label="Lock after idle minutes (0 = never)" /><span className="small muted">min</span>
        </Row>
        {ks.data?.autoLockMode !== undefined && (
          <Row label="Auto-lock does" sub={mode === "ui" ? "Screen lock: ingest keeps running with the key in memory." : "Full lock: the key is dropped; ingest stops until unlock."}>
            <select className="select" aria-label="Auto-lock does" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="ui">Screen lock</option><option value="full">Full lock</option>
            </select>
          </Row>
        )}
      </div>
      <div className="row"><span className="spacer" />{msg && <span role="status" className="small muted">{msg}</span>}<button type="submit" className="btn btn-primary">Save</button></div>
    </form>
  );
}

function BinSettings() {
  const api = useApi();
  const s = useLoad<any>((a) => a.get("/api/bin/settings"), []);
  const [days, setDays] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (s.data) setDays(String(s.data.retentionDays)); }, [s.data]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try { await api.put("/api/bin/settings", { retentionDays: Number(days) }); setMsg("Saved."); s.reload(); } catch (x) { setMsg(errText(x)); }
  };
  return (
    <form aria-label="Recovery bin retention" onSubmit={save} className="stack">
      <div className="group">
        <Row label="Keep deleted items for" sub="Items deleted inside the vault are removed permanently after this.">
          <input className="input" style={{ width: 90 }} type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Keep deleted items for days" /><span className="small muted">days</span>
        </Row>
        <Row label="Open the recovery bin"><Link to="/bin" className="btn btn-sm">Recovery bin</Link></Row>
      </div>
      <div className="row"><span className="spacer" />{msg && <span role="status" className="small muted">{msg}</span>}<button type="submit" className="btn btn-primary">Save</button></div>
    </form>
  );
}

function PassphraseChange() {
  const api = useApi();
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try { const r = await api.post<any>("/api/keystore/change-passphrase", { current: cur, next }); setCur(""); setNext(""); setMsg(`Changed. Fingerprint unchanged (${r.fingerprint}). ${r.saltBackup ?? ""}`); }
    catch (x) { setMsg(errText(x)); }
  };
  return (
    <form aria-label="Passphrase" onSubmit={save} className="stack">
      <div className="group">
        <Row label="Current passphrase"><input className="input" type="password" autoComplete="current-password" aria-label="Current" value={cur} onChange={(e) => setCur(e.target.value)} /></Row>
        <Row label="New passphrase"><input className="input" type="password" autoComplete="new-password" aria-label="New" value={next} onChange={(e) => setNext(e.target.value)} /></Row>
      </div>
      <p className="group-foot" style={{ marginTop: -8 }}>The Mac key does not change, so devices stay paired. Keep a fresh copy of data/identity.json afterwards.</p>
      <div className="row"><span className="spacer" /><button type="submit" className="btn btn-primary" disabled={!cur || !next}>Change passphrase</button></div>
      {msg && <Notice role="status">{msg}</Notice>}
    </form>
  );
}

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
    <section aria-label="AI" className="stack" style={{ gap: 20 }}>
      <ErrorLine error={s.error} />
      <div>
        <div className="group">
          <Row label={<b>Cloud AI (OpenAI)</b>} sub={on ? "On: Ask AI and the AI overview drawers can send content to OpenAI." : "Off: nothing leaves this Mac. Search, timeline, OCR and browsing work fully without it."}>
            <Switch label="Allow cloud AI processing (OpenAI API)" checked={on} disabled={!d} onChange={() => void put({ cloudEnabled: !on })} />
          </Row>
          <Row label="What is sent" sub={<span data-testid="ai-what-is-sent">{d?.whatIsSent ?? "What would be sent: your question, and the passages and records the assistant retrieves while answering."}</span>} />
        </div>
      </div>
      <form onSubmit={saveKey}>
        <h4 className="group-title">API key</h4>
        <div className="group">
          <Row label="OpenAI API key" sub={d?.apiKeySet ? "Stored, sealed under the identity key." : "Not set."}>
            <input className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} aria-label="OpenAI API key" placeholder={d?.apiKeySet ? "Enter a new key to replace it" : "sk-..."} />
          </Row>
          <Row label="">
            {d?.apiKeySet && <button type="button" className="btn btn-sm" onClick={() => void put({ apiKey: "" }, "API key removed.")}>Remove key</button>}
            <button type="submit" className="btn btn-sm btn-primary" disabled={!key.trim()}>Save key</button>
          </Row>
        </div>
      </form>
      <div>
        <h4 className="group-title">Model</h4>
        <div className="group">
          <Row label="Model" sub={!m ? (on ? (d?.apiKeySet ? (models.error ? `Model list unavailable: ${errText(models.error)}` : "Loading the model list…") : "Save an API key to load the model list.") : "The model list is read from the API once cloud AI is on.") : "Read from your OpenAI account."}>
            <select className="select" aria-label="Model" value={d?.model ?? ""} onChange={(e) => void put({ model: e.target.value || null })} disabled={!m}>
              <option value="">default: {m?.defaultModel ?? d?.modelDefault ?? "newest GPT-5-class model"}</option>
              {(m?.models ?? []).map((id: string) => <option key={id} value={id}>{id}</option>)}
            </select>
          </Row>
        </div>
      </div>
      <div>
        <h4 className="group-title">Semantic search</h4>
        <div className="group">
          <Row label="Compute embeddings with OpenAI" sub={<>{d?.embeddingsSend ?? ""}{on ? "" : " (needs cloud AI on)"}</>}>
            <Switch label="Compute embeddings with OpenAI" checked={!!d?.embeddings} disabled={!d} onChange={() => void put({ embeddings: !d?.embeddings })} />
          </Row>
        </div>
      </div>
      {msg && <Notice role="status">{msg}</Notice>}
    </section>
  );
}

export function ActivityVaultSettings() {
  const api = useApi();
  const s = useLoad<any>((a) => a.get("/api/imports/activity-vault"), []);
  const [path, setPathV] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s.data) setPathV(s.data.settings.path ?? ""); }, [s.data]);
  const put = async (body: Record<string, unknown>) => { try { await api.put("/api/imports/activity-vault/settings", body); s.reload(); setMsg("Saved."); } catch (x) { setMsg(errText(x)); } };
  const run = async () => {
    setBusy(true);
    try { const r = await api.post<any>("/api/imports/activity-vault/run", {}); setMsg(r.status === "ok" ? `Imported ${r.rowsAdded} new row(s) of ${r.rowsSeen}.` : `Import failed: ${r.error}`); s.reload(); }
    catch (x) { setMsg(errText(x)); } finally { setBusy(false); }
  };
  const d = s.data;
  const last = d?.runs?.[0];
  return (
    <section aria-label="Activity Vault import" className="stack" style={{ gap: 20 }}>
      <ErrorLine error={s.error} />
      <div>
        <h4 className="group-title">Activity Vault</h4>
        <div className="group">
          <Row label="Import daily" sub="Copies Google activity (YouTube, Search, Maps, …) from a local Activity Vault archive. The archive is opened read-only and never modified.">
            <Switch label="Import daily" checked={!!d?.settings.enabled} disabled={!d} onChange={() => void put({ enabled: !d?.settings.enabled })} />
          </Row>
          <Row stacked label="Archive path" sub="SQLite or JSON file, or its folder">
            <form className="row" onSubmit={(e) => { e.preventDefault(); void put({ path }); }} style={{ width: "100%" }}>
              <input aria-label="Archive path" className="input mono spacer" value={path} onChange={(e) => setPathV(e.target.value)} />
              <button type="submit" className="btn">Save path</button>
            </form>
          </Row>
          {d?.detected && <Row label="Detected" sub={<><span className="mono">{d.detected.format}</span>{d.detected.table ? <> table <span className="mono">{d.detected.table}</span></> : null} in <span className="mono">{d.detected.file}</span></>} />}
          <Row label="Last run" sub={last ? <><Time at={last.startedAt} /> ({ago(last.startedAt)}): {last.status}{last.status === "ok" ? ` · ${last.rowsAdded} added of ${last.rowsSeen}${last.rowsSkipped ? ` · ${last.rowsSkipped} skipped` : ""}` : last.error ? ` · ${last.error}` : ""}</> : "Never run."}>
            <button type="button" className="btn btn-sm" onClick={() => void run()} disabled={busy || !d?.settings.path}>{busy ? "Importing…" : "Import now"}</button>
          </Row>
        </div>
        {d?.detectError && <p className="group-foot warn-text">{d.detectError}</p>}
      </div>
      {msg && <Notice role="status">{msg}</Notice>}
    </section>
  );
}
