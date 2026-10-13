/** Per-device view: the device's status card, then the chosen source filtered to that device. */
import { useEffect, useState } from "react";
import { useDebounced, useEvents, useLoad } from "../ctx.tsx";
import { SCOPE_PARAM, navigate, useLocation } from "../router.ts";
import { isRole, scopeRole, useScope } from "../scope.tsx";
import { DEVICE_SOURCES, type DeviceSource, type Role } from "../nav.ts";
import { ago, roleLabel, collectorLabel } from "../format.ts";
import { Icon } from "../components/Icon.tsx";
import { SourceTile } from "../components/AppIcon.tsx";
import { Link } from "../components/Controls.tsx";
import { Badge, Dot, Empty, ErrorLine, Pager, Progress, Time } from "../components/Feedback.tsx";
import { FilesView } from "./Files.tsx";
import { BrowseView } from "./Browse.tsx";
import { MediaView } from "./Media.tsx";
import { NotificationsView } from "./Notifications.tsx";
import { ConversationsView } from "./Conversations.tsx";
import { RecordCard, type Item } from "./records.tsx";

/** Collector names a source may be reported under (device reports name their own collectors). */
const COLLECTOR_NAMES: Record<string, string[]> = {
  files: ["files"], screenshots: ["screenshots"], usage: ["usage"], notifications: ["notifications"], calls: ["calls"], media: ["photos", "media"],
  telegram: ["telegram", "telegram-desktop", "messages"], line: ["line", "line-desktop", "messages"], whatsapp: ["whatsapp", "messages"], sms: ["sms", "messages"],
};

export function DeviceStatusCard({ d }: { d: any }) {
  return (
    <section className="card status-card" aria-label={`${roleLabel(d.role)} status`}>
      <span className="dev-icon"><Icon name={d.role === "windows" ? "laptop" : "phone"} size={24} /></span>
      <div style={{ minWidth: 0 }}>
        <div className="row"><h2 className="status-title">{roleLabel(d.role)}</h2><Dot s={d.status} label={`${d.role} ${d.status}`} /><span className="small muted">{d.status === "green" ? "Working" : d.status === "amber" ? "Stale" : d.status === "red" ? "Needs attention" : "Off"}</span></div>
        <div className="stats">
          <span>Fingerprint <b className="fingerprint">{d.fingerprint}</b></span>
          <span>Last seen <b title={d.lastSeen ?? ""}>{ago(d.lastSeen)}</b></span>
          <span>Last report <b title={d.lastReportAt ?? ""}>{ago(d.lastReportAt)}</b></span>
          <span>Queue <b className="tnum">{d.queueDepthTotal ?? "—"}</b></span>
          <span>Paired <b><Time at={d.pairedAt} /></b></span>
          {d.appVersion && <span>App <b>{d.appVersion}</b></span>}
        </div>
      </div>
      <Link to="/devices" className="btn btn-sm">Pairing</Link>
    </section>
  );
}

function CollectorLine({ c }: { c: any }) {
  return (
    <div className="collector" data-testid={`device-collector-${c.name}`}>
      <div className="c-head"><SourceTile name={c.name} /><Dot s={c.status} label={`${c.name} ${c.status}`} /><span className="c-name">{collectorLabel(c.name)}</span>{!c.enabled && <Badge>disabled</Badge>}<span className="spacer" /><span className="small faint">queue {c.queueDepth}</span></div>
      <span className="c-reason">{c.statusReason} · last run {ago(c.lastRunAt)}</span>
      {c.import && (
        <div className="row small"><Progress value={c.import.percent ?? 0} label={`${c.name} import`} /><span className="tnum faint">{c.import.done ?? c.import.indexed ?? 0}{c.import.total !== null ? ` / ${c.import.total}` : ""} · {String(c.import.state).replace(/_/g, " ")}</span></div>
      )}
    </div>
  );
}

function RecordsList({ type, device, empty }: { type: string; device: string; empty: string }) {
  const [page, setPage] = useState(1);
  const r = useLoad<any>((a) => a.get("/api/views/records", { type, device, page, pageSize: 50 }), [type, device, page]);
  const items = (r.data?.items ?? []) as Item[];
  return (
    <div>
      <ErrorLine error={r.error} />
      {r.data && r.data.total === 0 && <Empty icon={type === "call" ? "call" : "usage"} title={empty}>Records appear here once the collector reports them.</Empty>}
      {items.map((it) => <RecordCard key={it.id} it={it} />)}
      {r.data && r.data.pages > 1 && <Pager page={r.data.page} pages={r.data.pages} total={r.data.total} onPage={setPage} />}
    </div>
  );
}

