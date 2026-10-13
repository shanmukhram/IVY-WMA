/**
 * Devices: paired devices, pairing (QR + pairing string in a sheet), naming a device, revoke with
 * confirmation, and forget: remove an old device and everything it captured from this Mac, confirmed with
 * its fingerprint. A device's name is kept on this Mac only; the fingerprint stays its stable identifier.
 * Revoke and forget both tell the device to reset (an unpair command); "Recently removed" lists the devices
 * removed in the last 30 days and whether each has confirmed the reset.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ApiError, errText } from "../api.ts";
import { useApi, useEvents, useLoad, useServices } from "../ctx.tsx";
import { ago, bytes, roleLabel } from "../format.ts";
import { SCOPE_PARAM, navigate } from "../router.ts";
import { Icon } from "../components/Icon.tsx";
import { Empty, ErrorLine, Notice, Time } from "../components/Feedback.tsx";
import { Sheet } from "../components/Overlay.tsx";
import { Link } from "../components/Controls.tsx";
import { deviceLabel } from "../scope.tsx";

interface Pairing { pairingId: string; role: string; pairingString: string; macFingerprint: string; expiresAt: string }

export function countdown(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function DevicesView() {
  const api = useApi();
  const devs = useLoad<any>((a) => a.get("/api/devices"), []);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<any>(null);
  const [forgetting, setForgetting] = useState<any>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEvents((ev) => {
    if (ev.type === "pairing.completed" && pairing && ev.data.pairingId === pairing.pairingId) {
      setResult(`Paired ${ev.data.role ?? pairing.role} device. Device fingerprint ${ev.data.fingerprint ?? ev.data.deviceFingerprint ?? "(see list)"}: check that the device shows the same Mac fingerprint ${pairing.macFingerprint}.`);
      setPairing(null);
    }
    if ((ev.type === "pairing.expired" || ev.type === "pairing.cancelled") && pairing && ev.data.pairingId === pairing.pairingId) { setResult(`Pairing code ${ev.type.slice(8)}.`); setPairing(null); }
    if (ev.type === "pairing.rejected") setResult(`A device answer was rejected: ${ev.data.reason ?? "unknown reason"}`);
    devs.reload();
  }, ["pairing.", "device.revoked", "device.forgotten", "device.renamed", "device.unpair_confirmed"]);

  const start = async (role: "windows" | "android") => {
    setErr(null); setResult(null);
    try { setPairing(await api.post<Pairing>("/api/pairings", { role })); } catch (e) { setErr(errText(e)); }
  };
  const cancel = async () => { if (!pairing) return; try { await api.del(`/api/pairings/${pairing.pairingId}`); } catch { /* already gone */ } setPairing(null); };
  const revoke = async (id: string) => {
    setConfirmRevoke(null);
    try {
      const r = await api.del<UnpairOutcome>(`/api/devices/${id}`);
      setResult(`Device revoked. What it captured stays in the archive. ${unpairText(r)} Its R2 tokens stay valid until you rotate them in Cloudflare.`);
      devs.reload();
    } catch (e) { setErr(errText(e)); }
  };
  const forgotten = (id: string) => {
    devs.reload();
    // the device scope pointed at the device that is gone: return to every device
    const q = new URLSearchParams(location.search);
    if (q.get(SCOPE_PARAM) === id) { q.delete(SCOPE_PARAM); navigate(`${location.pathname}${q.toString() ? `?${q}` : ""}`, true, false); }
  };

  const d = devs.data;
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div><h1>Devices</h1><p className="page-sub">Paired capture devices. Both screens show the same Mac fingerprint after pairing.</p></div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => void start("windows")}><Icon name="laptop" size={14} />Start pairing: Windows</button>
          <button className="btn btn-primary" onClick={() => void start("android")}><Icon name="phone" size={14} />Start pairing: Android</button>
        </div>
      </div>
      <div className="stack" style={{ gap: 20 }}>
        <ErrorLine error={devs.error} />
        {err && <Notice tone="error" role="alert">{err}{/r2_unavailable|R2/.test(err) ? <> · <Link to="/settings?section=r2">Set up Cloudflare R2 in Settings</Link></> : null}</Notice>}
        {result && <Notice tone="ok" role="status">{result}</Notice>}
        {d && (
          <section aria-label="This Mac">
            <h2 className="group-title">This Mac</h2>
            <div className="group"><div className="group-row"><Icon name="shield" /><span className="row-label">Mac fingerprint</span><span className="fingerprint">{d.macFingerprint}</span></div></div>
          </section>
        )}
        <section aria-label="Paired devices">
          <h2 className="group-title">Paired devices</h2>
          {d && d.devices.length === 0 && <div className="group"><Empty icon="link" title="No paired devices">Start pairing above: on Windows paste the pairing string, on Android scan the QR code.</Empty></div>}
          {d && d.devices.length > 0 && (
            <div className="group">{d.devices.map((x: any) => (
              <div key={x.id} className="group-row" style={{ alignItems: "flex-start", paddingTop: 12, paddingBottom: 12 }}>
                <span className="dev-icon" style={{ width: 36, height: 36, borderRadius: 9, background: "var(--fill-2)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name={x.role === "windows" ? "laptop" : "phone"} size={18} /></span>
                <div className="row-label">
                  <div style={{ fontWeight: 600 }} className={x.name ? undefined : "fingerprint"} data-testid={`device-title-${x.id}`}>{deviceLabel(x)}</div>
                  <div className="small muted">{roleLabel(x.role)} · {x.name ? <>fingerprint <span className="fingerprint">{x.fingerprint}</span></> : "no name yet (shown by its fingerprint)"} · <span className="faint hash">{x.id}</span></div>
                  <div className="row-sub">Paired <Time at={x.pairedAt} /> · last seen {ago(x.lastSeen)} · last report {ago(x.lastReportAt)} · app {x.appVersion ?? "—"}</div>
                  {renaming === x.id && <RenameField device={x} onDone={() => { setRenaming(null); devs.reload(); }} onCancel={() => setRenaming(null)} />}
                </div>
                <div className="row">
                  <button className="btn btn-sm" onClick={() => setRenaming(renaming === x.id ? null : x.id)} aria-expanded={renaming === x.id} aria-label={`Rename ${deviceLabel(x)}`}>Rename</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmRevoke(x)}>Revoke</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setForgetting(x)}>Forget…</button>
                </div>
              </div>
            ))}</div>
          )}
          <p className="group-foot">The code is valid for 10 minutes. After restoring the Mac, initialize with the same passphrase and identity salt and the same Mac key comes back.</p>
        </section>
        {d && d.removed?.length > 0 && <RemovedList removed={d.removed} />}
      </div>
      {pairing && <PairingSheet p={pairing} onCancel={() => void cancel()} />}
      {confirmRevoke && (
        <Sheet title={`Revoke ${roleLabel(confirmRevoke.role)} · ${deviceLabel(confirmRevoke)}?`} label="Confirm revoke" onClose={() => setConfirmRevoke(null)}
          footer={<><button className="btn" onClick={() => setConfirmRevoke(null)}>Keep</button><button className="btn btn-danger-fill" onClick={() => void revoke(confirmRevoke.id)}>Confirm revoke</button></>}>
          <p className="fingerprint">{confirmRevoke.fingerprint}</p>
          <p>Revoke stops this device: the Mac drops its key, ignores its new uploads and sends it no more commands. Everything it already captured stays in the archive on this Mac. To remove that as well, use Forget.</p>
          <p>{resetSentence(confirmRevoke.role)}</p>
          <Notice tone="warn">{confirmRevoke.revokeWarning}</Notice>
        </Sheet>
      )}
      {forgetting && <ForgetSheet device={forgetting} onClose={() => setForgetting(null)} onForgotten={forgotten} />}
    </div>
  );
}

