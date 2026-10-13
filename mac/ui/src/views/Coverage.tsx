/** Coverage (D1-D5, S4, S5, S7): problems pinned on top, a card per device with its collectors, imports, buckets, quarantine. */
import { useState } from "react";
import { errText } from "../api.ts";
import { useApi, useDebounced, useEvents, useLoad } from "../ctx.tsx";
import { useScope } from "../scope.tsx";
import { ago, bytes, fmtTime, hm, roleLabel, collectorLabel } from "../format.ts";
import { Icon } from "../components/Icon.tsx";
import { SourceTile } from "../components/AppIcon.tsx";
import { Link } from "../components/Controls.tsx";
import { Badge, Dot, Empty, ErrorLine, Notice, Progress, Time } from "../components/Feedback.tsx";

interface Gap { collector: string; from: string; to: string; reason: string; open: boolean }

/** Gaps grouped by local date: "2026-10-09: 10:00–11:30 stale". */
export function gapsByDate(gaps: Gap[]): Array<{ date: string; gaps: Gap[] }> {
  const m = new Map<string, Gap[]>();
  for (const g of gaps) { const d = fmtTime(g.from).slice(0, 10); m.set(d, [...(m.get(d) ?? []), g]); }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, gs]) => ({ date, gaps: gs }));
}

const KIND_LABEL: Record<string, string> = { metadata: "metadata", media: "media", previews: "previews", full_messages: "full messages", unknown: "unknown" };