/** `device` is the role, or one paired device of that role when the scope names one. */
function SourceContent({ role, device, s }: { role: Role; device: string; s: DeviceSource }) {
  const v = s.view;
  const none = `Nothing from ${roleLabel(role)} here yet.`;
  const one = device !== role ? device : undefined;
  if (v.kind === "files") return <FilesView device={device} embedded />;
  if (v.kind === "browse") return <BrowseView key={device} role={role} deviceId={one} />;
  if (v.kind === "media") return <MediaView key={device} device={device} kind={v.mediaKind} embedded emptyText={none} />;
  if (v.kind === "records") return <RecordsList type={v.type} device={device} empty={v.empty} />;
  if (v.kind === "notifications") return <NotificationsView device={device} embedded />;
  return <ConversationsView key={`${device}:${s.key}`} embedded source={v.source} role={v.source ? undefined : role} platform={v.platform} title={`${s.label} · ${roleLabel(role)}`}
    emptyText={`No ${s.label} conversations from ${roleLabel(role)} yet. ${s.captures}`} />;
}

export function DeviceView() {
  const { path } = useLocation();
  const [, , roleRaw, key] = path.split("/");
  const role = (roleRaw === "android" ? "android" : "windows") as Role;
  // this page is scoped to its role, or to one device of the role when the scope already names one
  const { scope, devices: paired } = useScope();
  const inRole = !!scope && (scope === role || scopeRole(scope, paired) === role);
  useEffect(() => {
    if (inRole) return;
    if (scope && !isRole(scope) && !paired) return; // wait for the device list before deciding
    const q = new URLSearchParams(location.search); q.set(SCOPE_PARAM, role);
    navigate(`${location.pathname}?${q.toString()}`, true, false);
  }, [inRole, scope, paired, role]);
  const device = inRole ? scope! : role;
  const cov = useLoad<any>((a) => a.get("/api/coverage"), []);
  const reload = useDebounced(cov.reload, 1500);
  useEvents(() => reload(), ["coverage.changed", "ingest.", "pairing.completed", "device.revoked"]);
  const devices = ((cov.data?.devices ?? []) as any[]).filter((d) => d.role === role && (device === role || d.deviceId === device));
  const source = key ? DEVICE_SOURCES[role].find((s) => s.key === key) : undefined;
  const collectors = devices.flatMap((d) => d.collectors as any[]);
  const forSource = source ? collectors.filter((c) => (COLLECTOR_NAMES[source.key] ?? [source.key]).includes(c.name)) : [];

  return (
    <div className="page page-wide" style={{ maxWidth: 1320 }}>
      <div className="page-head">
        <div>
          <h1>{source ? source.label : roleLabel(role)}</h1>
          <p className="page-sub">{source ? `${roleLabel(role)} · ${source.captures}` : `Everything captured from ${roleLabel(role)}.`}</p>
        </div>
      </div>
      <ErrorLine error={cov.error} />
      {cov.data && devices.length === 0 && (
        <Empty icon={role === "windows" ? "laptop" : "phone"} title={`${roleLabel(role)} is not paired`}
          action={<Link to="/devices" className="btn btn-primary">Pair under Devices</Link>}>
          {role === "android" ? "Nothing from Android yet: pair the phone under Devices." : "Nothing from Windows yet: pair the PC under Devices."}
          {source ? ` ${source.label}: ${source.captures}` : ` Once it reports, its ${DEVICE_SOURCES[role].map((s) => s.label).join(", ")} appear here.`}
        </Empty>
      )}
      {devices.length > 0 && (
        <div className="stack" style={{ gap: 16 }}>
          {devices.map((d) => <DeviceStatusCard key={d.deviceId} d={d} />)}
          {!source && (
            <>
              <h2 className="group-title" style={{ marginTop: 8 }}>Sources</h2>
              <div className="cov-grid">
                {DEVICE_SOURCES[role].map((s) => {
                  const cs = collectors.filter((c) => (COLLECTOR_NAMES[s.key] ?? [s.key]).includes(c.name));
                  const st = cs[0]?.status as string | undefined;
                  return (
                    <Link key={s.key} to={`/device/${role}/${s.key}`} className="collector" aria-label={`${roleLabel(role)} ${s.label}`} style={{ color: "inherit", textDecoration: "none" }}>
                      <div className="c-head"><SourceTile name={s.view.kind === "chats" ? s.view.platform : s.key} glyph={s.icon} /><span className="c-name">{s.label}</span><span className="spacer" />{st ? <Dot s={st} label={`${s.label} ${st}`} /> : <span className="small faint">not reported</span>}</div>
                      <span className="c-captures">{s.captures}</span>
                      {cs[0] && <span className="c-reason">{cs[0].statusReason} · last run {ago(cs[0].lastRunAt)}</span>}
                    </Link>
                  );
                })}
              </div>
              {collectors.length > 0 && (
                <>
                  <h2 className="group-title" style={{ marginTop: 8 }}>Collectors reported by the device</h2>
                  <div className="cov-grid">{collectors.map((c) => <CollectorLine key={c.name} c={c} />)}</div>
                </>
              )}
            </>
          )}
          {source && (
            <>
              {forSource.length > 0 && <div className="cov-grid">{forSource.map((c) => <CollectorLine key={c.name} c={c} />)}</div>}
              <SourceContent role={role} device={device} s={source} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
