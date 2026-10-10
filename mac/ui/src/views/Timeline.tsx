/**
 * Day timeline (T1-T6): a vertical time axis from 00:00 to 24:00, events placed on it by their
 * original time and grouped by hour (expandable), photos inline, message excerpts, coverage gaps
 * drawn as shaded bands on the axis with a label, capture time on hover, AI overview in a drawer.
 */
import { useMemo, useState } from "react";
import { useLoad, useEvents, useDebounced } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { TYPE_LABEL, TYPE_PLURAL, hm, localDate, longDate, platformLabel, roleLabel } from "../format.ts";
import { Icon } from "../components/Icon.tsx";
import { Link } from "../components/Controls.tsx";
import { Badge, Empty, ErrorLine, Notice, Pager, Time } from "../components/Feedback.tsx";
import { RecordIcon, recordHref, titleOf, type Item } from "./records.tsx";
import { AiDrawer } from "./Ai.tsx";

export interface Gap { deviceId: string; role: string; collector: string; from: string; to: string; reason: string; open: boolean }
export interface TimelineResult {
  window: { from: string; to: string; tz: string }; page: number; pages: number; total: number;
  counts: Record<string, number>; hours: Array<{ index: number; from: string; to: string; count: number }>;
  gaps: Gap[]; items: Item[]; unavailable: Array<{ role: string; reason: string }>;
}

export { localDate };
const TYPES = ["message", "notification", "screenshot", "photo", "file", "usage", "call", "browsing"];
const H = 3600_000;
const COLLAPSE_OVER = 6;

const gapText = (g: Gap) => `${roleLabel(g.role)} ${g.collector} · ${hm(g.from)}–${g.open ? "now" : hm(g.to)} · ${g.reason.replace(/_/g, " ")}`;

/** One label per (device, window, reason): "Windows usage, files · 06:30–10:30 · stale". */
export function gapLabels(gaps: Gap[]): string[] {
  const m = new Map<string, { role: string; cols: string[]; span: string; reason: string }>();
  for (const g of gaps) {
    const span = `${hm(g.from)}–${g.open ? "now" : hm(g.to)}`;
    const k = `${g.role}|${span}|${g.reason}`;
    const e = m.get(k) ?? { role: g.role, cols: [], span, reason: g.reason };
    if (!e.cols.includes(g.collector)) e.cols.push(g.collector);
    m.set(k, e);
  }
  return [...m.values()].map((e) => `${roleLabel(e.role)} ${e.cols.join(", ")} · ${e.span} · ${e.reason.replace(/_/g, " ")}`);
}

/** Where a gap sits inside one hour of the axis, as percentages of that hour (null when it does not touch it). */
export function gapSpan(g: Gap, hourStart: number): { top: number; height: number } | null {
  const a = Math.max(Date.parse(g.from), hourStart), b = Math.min(Date.parse(g.to), hourStart + H);
  if (!(b > a)) return null;
  return { top: ((a - hourStart) / H) * 100, height: Math.max(((b - a) / H) * 100, 2) };
}

function Event({ it }: { it: Item }) {
  const d = it.detail ?? {};
  const to = recordHref(it);
  const isMedia = (it.type === "screenshot" || it.type === "photo") && d.thumbUrl;
  const text = it.type === "message" || it.type === "notification" || it.type === "browsing" ? it.body : it.type === "screenshot" || it.type === "photo" ? (it.ocrText ?? null) : it.type === "file" ? (d.path ?? it.body) : null;
  return (
    <li className="tl-ev" data-testid={`item-${it.type}`}>
      <Time at={it.eventTime} field={it.timeField} captured={it.capturedAt} imported={d.importedAt} short />
      <RecordIcon it={it} small />
      <div className="ev-body">
        <span className="ev-title">{titleOf(it)}</span>
        {text && <span className="ev-text">{text}</span>}
        {isMedia && to && <Link to={to} aria-label={`Open ${it.type} in Media`}><img className="ev-thumb" src={d.thumbUrl} alt={`${it.type} ${it.title ?? ""}`} loading="lazy" /></Link>}
        <span className="ev-meta">
          <span>{TYPE_LABEL[it.type] ?? it.type}</span>
          {it.app && <span>· {it.type === "message" ? platformLabel(it.app) : it.app}</span>}
          {it.type === "notification" && <Badge tone="amber">partial</Badge>}
          {d.sourceStatus === "deleted_at_source" && <Badge tone="red">deleted at source</Badge>}
          {it.type === "browsing" && d.link && <a href={String(d.link)} target="_blank" rel="noreferrer noopener">link</a>}
          {to && !isMedia && <Link to={to}>Open</Link>}
        </span>
      </div>
    </li>
  );
}

