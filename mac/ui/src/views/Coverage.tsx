import { useState } from "react";
import { errText } from "../api.ts";
import { useApi, useDebounced, useEvents, useLoad } from "../ctx.tsx";
import { Dot, Empty, ErrorLine, Mono, Time, bytes, fmtTime } from "../ui.tsx";

interface Gap { collector: string; from: string; to: string; reason: string; open: boolean }

/** Gaps grouped by local date: "2026-10-09: 10:00–11:30 stale". */
export function gapsByDate(gaps: Gap[]): Array<{ date: string; gaps: Gap[] }> {
  const m = new Map<string, Gap[]>();
  for (const g of gaps) { const d = fmtTime(g.from).slice(0, 10); m.set(d, [...(m.get(d) ?? []), g]); }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, gs]) => ({ date, gaps: gs }));
}

export function CoverageView() {
  const api = useApi();
  const cov = useLoad<any>((a) => a.get("/api/coverage"), []);
  const quar = useLoad<any>((a) => a.get("/api/quarantine"), []);
  const reload = useDebounced(() => { cov.reload(); quar.reload(); }, 800);
  useEvents(() => reload(), ["coverage.changed", "ingest.", "blob.", "command.", "pairing.completed", "device.revoked"]);
  const [msg, setMsg] = useState<string | null>(null);
  const c = cov.data;

  const qAction = async (id: string, action: "retry" | "dismiss") => {
    try {
      if (action === "retry") { const r = await api.post<any>(`/api/quarantine/${id}/retry`, {}); setMsg(`Retry: ${r?.outcome ?? r?.status ?? JSON.stringify(r)}`); }
      else { await api.del(`/api/quarantine/${id}`); setMsg("Dismissed."); }
    } catch (e) { setMsg(errText(e)); }
    reload();
  };

  return (
    <div>
      <ErrorLine error={cov.error} />
      {c && (
        <>
          <section aria-label="Problems" className="problems">
            <h2><Dot s={c.status} label={`overall ${c.status}`} /> Coverage <span className="small muted">as of <Time at={c.at} /></span></h2>
            {c.problems.length === 0 ? <p className="ok">No problems need attention.</p> : (
              <ul>{c.problems.map((p: any, i: number) => (
                <li key={i} data-testid="problem"><Dot s={p.severity} /> {p.message}{p.source?.collector ? <span className="muted"> · {p.source.role} / {p.source.collector}</span> : p.source?.bucket ? <span className="muted"> · {p.source.bucket}</span> : null}</li>
              ))}</ul>
            )}
          </section>

          {c.unpairedRoles?.length > 0 && <p className="warn">Not paired: {c.unpairedRoles.join(", ")}. Their sources are not captured.</p>}
          {c.devices.length === 0 && <Empty>No devices are paired yet. Pair one under Devices.</Empty>}

          {c.devices.map((d: any) => (
            <section key={d.deviceId} className="device-cov" aria-label={`${d.role} coverage`}>
              <h3><Dot s={d.status} label={`${d.role} ${d.status}`} /> {d.role} <Mono>{d.fingerprint}</Mono></h3>
              <p className="small">
                last sync (last committed object) <Time at={d.lastSeen} /> · last report <Time at={d.lastReportAt} /> <Dot s={d.reportStatus} label={`report ${d.reportStatus}`} />
                {" "}· app {d.appVersion ?? "—"} · device queue {d.queueDepthTotal ?? "—"} · queued commands {d.queuedCommands} · quarantined {d.quarantined}
              </p>
              <table>
                <thead><tr><th></th><th>Collector</th><th>Status</th><th>Last run</th><th>Last report</th><th>Queue</th><th>Import progress</th><th>Captures</th></tr></thead>
                <tbody>
                  {d.collectors.length === 0 && <tr><td colSpan={8} className="muted">The device has not reported any collectors.</td></tr>}
                  {d.collectors.map((col: any) => (
                    <tr key={col.name} data-testid={`collector-${d.role}-${col.name}`}>
                      <td><Dot s={col.status} label={`${col.name} ${col.status}`} /></td>
                      <td>{col.name}{!col.enabled && <span className="muted"> (disabled)</span>}</td>
                      <td>{col.statusReason}</td>
                      <td><Time at={col.lastRunAt} /></td>
                      <td><Time at={col.lastReportAt} /></td>
                      <td>{col.queueDepth}</td>
                      <td>{col.import ? (
                        <>
                          {col.import.indexed}{col.import.total !== null ? ` / ${col.import.total}` : ""}{col.import.percent !== null ? ` (${col.import.percent}%)` : ""} · {col.import.state.replace(/_/g, " ")}
                          {col.import.total ? <progress max={100} value={col.import.percent ?? 0} /> : null}
                          {col.import.note && <div className="small muted">{col.import.note}</div>}
                        </>
                      ) : "—"}</td>
                      <td className="small">{col.captures} <span className="muted">[{col.captureKind}]</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.pendingBlobs.length > 0 && (
                <div className="small">
                  <strong>Bulk transfers in progress</strong>
                  <ul>{d.pendingBlobs.map((b: any) => (
                    <li key={b.oid}><Mono>{b.oid}</Mono> {b.payloadKind ?? "awaiting manifest"} · {b.committedParts}/{b.totalChunks ?? "?"} parts · {bytes(b.committedBytes)} of {bytes(b.totalSize)} · updated <Time at={b.updatedAt} /></li>
                  ))}</ul>
                </div>
              )}
              <div className="small">
                <strong>Gaps (last 7 days)</strong>
                {d.gaps.length === 0 ? <span className="muted"> none</span> : (
                  <ul>{gapsByDate(d.gaps).map((g) => (
                    <li key={g.date}><Mono>{g.date}</Mono>: {g.gaps.map((x) => `${x.collector} ${fmtTime(x.from, false).slice(0, 5)}–${x.open ? "now" : fmtTime(x.to, false).slice(0, 5)} (${x.reason.replace("_", " ")})`).join("; ")}</li>
                  ))}</ul>
                )}
              </div>
            </section>
          ))}

          <section aria-label="Buckets">
            <h3>Up-buckets</h3>
            {c.buckets.length === 0 ? <Empty>No poll has run yet{c.r2Configured ? "" : " (R2 is not configured)"}.</Empty> : (
              <table>
                <thead><tr><th></th><th>Bucket</th><th>Last poll</th><th>Last success</th><th>Error</th></tr></thead>
                <tbody>{c.buckets.map((b: any) => (
                  <tr key={b.bucket}><td><Dot s={b.ok ? "green" : "red"} /></td><td><Mono>{b.bucket}</Mono></td><td><Time at={b.lastPollAt} /></td><td><Time at={b.lastSuccessAt} /></td><td>{b.error ?? ""}</td></tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section aria-label="Quarantine">
            <h3>Quarantine: {c.quarantineOpen} open</h3>
            {msg && <p className="muted" role="status">{msg}</p>}
            <ErrorLine error={quar.error} />
            {(quar.data?.items ?? []).length === 0 ? <p className="muted small">Nothing quarantined.</p> : (
              <table>
                <thead><tr><th>When</th><th>Bucket / key</th><th>Kind</th><th>Reason</th><th></th></tr></thead>
                <tbody>{quar.data.items.map((q: any) => (
                  <tr key={q.id}>
                    <td><Time at={q.created_at} /></td><td><Mono>{q.bucket} {q.object_key}</Mono></td><td>{q.kind ?? "—"}</td><td>{q.reason}</td>
                    <td><button disabled={!q.stored} title={q.stored ? "" : "ciphertext not kept (too large); retry happens on the next poll if it is still in R2"} onClick={() => void qAction(q.id, "retry")}>Retry</button> <button onClick={() => void qAction(q.id, "dismiss")}>Dismiss</button></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
