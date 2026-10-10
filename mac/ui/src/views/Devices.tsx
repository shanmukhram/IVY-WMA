import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { errText } from "../api.ts";
import { useApi, useEvents, useLoad, useServices } from "../ctx.tsx";
import { Empty, ErrorLine, Mono, Time } from "../ui.tsx";

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
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

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
    <div>
      <ErrorLine error={devs.error} />
      {d && <p>Mac fingerprint: <Mono>{d.macFingerprint}</Mono></p>}
      <h2>Paired devices</h2>
      {d && d.devices.length === 0 && <Empty>No paired devices.</Empty>}
      {d && d.devices.length > 0 && (
        <table>
          <thead><tr><th>Role</th><th>Device id</th><th>Fingerprint</th><th>Paired</th><th>Last seen</th><th>Last report</th><th>App</th><th></th></tr></thead>
          <tbody>{d.devices.map((x: any) => (
            <tr key={x.id}>
              <td>{x.role}</td><td><Mono>{x.id}</Mono></td><td><Mono>{x.fingerprint}</Mono></td><td><Time at={x.pairedAt} /></td>
              <td><Time at={x.lastSeen} /></td><td><Time at={x.lastReportAt} /></td><td>{x.appVersion ?? "—"}</td>
              <td>{confirmRevoke === x.id ? (
                <span className="confirm"><span className="warn small">{x.revokeWarning}</span> <button onClick={() => void revoke(x.id)}>Confirm revoke</button> <button onClick={() => setConfirmRevoke(null)}>Keep</button></span>
              ) : <button onClick={() => setConfirmRevoke(x.id)}>Revoke</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h2>Pair a device</h2>
      <p className="small muted">The code is valid for 10 minutes. On Windows paste the pairing string; on Android scan the QR code. Both screens then show the same Mac fingerprint. After restoring the Mac, initialize with the same passphrase and identity salt and the same Mac key comes back.</p>
      <div className="toolbar">
        <button onClick={() => void start("windows")}>Start pairing: Windows</button>
        <button onClick={() => void start("android")}>Start pairing: Android</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {result && <p className="ok" role="status">{result}</p>}
      {pairing && <PairingPanel p={pairing} onCancel={() => void cancel()} />}
    </div>
  );
}

export function PairingPanel({ p, onCancel }: { p: Pairing; onCancel: () => void }) {
  const { now } = useServices();
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
    <section className="panel pairing" aria-label="Pairing code">
      <p>Pairing <strong>{p.role}</strong> · Mac fingerprint <Mono>{p.macFingerprint}</Mono> · expires in <Mono><span data-testid="countdown">{countdown(left)}</span></Mono></p>
      <div className="pair-cols">
        <div className="qr">
          {svg ? <img alt="Pairing QR code" src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} width={280} height={280} /> : qrErr ? <p className="error">QR failed: {qrErr}</p> : <p className="muted">rendering QR…</p>}
        </div>
        <div className="grow">
          <label>Pairing string
            <textarea readOnly className="mono" rows={6} value={p.pairingString} aria-label="Pairing string" onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button onClick={() => void copy()}>{copied ? "Copied" : "Copy pairing string"}</button> <button onClick={onCancel}>Cancel pairing</button>
          <p className="warn small">The pairing string carries a one-time secret and a read token for the device's command bucket. Do not share it.</p>
        </div>
      </div>
    </section>
  );
}