export function DayAxis({ data }: { data: TimelineResult }) {
  const start = Date.parse(data.window.from);
  const nHours = Math.max(1, Math.round((Date.parse(data.window.to) - start) / H));
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const groups = useMemo(() => {
    const m = new Map<number, Item[]>();
    for (const it of data.items) {
      const h = Math.min(nHours - 1, Math.max(0, Math.floor((Date.parse(it.eventTime ?? data.window.from) - start) / H)));
      m.set(h, [...(m.get(h) ?? []), it]);
    }
    return m;
  }, [data, start, nHours]);

  return (
    <section className="timeline" aria-label="Day timeline">
      {Array.from({ length: nHours }, (_, h) => {
        const hs = start + h * H;
        const items = groups.get(h) ?? [];
        const total = data.hours.find((x) => x.index === h)?.count ?? items.length;
        const bands = data.gaps.map((g, i) => ({ g, i, span: gapSpan(g, hs) })).filter((x) => x.span);
        const starting = data.gaps.filter((g) => { const f = Date.parse(g.from); return (f >= hs && f < hs + H) || (h === 0 && f < hs && Date.parse(g.to) > hs); });
        const isCollapsed = collapsed[h] ?? items.length > COLLAPSE_OVER;
        const shown = isCollapsed ? items.slice(0, 3) : items;
        return (
          <div key={h} className={`tl-hour${items.length ? "" : " is-empty"}`} data-testid={`hour-${h}`}>
            <span className="tl-hour-label">{hm(new Date(hs).toISOString())}</span>
            <div className="tl-axis">
              {bands.map(({ g, i, span }) => (
                <span key={i} className={`tl-gap reason-${g.reason}`} data-testid="gap-band" title={gapText(g)}
                  style={{ top: `${span!.top}%`, height: `${span!.height}%` }} />
              ))}
            </div>
            <div className="tl-content">
              {gapLabels(starting).map((t) => <span key={t} className="tl-gaplabel" data-testid="gap-label"><Icon name="warn" size={11} />Not captured: {t}</span>)}
              {items.length > 0 && (
                <>
                  <button className="tl-group-head" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => ({ ...c, [h]: !isCollapsed }))}>
                    <Icon name="chevronDown" size={11} className="chev" />
                    {items.length}{total > items.length ? ` of ${total}` : ""} record{items.length === 1 ? "" : "s"} · {hm(new Date(hs).toISOString())}–{hm(new Date(hs + H).toISOString())}
                  </button>
                  <ul className="tl-events">{shown.map((it) => <Event key={`${it.type}:${it.id}`} it={it} />)}</ul>
                  {isCollapsed && items.length > shown.length && (
                    <button className="btn btn-plain btn-sm tl-show-more" onClick={() => setCollapsed((c) => ({ ...c, [h]: false }))}>Show all {items.length}</button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function TimelineView() {
  const { query } = useLocation();
  const date = query.get("date") || localDate();
  const page = Number(query.get("page") ?? 1) || 1;
  const device = query.get("device") ?? "";
  const type = query.get("type") ?? "";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const t = useLoad((a) => a.get<TimelineResult>("/api/timeline", { date, tz, page, pageSize: 500, device, type }), [date, page, device, type, tz]);
  const reload = useDebounced(t.reload, 1000);
  useEvents(() => reload(), ["ingest.committed", "coverage.changed", "bin."]);
  const [aiOpen, setAiOpen] = useState(false);
  const go = (patch: Record<string, string | number | undefined>) => navigate(href("/timeline", { date, device, type, ...patch }));
  const shift = (days: number) => { const d = new Date(date + "T12:00:00"); d.setDate(d.getDate() + days); go({ date: localDate(d), page: undefined }); };
  const data = t.data;
  const locations = (data?.items ?? []).filter((i) => i.detail?.location && typeof i.detail.location.lat === "number");
  const isToday = date === localDate();

  return (
    <div className="page page-wide" style={{ maxWidth: 1280 }}>
      <div className="page-head">
        <div>
          <h1>Timeline</h1>
          <p className="page-sub">Original event times in {tz}; hover a time for capture and import times.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-sm" aria-expanded={aiOpen} onClick={() => setAiOpen((v) => !v)}><Icon name="sparkles" size={13} />AI overview</button>
        </div>
      </div>
      <div className="row-wrap" style={{ marginBottom: 16, gap: 12 }}>
        <div className="datenav" role="group" aria-label="Date">
          <button className="btn btn-icon" onClick={() => shift(-1)} aria-label="Previous day"><Icon name="chevronLeft" size={14} /></button>
          <span className="date-label" aria-live="polite">{longDate(date)}</span>
          <button className="btn btn-icon" onClick={() => shift(1)} aria-label="Next day"><Icon name="chevronRight" size={14} /></button>
        </div>
        <input className="input" type="date" aria-label="Pick a date" value={date} onChange={(e) => go({ date: e.target.value || undefined, page: undefined })} />
        {!isToday && <button className="btn" onClick={() => go({ date: undefined, page: undefined })}>Today</button>}
        <span className="spacer" />
        <select className="select" aria-label="Device" value={device} onChange={(e) => go({ device: e.target.value || undefined, page: undefined })}>
          <option value="">All devices</option><option value="windows">Windows</option><option value="android">Android</option>
        </select>
        <select className="select" aria-label="Type" value={type} onChange={(e) => go({ type: e.target.value || undefined, page: undefined })}>
          <option value="">All types</option>{TYPES.map((x) => <option key={x} value={x}>{TYPE_PLURAL[x]}</option>)}
        </select>
      </div>
      <ErrorLine error={t.error} />
      <div className="with-drawer">
        <div className="content">
          {data && (
            <>
              <div className="tl-summary">
                <span className="muted small" data-testid="timeline-summary">{data.total} records · {Object.entries(data.counts).map(([k, v]) => `${v} ${k}`).join(" · ") || "none"}</span>
                <span className="spacer" />
                <span className="tl-legend"><span><span className="sw" />not captured (coverage gap)</span></span>
              </div>
              {data.unavailable.length > 0 && (
                <div style={{ marginBottom: 12 }}><Notice tone="warn">Unavailable sources: {data.unavailable.map((u) => `${roleLabel(u.role)} (${u.reason})`).join(", ")}. Nothing from them can appear here.</Notice></div>
              )}
              {locations.length > 0 && (
                <section className="card card-pad" aria-label="Locations" style={{ marginBottom: 12 }}>
                  <h2 className="group-title" style={{ marginLeft: 0 }}>Locations</h2>
                  <ul className="small">{locations.map((i) => <li key={i.id} className="tnum">{hm(i.eventTime)} · {i.detail.location.lat.toFixed(5)}, {i.detail.location.lon.toFixed(5)}</li>)}</ul>
                </section>
              )}
              {data.total === 0 && (
                <div style={{ marginBottom: 12 }}><Notice>Nothing recorded on {longDate(date)}. Shaded bands show where collectors were not running; empty is not the same as nothing happened.</Notice></div>
              )}
              <DayAxis data={data} />
              {data.pages > 1 && <Pager page={data.page} pages={data.pages} total={data.total} onPage={(p) => go({ page: p })} />}
            </>
          )}
          {!data && !t.error && <Empty icon="timeline" title="Loading the day…" />}
        </div>
        <AiDrawer open={aiOpen} onClose={() => setAiOpen(false)} context={{ date, timeline: true, tz }} label="AI overview of this day" />
      </div>
    </div>
  );
}
