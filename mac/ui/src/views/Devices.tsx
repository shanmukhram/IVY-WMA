/** Devices: paired devices, pairing (QR + pairing string in a sheet), revoke with confirmation. */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { errText } from "../api.ts";
import { useApi, useEvents, useLoad, useServices } from "../ctx.tsx";
import { ago, roleLabel } from "../format.ts";
import { Icon } from "../components/Icon.tsx";
import { Empty, ErrorLine, Notice, Time } from "../components/Feedback.tsx";
import { Sheet } from "../components/Overlay.tsx";
import { Link } from "../components/Controls.tsx";

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

  useEvents((ev) => {
    if (ev.type === "pairing.completed" && pairing && ev.data.pairingId === pairing.pairingId) {
      setResult(`Paired ${ev.data.role ?? pairing.role} device. Device fingerprint ${ev.data.fingerprint ?? ev.data.deviceFingerprint ?? "(see list)"}: check that the device shows the same Mac fingerprint ${pairing.macFingerprint}.`);
      setPairing(null);
    }
    if ((ev.type === "pairing.expired" || ev.type === "pairing.cancelled") && pairing && ev.data.pairingId === pairing.pairingId) { setResult(`Pairing code ${ev.type.slice(8)}.`); setPairing(null); }
    if (ev.type === "pairing.rejected") setResult(`A device answer was rejected: ${ev.data.reason ?? "unknown reason"}`);
    devs.reload();
  }, ["pairing.", "device.revoked"]);

  const start = async (role: "windows" | "android") => {
    setErr(null); setResult(null);
    try { setPairing(await api.post<Pairing>("/api/pairings", { role })); } catch (e) { setErr(errText(e)); }
  };
  const cancel = async () => { if (!pairing) return; try { await api.del(`/api/pairings/${pairing.pairingId}`); } catch { /* already gone */ } setPairing(null); };
  const revoke = async (id: string) => {
    setConfirmRevoke(null);
    try { await api.del(`/api/devices/${id}`); setResult("Device revoked. Its R2 tokens stay valid until you rotate them in Cloudflare."); devs.reload(); } catch (e) { setErr(errText(e)); }
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
                  <div style={{ fontWeight: 600 }}>{roleLabel(x.role)} <span className="faint hash small">{x.id}</span></div>
                  <div className="fingerprint small">{x.fingerprint}</div>
                  <div className="row-sub">Paired <Time at={x.pairedAt} /> · last seen {ago(x.lastSeen)} · last report {ago(x.lastReportAt)} · app {x.appVersion ?? "—"}</div>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => setConfirmRevoke(x)}>Revoke</button>
              </div>
            ))}</div>
          )}
          <p className="group-foot">The code is valid for 10 minutes. After restoring the Mac, initialize with the same passphrase and identity salt and the same Mac key comes back.</p>
        </section>
      </div>
      {pairing && <PairingSheet p={pairing} onCancel={() => void cancel()} />}
      {confirmRevoke && (
        <Sheet title={`Revoke ${roleLabel(confirmRevoke.role)}?`} label="Confirm revoke" onClose={() => setConfirmRevoke(null)}
          footer={<><button className="btn" onClick={() => setConfirmRevoke(null)}>Keep</button><button className="btn btn-danger-fill" onClick={() => void revoke(confirmRevoke.id)}>Confirm revoke</button></>}>
          <p className="fingerprint">{confirmRevoke.fingerprint}</p>
          <Notice tone="warn">{confirmRevoke.revokeWarning}</Notice>
        </Sheet>
      )}
    </div>
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