export function CoverageView() {
  const api = useApi();
  const { scope } = useScope();
  const device = scope ?? undefined;
  const cov = useLoad<any>((a) => a.get("/api/coverage", { device }), [device]);
  const quar = useLoad<any>((a) => a.get("/api/quarantine"), []);
  const stats = useLoad<any>((a) => a.get("/api/stats", { device }), [device]);
  const reload = useDebounced(() => { cov.reload(); quar.reload(); stats.reload(); }, 800);
  useEvents(() => reload(), ["coverage.changed", "ingest.", "blob.", "command.", "pairing.completed", "device.revoked", "device.forgotten"]);
  const [msg, setMsg] = useState<string | null>(null);
  const c = cov.data;

  const qAction = async (id: string, action: "retry" | "dismiss") => {
    try {
      if (action === "retry") { const r = await api.post<any>(`/api/quarantine/${id}/retry`, {}); setMsg(`Retry: ${r?.outcome ?? r?.status ?? JSON.stringify(r)}`); }
      else { await api.del(`/api/quarantine/${id}`); setMsg("Dismissed."); }
    } catch (e) { setMsg(errText(e)); }
    reload();
  };
  const counts = stats.data?.counts ?? {};

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Coverage</h1>
          <p className="page-sub">{c ? <>What every device and source captured, as of <Time at={c.at} />.</> : "What every device and source captured."}</p>
        </div>
      </div>
      <ErrorLine error={cov.error} />
      {c && (
        <div className="stack" style={{ gap: 20 }}>
          <section aria-label="Problems">
            <h2 className="group-title">Needs attention</h2>
            <div className="group">
              {c.problems.length === 0 ? (
                <div className="problem"><Dot s="green" label="no problems" /><span>No problems need attention.</span></div>
              ) : c.problems.map((p: any, i: number) => (
                <div key={i} className="problem" data-testid="problem">
                  <Dot s={p.severity} />
                  <div><div>{p.message}</div>
                    <div className="p-src">{p.source?.collector ? `${roleLabel(p.source.role)} · ${p.source.collector}` : p.source?.bucket ? p.source.bucket : p.source?.role ? roleLabel(p.source.role) : "vault"}</div></div>
                </div>
              ))}
            </div>
          </section>

          {c.unpairedRoles?.length > 0 && <Notice tone="warn">Not paired: {c.unpairedRoles.map(roleLabel).join(", ")}. Their sources are not captured. <Link to="/devices">Pair under Devices</Link>.</Notice>}
          {c.devices.length === 0 && <Empty icon="link" title="No devices are paired yet" action={<Link to="/devices" className="btn btn-primary">Pair a device</Link>}>Pair one under Devices; coverage appears once it reports.</Empty>}

          {c.devices.map((d: any) => (
            <section key={d.deviceId} className="card" aria-label={`${d.role} coverage`}>
              <div className="card-head">
                <Icon name={d.role === "windows" ? "laptop" : "phone"} />
                <h2>{roleLabel(d.role)}</h2><Dot s={d.status} label={`${d.role} ${d.status}`} />
                <span className="fingerprint small faint">{d.fingerprint}</span>
                <span className="spacer" />
                <Link to={`/device/${d.role}`} className="btn btn-sm">Open</Link>
              </div>
              <div className="card-body stack">
                <p className="small muted">
                  Last sync (last committed object) <b title={d.lastSeen ?? ""}>{ago(d.lastSeen)}</b> · last report <b title={d.lastReportAt ?? ""}>{ago(d.lastReportAt)}</b> <Dot s={d.reportStatus} label={`report ${d.reportStatus}`} />
                  {" "}· app {d.appVersion ?? "—"} · device queue {d.queueDepthTotal ?? "—"} · queued commands {d.queuedCommands} · quarantined {d.quarantined}
                </p>
                {d.collectors.length === 0 && <p className="muted small">The device has not reported any collectors.</p>}
                <div className="cov-grid">
                  {d.collectors.map((col: any) => (
                    <div key={col.name} className="collector" data-testid={`collector-${d.role}-${col.name}`}>
                      <div className="c-head"><SourceTile name={col.name} /><Dot s={col.status} label={`${col.name} ${col.status}`} /><span className="c-name">{collectorLabel(col.name)}</span>{!col.enabled && <Badge>disabled</Badge>}<span className="spacer" /><Badge>{KIND_LABEL[col.captureKind] ?? col.captureKind}</Badge></div>
                      <span className="c-reason">{col.statusReason}</span>
                      <span className="c-meta"><span>last run {ago(col.lastRunAt)}</span><span>report {ago(col.lastReportAt)}</span><span>queue {col.queueDepth}</span></span>
                      {col.import && (
                        <div className="stack-sm">
                          <div className="row small"><Progress value={col.import.percent ?? 0} label={`${col.name} import progress`} />
                            <span className="tnum">{col.import.done ?? col.import.indexed ?? 0}{col.import.total !== null ? ` / ${col.import.total}` : ""}{col.import.percent !== null ? ` (${col.import.percent}%)` : ""}</span></div>
                          <span className="small faint">{String(col.import.state).replace(/_/g, " ")}{col.import.note ? ` · ${col.import.note}` : ""}</span>
                        </div>
                      )}
                      <span className="c-captures">{col.captures}</span>
                    </div>
                  ))}
                </div>
                {d.pendingBlobs.length > 0 && (
                  <div className="small">
                    <h2 className="group-title">Bulk transfers in progress</h2>
                    <ul className="stack-sm">{d.pendingBlobs.map((b: any) => (
                      <li key={b.oid} className="row"><span className="hash ellipsis" style={{ maxWidth: 220 }}>{b.oid}</span><span>{b.payloadKind ?? "awaiting manifest"}</span>
                        <Progress value={b.committedBytes} max={b.totalSize ?? 0} label={`transfer ${b.oid}`} />
                        <span className="faint">{b.committedParts}/{b.totalChunks ?? "?"} parts · {bytes(b.committedBytes)} of {bytes(b.totalSize)} · {ago(b.updatedAt)}</span></li>
                    ))}</ul>
                  </div>
                )}
                <div className="small">
                  <h2 className="group-title">Gaps (last 7 days)</h2>
                  {d.gaps.length === 0 ? <span className="muted">none</span> : (
                    <ul className="stack-sm">{gapsByDate(d.gaps).map((g) => (
                      <li key={g.date}><b className="tnum">{g.date}</b>: {g.gaps.map((x) => `${x.collector} ${hm(x.from)}–${x.open ? "now" : hm(x.to)} (${x.reason.replace("_", " ")})`).join("; ")}</li>
                    ))}</ul>
                  )}
                </div>
              </div>
            </section>
          ))}

          <ImportsCoverage imports={c.imports} />

          <section aria-label="Index">
            <h2 className="group-title">Index</h2>
            <div className="group">
              <div className="group-row small">
                <span className="row-label">{counts.messages ?? 0} messages · {counts.notifications ?? 0} notifications · {counts.media ?? 0} media · {counts.files ?? 0} files · {counts.usage ?? 0} usage · {counts.calls ?? 0} calls</span>
              </div>
            </div>
          </section>

          <section aria-label="Buckets">
            <h2 className="group-title">Up-buckets</h2>
            {c.buckets.length === 0 ? <div className="group"><div className="group-row muted small">No poll has run yet{c.r2Configured ? "" : " (R2 is not configured)"}.</div></div> : (
              <div className="group">{c.buckets.map((b: any) => (
                <div key={b.bucket} className="group-row"><Dot s={b.ok ? "green" : "red"} label={`${b.bucket} ${b.ok ? "ok" : "failed"}`} />
                  <span className="row-label"><span>{b.bucket}</span><div className="row-sub">last poll {ago(b.lastPollAt)} · last success {ago(b.lastSuccessAt)}{b.error ? ` · ${b.error}` : ""}</div></span></div>
              ))}</div>
            )}
          </section>

          <section aria-label="Quarantine">
            <h2 className="group-title" role="heading" aria-level={3}>Quarantine: {c.quarantineOpen} open</h2>
            {msg && <p className="small muted" role="status" style={{ margin: "0 4px 6px" }}>{msg}</p>}
            <ErrorLine error={quar.error} />
            <div className="group">
              {(quar.data?.items ?? []).length === 0 ? <div className="group-row muted small">Nothing quarantined.</div> : quar.data.items.map((q: any) => (
                <div key={q.id} className="group-row">
                  <span className="row-label"><span className="small">{q.bucket} {q.object_key}</span><div className="row-sub">{q.kind ?? "—"} · {q.reason} · <Time at={q.created_at} /></div></span>
                  <span className="row-control">
                    <button className="btn btn-sm" disabled={!q.stored} title={q.stored ? "" : "ciphertext not kept (too large); retry happens on the next poll if it is still in R2"} onClick={() => void qAction(q.id, "retry")}>Retry</button>
                    <button className="btn btn-sm" onClick={() => void qAction(q.id, "dismiss")}>Dismiss</button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/** Coverage cards for imports that are not devices (S7 / D1-D3). */
export function ImportsCoverage({ imports }: { imports?: any[] }) {
  if (!imports?.length) return null;
  return (
    <section aria-label="Imports">
      <h2 className="group-title">Imports</h2>
      <div className="group">
        {imports.map((im) => (
          <div key={im.source} className="group-row" style={{ alignItems: "flex-start" }} data-testid={`import-${im.source}`}>
            <SourceTile name="google" />
            <span style={{ paddingTop: 12 }}><Dot s={im.status} label={`${im.name} ${im.status}`} /></span>
            <div className="row-label stack-sm" style={{ gap: 4 }}>
              <div><b>{im.name}</b> · {im.statusReason}{im.location ? <div className="row-sub path">{im.location}</div> : null}</div>
              <div className="row-sub">last run {ago(im.lastRunAt)} · last success {ago(im.lastSuccessAt)} · {im.rowsTotal} rows{im.lastRowsAdded !== null ? ` (+${im.lastRowsAdded} last run)` : ""} · captures {im.captures}</div>
              <div className="small">
                <span className="faint">Days without rows (last {im.gapWindowDays}): </span>
                {im.gaps.length === 0 ? <span className="muted">none{im.firstRowAt ? "" : " (nothing imported yet)"}</span> : (
                  <ul>{im.gaps.map((g: any) => <li key={g.date}><span className="tnum">{g.date}</span> {g.state === "gap" ? <b className="warn-text">gap</b> : <span className="muted">unknown</span>} · {g.note}</li>)}</ul>
                )}
                {im.captureReported === null && im.lastSuccessAt ? <div className="muted">the source does not report its capture status</div> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