/** What a revoke or forget reports about telling the device to reset. */
interface UnpairOutcome { unpairSent?: boolean; unpairReason?: string | null }

/** A device the Mac revoked or forgot in the last 30 days (GET /api/devices `removed`). */
export interface RemovedDevice {
  id: string; role: string; name: string | null; fingerprint: string; removedAt: string; kind: "revoked" | "forgotten";
  unpairSentAt: string | null; unpairConfirmedAt: string | null; unpairDetail?: string | null;
}

const devWord = (role: string) => (role === "windows" ? "PC" : "device");

/** The revoke and forget sheets say what happens on the device. */
export function resetSentence(role: string): string {
  const w = devWord(role);
  return `The ${w} is told to reset and shows its pairing page again; pair it from here when you want it back.`;
}

/** One line on whether the device was told to reset, for the result of a revoke or forget. */
export function unpairText(r: UnpairOutcome): string {
  if (r.unpairSent) return "The device is told to reset; it resets on its next check-in.";
  return r.unpairReason ?? "The device could not be told to reset.";
}

export const WAITING_TEXT = (role: string) =>
  `Waiting for the ${devWord(role)} to reset (it resets on its next check-in, within about 2 minutes while online)`;

/** Devices removed in the last 30 days, each with its reset state: confirmed, waiting, or not told. */
export function RemovedList({ removed }: { removed: RemovedDevice[] }) {
  return (
    <section aria-label="Recently removed">
      <h2 className="group-title">Recently removed</h2>
      <div className="group">{removed.map((x) => (
        <div key={`${x.kind}-${x.id}`} className="group-row" data-testid={`removed-${x.id}`} style={{ alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
          <Icon name={x.role === "windows" ? "laptop" : "phone"} />
          <div className="row-label">
            <div style={{ fontWeight: 600 }} className={x.name ? undefined : "fingerprint"}>{deviceLabel(x)}</div>
            <div className="small muted">{roleLabel(x.role)} · {x.kind === "forgotten" ? "Forgotten" : "Revoked"} <Time at={x.removedAt} />{x.name ? <> · fingerprint <span className="fingerprint">{x.fingerprint}</span></> : null}</div>
            <div className="row-sub" role="status" data-testid={`removed-state-${x.id}`}>
              {x.unpairConfirmedAt
                ? <>{devWord(x.role) === "PC" ? "PC" : "Device"} reset confirmed <Time at={x.unpairConfirmedAt} /></>
                : x.unpairSentAt
                  ? WAITING_TEXT(x.role)
                  : `Not told to reset: ${x.unpairDetail ?? "the unpair command could not be sent."}`}
            </div>
          </div>
        </div>
      ))}</div>
      <p className="group-foot">Removed devices are listed here for 30 days.</p>
    </section>
  );
}

/** Longest name the service accepts (PATCH /api/devices/:id). */
export const DEVICE_NAME_MAX = 60;

function renameError(e: unknown): string {
  if (e instanceof ApiError && e.status === 400) return `The name was not saved: ${e.message}.`;
  if (e instanceof ApiError && e.status === 404) return "This device is no longer paired; reload the list.";
  return errText(e);
}

/** Inline field that names a device. Enter or Save stores it; an empty field clears the name. */
export function RenameField({ device, onDone, onCancel }: { device: { id: string; name?: string | null; fingerprint: string }; onDone: () => void; onCancel: () => void }) {
  const api = useApi();
  const [value, setValue] = useState(device.name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/devices/${encodeURIComponent(device.id)}`, { name: value.trim() === "" ? null : value });
      onDone();
    } catch (e) { setErr(renameError(e)); } finally { setBusy(false); }
  };
  return (
    <form className="stack-sm" style={{ marginTop: 8 }} aria-label="Rename device" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <span className="row" style={{ flexWrap: "wrap" }}>
        <input className="input" aria-label="Device name" placeholder={`No name: shown as ${device.fingerprint}`} autoFocus autoComplete="off" value={value}
          onChange={(e) => { setValue(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} style={{ flex: 1, minWidth: 200 }} />
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        {device.name && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setValue("")}>Clear</button>}
        <button type="button" className="btn btn-sm btn-plain" onClick={onCancel}>Cancel</button>
      </span>
      <span className="small faint">Up to {DEVICE_NAME_MAX} characters. Leave empty to show the fingerprint instead. The name stays on this Mac.</span>
      {err && <Notice tone="error" role="alert">{err}</Notice>}
    </form>
  );
}

export function PairingSheet({ p, onCancel }: { p: Pairing; onCancel: () => void }) {
  const { now, api } = useServices();
  const [checking, setChecking] = useState<string | null>(null);
  // the device answers through its up-bucket; the next poll completes pairing (or check now)
  const checkNow = async () => {
    setChecking("Checking…");
    try { await api.post("/api/ingest/poll", {}); setChecking("Checked. Waiting for the device's answer…"); } catch (e) { setChecking(`Check failed: ${errText(e)}`); }
  };
  const clock = now ?? Date.now;
  const [svg, setSvg] = useState<string | null>(null);
  const [qrErr, setQrErr] = useState<string | null>(null);
  const [left, setLeft] = useState(() => Date.parse(p.expiresAt) - clock());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    QRCode.toString(p.pairingString, { type: "svg", errorCorrectionLevel: "L", margin: 2, color: { dark: "#000000", light: "#ffffff" } })
      .then((s) => live && setSvg(s), (e) => live && setQrErr(String(e)));
    return () => { live = false; };
  }, [p.pairingString]);
  useEffect(() => {
    const t = setInterval(() => setLeft(Date.parse(p.expiresAt) - clock()), 1000);
    return () => clearInterval(t);
  }, [p.expiresAt, clock]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(p.pairingString); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <Sheet title={`Pair ${roleLabel(p.role)}`} label="Pairing" wide onClose={onCancel}
      footer={<>{checking && <span className="small muted" role="status" style={{ marginRight: "auto" }}>{checking}</span>}<button className="btn" onClick={onCancel}>Cancel pairing</button><button className="btn" onClick={() => void checkNow()}><Icon name="sync" size={13} />Check now</button><button className="btn btn-primary" onClick={() => void copy()}><Icon name="doc" size={13} />{copied ? "Copied" : "Copy pairing string"}</button></>}>
      <section aria-label="Pairing code" className="stack">
        <p className="muted">{p.role === "android" ? "Scan the QR code with the IVY Android app." : "Paste the pairing string into the IVY Windows app."} The Mac picks up the answer on its next sync. Expires in <span className="countdown" data-testid="countdown">{countdown(left)}</span>.</p>
        <div className="pair-cols">
          <div className="qr-box">
            {svg ? <img alt="Pairing QR code" src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} width={200} height={200} /> : qrErr ? <p className="error">QR failed: {qrErr}</p> : <p className="muted">rendering QR…</p>}
          </div>
          <div className="stack">
            <label className="field"><span className="field-label">Pairing string</span>
              <textarea readOnly className="textarea hash" rows={6} value={p.pairingString} aria-label="Pairing string" onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="stack-sm"><span className="small muted">Mac fingerprint</span><span className="fingerprint">{p.macFingerprint}</span></div>
          </div>
        </div>
        <Notice tone="warn">The pairing string carries a one-time secret and a read token for the device's command bucket. Do not share it.</Notice>
      </section>
    </Sheet>
  );
}

/** What GET /api/devices/:id/footprint reports: what a forget removes from the Mac and what stays in R2. */
interface Footprint {
  deviceId: string; role: string; fingerprint: string;
  counts: Record<string, number>;
  shared: { messagesKept: number; conversationsKept: number };
  binRows: number; cacheBytes: number;
  leftInR2: { objects: number; bytes: number };
}
interface ForgetResult extends UnpairOutcome {
  removed: Record<string, number>; shared: Footprint["shared"]; binPurged: number;
  cacheBytesFreed: number; leftInR2Bytes: number; leftInR2Objects: number; r2Note: string; tokenWarning: string;
}

const num = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
/** The service compares the confirmation this way: surrounding spaces and letter case are ignored. */
const normFp = (s: string) => s.trim().toUpperCase();

/** "Removed 1,250 messages, 160,000 files, …; 3.2 GB of media stays in R2." */
export function forgetSummary(r: ForgetResult): string {
  const c = r.removed ?? {};
  const parts = ([
    [c.messages, "message"], [c.conversations, "conversation"], [c.files, "file"], [c.media, "photo or screenshot", "photos and screenshots"],
    [c.notifications, "notification"], [c.calls, "call"], [c.usageEvents, "app usage event"],
  ] as Array<[number | undefined, string, string?]>).filter(([n]) => (n ?? 0) > 0).map(([n, one, many]) => plural(n!, one, many));
  const r2 = r.leftInR2Objects > 0 ? `${bytes(r.leftInR2Bytes)} of media stays in R2` : "nothing of this device's media was kept in R2";
  return `Removed ${parts.length ? parts.join(", ") : "no records"} and freed ${bytes(r.cacheBytesFreed)} of local cache; ${r2}.`;
}

function forgetError(e: unknown): string {
  if (e instanceof ApiError && e.status === 400 && e.code === "bad_confirm") return "That is not this device's fingerprint. Type it exactly as shown; letter case and spaces at either end do not matter.";
  if (e instanceof ApiError && e.status === 404) return "This device is no longer paired. It may already have been forgotten or revoked; reload the list.";
  return errText(e);
}

/** Forget a device: show what goes and what stays, confirm with the fingerprint, then show what was removed. */
export function ForgetSheet({ device, onClose, onForgotten }: { device: { id: string; role: string; fingerprint: string; name?: string | null }; onClose: () => void; onForgotten: (id: string) => void }) {
  const api = useApi();
  const fp = useLoad<Footprint>((a) => a.get(`/api/devices/${encodeURIComponent(device.id)}/footprint`), [device.id]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ForgetResult | null>(null);
  const matches = typed.trim() !== "" && normFp(typed) === normFp(device.fingerprint);
  const f = fp.data;
  const c = f?.counts ?? {};

  const forget = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.del<ForgetResult>(`/api/devices/${encodeURIComponent(device.id)}?wipe=1`, { confirm: typed.trim() });
      setDone(r);
      onForgotten(device.id);
    } catch (e) { setErr(forgetError(e)); } finally { setBusy(false); }
  };

  const label = `${roleLabel(device.role)} · ${deviceLabel(device)}`;
  const title = `Forget ${label}?`;
  if (done) {
    return (
      <Sheet title={`${label} forgotten`} label="Forget device" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <Notice tone="ok" role="status">{forgetSummary(done)}</Notice>
        {done.binPurged > 0 && <p className="small muted">{plural(done.binPurged, "item")} of this device in the recovery bin were removed too.</p>}
        <p className="small">{unpairText(done)}</p>
        <p className="small">{done.r2Note}</p>
        <Notice tone="warn">{done.tokenWarning}</Notice>
      </Sheet>
    );
  }
  return (
    <Sheet title={title} label="Forget device" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Keep</button><button className="btn btn-danger-fill" disabled={!matches || !f || busy} onClick={() => void forget()}>{busy ? "Forgetting…" : "Forget this device"}</button></>}>
      <p>Forgetting removes this device and everything it captured from the archive on this Mac. It cannot be undone. Revoke instead if you want to keep what it captured.</p>
      <p>{resetSentence(device.role)}</p>
      {fp.loading && !f && <p className="muted small" role="status">Counting what this device captured…</p>}
      {fp.error ? <Notice tone="error" role="alert">{forgetError(fp.error)}</Notice> : null}
      {f && (
        <>
          <section aria-label="Removed from this Mac" className="stack-sm">
            <h3>Removed from this Mac</h3>
            <dl className="kv" data-testid="forget-footprint">
              <dt>Messages</dt><dd className="tnum">{num(c.messages)}{f.shared.messagesKept > 0 ? ` (${plural(f.shared.messagesKept, "message")} kept, because another device also captured them)` : ""}</dd>
              <dt>Conversations</dt><dd className="tnum">{num(c.conversations)}{f.shared.conversationsKept > 0 ? ` (${plural(f.shared.conversationsKept, "conversation")} kept, with the messages another device also captured)` : ""}</dd>
              <dt>Files</dt><dd className="tnum">{num(c.files)}</dd>
              <dt>Photos and screenshots</dt><dd className="tnum">{num(c.media)}</dd>
              <dt>Notifications</dt><dd className="tnum">{num(c.notifications)}</dd>
              <dt>Calls</dt><dd className="tnum">{num(c.calls)}</dd>
              <dt>App usage events</dt><dd className="tnum">{num(c.usageEvents)}</dd>
              <dt>Local cache freed</dt><dd className="tnum">{bytes(f.cacheBytes)}</dd>
            </dl>
            {f.binRows > 0 && <p className="small muted">{plural(f.binRows, "item")} of this device in the recovery bin are removed too and cannot be restored.</p>}
          </section>
          <section aria-label="Stays in R2" className="stack-sm">
            <h3>Stays in R2</h3>
            <p data-testid="forget-r2">{f.leftInR2.objects > 0 ? `${plural(f.leftInR2.objects, "media original")} (${bytes(f.leftInR2.bytes)}) stay in your R2 bucket.` : "This device has no media originals kept in R2."}</p>
            <p className="small muted">What this device uploaded to R2 is not changed: nothing there is listed or deleted, and the Mac ignores anything this device left there. The only R2 write is the reset command for the device. The device's R2 token still works until you rotate it in Cloudflare.</p>
          </section>
          <label className="field">
            <span className="field-label">Type the fingerprint to confirm</span>
            <span className="row" style={{ flexWrap: "wrap" }}>
              <input className="input" aria-label="Type the fingerprint to confirm" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => { setTyped(e.target.value); setErr(null); }} style={{ flex: 1, minWidth: 200 }} />
              <span className="fingerprint" data-testid="forget-fingerprint">{device.fingerprint}</span>
            </span>
          </label>
        </>
      )}
      {err && <Notice tone="error" role="alert">{err}</Notice>}
    </Sheet>
  );
}
