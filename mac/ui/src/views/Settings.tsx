import { useEffect, useState, type FormEvent } from "react";
import { errText } from "../api.ts";
import { useApi, useLoad } from "../ctx.tsx";
import { Dot, ErrorLine, Mono } from "../ui.tsx";
import { ActivityVaultSettings, AiSettings } from "./AiSettings.tsx";

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

export function SettingsView() {
  return (
    <div className="settings">
      <R2Settings />
      <LockSettings />
      <BinSettings />
      <PassphraseChange />
      <AiSettings />
      <ActivityVaultSettings />
    </div>
  );
}

function R2Settings() {
  const api = useApi();
  const cur = useLoad<any>((a) => a.get("/api/r2"), []);
  const [f, setF] = useState<Record<string, string>>({});
  const [json, setJson] = useState("");
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const [msg, setMsg] = useState<string | null>(null);
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const c = cur.data?.config;
  const save = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null);
    try {
      const body = mode === "json" ? JSON.parse(json) : buildR2Config(f);
      await api.put("/api/r2", body);
      setF({}); setJson(""); setMsg("Saved. Secrets are stored sealed and shown masked from now on."); cur.reload();
    } catch (x) { setMsg(`Not saved: ${errText(x)}`); }
  };
  const runCheck = async () => {
    setBusy(true); setCheck(null);
    try { setCheck(await api.post("/api/r2/check", {})); } catch (x) { setCheck({ error: errText(x) }); } finally { setBusy(false); }
  };
  const masked = (path: string) => { const t = getPath(c, path); return t ? <Mono>{t.accessKeyId}:{t.secret}</Mono> : <span className="muted">not set</span>; };
  return (
    <section className="panel" aria-label="R2">
      <h2>Cloudflare R2</h2>
      <ErrorLine error={cur.error} />
      <p>Status: {cur.data?.configured ? <>configured · endpoint <Mono>{c.endpoint}</Mono>{c.deviceEndpoint ? <> · device endpoint <Mono>{c.deviceEndpoint}</Mono></> : null}</> : "not configured"}</p>
      <p className="small muted">Saving replaces the whole R2 configuration: enter every token again. Tokens are <Mono>accessKeyId:secret</Mono>.</p>
      <div className="toolbar">
        <label className="check"><input type="radio" checked={mode === "fields"} onChange={() => setMode("fields")} /> fields</label>
        <label className="check"><input type="radio" checked={mode === "json"} onChange={() => setMode("json")} /> paste r2.json</label>
      </div>
      <form onSubmit={save}>
        {mode === "json" ? (
          <label>r2.json <textarea className="mono" rows={10} value={json} onChange={(e) => setJson(e.target.value)} aria-label="r2.json" /></label>
        ) : (
          <div className="form-grid">
            <label>Account id <input value={f.accountId ?? ""} onChange={(e) => setF({ ...f, accountId: e.target.value })} placeholder={c?.accountId ?? ""} /></label>
            <label>Endpoint (instead of account id) <input value={f.endpoint ?? ""} onChange={(e) => setF({ ...f, endpoint: e.target.value })} placeholder="https://<account>.r2.cloudflarestorage.com" /></label>
            <label>Device endpoint (optional) <input value={f.deviceEndpoint ?? ""} onChange={(e) => setF({ ...f, deviceEndpoint: e.target.value })} /></label>
            {TOKEN_FIELDS.map(([k, label]) => (
              <label key={k}>{label} <span className="small">current: {masked(k)}</span>
                <input type="password" autoComplete="off" value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-label={label} />
              </label>
            ))}
          </div>
        )}
        <button type="submit">Save R2 configuration</button> <button type="button" onClick={() => void runCheck()} disabled={busy || !cur.data?.configured}>{busy ? "Checking…" : "Check connection"}</button>
      </form>
      {msg && <p role="status">{msg}</p>}
      {check?.error && <p className="error">{check.error}</p>}
      {check?.buckets && (
        <table aria-label="Connection check">
          <thead><tr><th></th><th>Bucket</th><th>Result</th><th>ms</th></tr></thead>
          <tbody>{check.buckets.map((b: any) => <tr key={b.bucket}><td><Dot s={b.ok ? "green" : "red"} /></td><td><Mono>{b.bucket}</Mono></td><td>{b.ok ? "reachable" : `${b.status ?? ""} ${b.error ?? ""}`}</td><td>{b.ms}</td></tr>)}</tbody>
        </table>
      )}
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
    <section className="panel" aria-label="Auto-lock">
      <h2>Auto-lock</h2>
      <form onSubmit={save} className="toolbar">
        <label>Lock after idle minutes (0 = never) <input type="number" min={0} max={1440} value={min} onChange={(e) => setMin(e.target.value)} /></label>
        {ks.data?.autoLockMode !== undefined && (
          <label>Auto-lock does
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="ui">screen lock (ingest keeps running)</option><option value="full">full lock (drop the key)</option>
            </select>
          </label>
        )}
        <button type="submit">Save</button>
      </form>
      {msg && <p role="status">{msg}</p>}
    </section>
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
    <section className="panel" aria-label="Recovery bin retention">
      <h2>Recovery bin</h2>
      <form onSubmit={save} className="toolbar">
        <label>Keep deleted items for days <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} /></label>
        <button type="submit">Save</button>
      </form>
      {msg && <p role="status">{msg}</p>}
    </section>
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
    <section className="panel" aria-label="Passphrase">
      <h2>Passphrase</h2>
      <form onSubmit={save} className="toolbar">
        <label>Current <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label>New <input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <button type="submit" disabled={!cur || !next}>Change passphrase</button>
      </form>
      {msg && <p role="status" className="small">{msg}</p>}
    </section>
  );
}
