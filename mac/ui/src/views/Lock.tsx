/** Session token, first-run passphrase (with the salt backup note), vault created, and the lock screen. */
import { useState, type FormEvent } from "react";
import { errText } from "../api.ts";
import { useApi } from "../ctx.tsx";
import { Icon } from "../components/Icon.tsx";
import { Field } from "../components/Controls.tsx";
import { Notice } from "../components/Feedback.tsx";

export interface KeystoreStatus {
  state: "uninitialized" | "locked" | "unlocked";
  fingerprint: string | null;
  uiLocked?: boolean;
  keyInMemory?: boolean;
  autoLockMinutes?: number;
  autoLockMode?: "ui" | "full";
  lockReason?: string | null;
  saltBackup?: string;
  ingestRunning?: boolean;
  derivedFrom?: string | null;
}

export const SALT_NOTE_FALLBACK =
  "Back up data/identity.json (it holds the identity salt). Re-pairing after a restore needs the same passphrase and the same salt: a new salt means a new Mac key and every device must be paired again.";

function Mark({ icon = "lock" }: { icon?: string }) {
  return <div className="auth-icon"><Icon name={icon} size={26} /></div>;
}

/** Shown when the browser has no session cookie: paste data/session.token once. */
export function TokenScreen({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await api.post("/api/session", { token: token.trim() }); onDone(); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="center">
      <form className="auth-card" onSubmit={submit} aria-label="Connect">
        <Mark icon="key" />
        <h1>Connect to IVY</h1>
        <p className="fine">This browser has no session yet. Paste the token from <span className="path">data/session.token</span>.</p>
        <Field label="Session token"><input className="input input-lg" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} autoFocus /></Field>
        <button className="btn btn-primary btn-lg" type="submit" disabled={!token.trim()}>Continue</button>
        {err && <p className="error" role="alert">{err}</p>}
      </form>
    </div>
  );
}

export interface Created { fingerprint: string; note: string }

export function LockScreen({ status, onUnlocked, onCreated }: { status: KeystoreStatus; onUnlocked: () => void; onCreated: (c: Created) => void }) {
  return status.state === "uninitialized" ? <SetPassphrase status={status} onDone={onCreated} /> : <Unlock status={status} onDone={onUnlocked} />;
}

/** Shown once after initialization, before the dashboard, so the salt backup note is read. */
export function CreatedPanel({ c, onContinue }: { c: Created; onContinue: () => void }) {
  return (
    <div className="center">
      <div className="auth-card wide">
        <Mark icon="check" />
        <h1>Vault created</h1>
        <div className="stack-sm">
          <span className="fine">Mac fingerprint</span>
          <span className="fingerprint">{c.fingerprint}</span>
        </div>
        <div className="salt-note"><Notice tone="warn">{c.note}</Notice></div>
        <button className="btn btn-primary btn-lg" onClick={onContinue} autoFocus>Continue</button>
      </div>
    </div>
  );
}

function Unlock({ status, onDone }: { status: KeystoreStatus; onDone: () => void }) {
  const api = useApi();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.post("/api/keystore/unlock", { passphrase: pass }); setPass(""); onDone(); }
    catch (x) { setErr(errText(x)); }
    finally { setBusy(false); }
  };
  return (
    <div className="center">
      <form className="auth-card" onSubmit={submit} aria-label="Unlock">
        <Mark />
        <h1>IVY is locked</h1>
        <Field label="Passphrase"><input className="input input-lg" type="password" autoFocus autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !pass}>{busy ? "Unlocking…" : "Unlock"}</button>
        {err && <p className="error" role="alert">{err}</p>}
        <p className="fine">{status.keyInMemory ? "Screen lock: the key is still in memory and ingest keeps running." : "Full lock: the key is not in memory; nothing is ingested until you unlock."}</p>
      </form>
    </div>
  );
}

function SetPassphrase({ status, onDone }: { status: KeystoreStatus; onDone: (c: Created) => void }) {
  const api = useApi();
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [salt, setSalt] = useState("");
  const [restore, setRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const note = status.saltBackup ?? SALT_NOTE_FALLBACK;

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pass !== again) { setErr("The two passphrases differ."); return; }
    setBusy(true);
    try {
      const r = await api.post<any>("/api/keystore/initialize", { passphrase: pass, ...(restore && salt.trim() ? { salt: salt.trim() } : {}) });
      onDone({ fingerprint: r.fingerprint, note: r.saltBackup ?? note });
    } catch (x) { setErr(errText(x)); }
    finally { setBusy(false); }
  };

  return (
    <div className="center">
      <form className="auth-card wide" onSubmit={submit} aria-label="Set passphrase">
        <Mark icon="key" />
        <h1>Set a passphrase</h1>
        <p className="fine">The Mac identity key is derived from this passphrase (Argon2id) and held in memory only while unlocked.</p>
        <Field label="Passphrase"><input className="input input-lg" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus /></Field>
        <Field label="Repeat passphrase"><input className="input input-lg" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        <label className="check fine" style={{ textAlign: "left" }}><input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)} /> Restoring: I have the identity salt from a backup</label>
        {restore && <Field label="Identity salt (base64, from identity.json)"><input className="input hash" value={salt} onChange={(e) => setSalt(e.target.value)} /></Field>}
        <div className="salt-note"><Notice tone="warn">{note}</Notice></div>
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !pass || !again}>{busy ? "Deriving key…" : "Set passphrase"}</button>
        {err && <p className="error" role="alert">{err}</p>}
      </form>
    </div>
  );
}
