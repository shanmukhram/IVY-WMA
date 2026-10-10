import { useMemo, useState } from "react";
import { useLoad, useEvents, useDebounced } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { Empty, ErrorLine, Pager, fmtTime } from "../ui.tsx";
import { ItemRow, type Item } from "./items.tsx";
import { AiDrawer } from "./Ai.tsx";

interface Gap { deviceId: string; role: string; collector: string; from: string; to: string; reason: string; open: boolean }
interface TimelineResult {
  window: { from: string; to: string; tz: string }; page: number; pages: number; total: number;
  counts: Record<string, number>; hours: Array<{ index: number; from: string; to: string; count: number }>;
  gaps: Gap[]; items: Item[]; unavailable: Array<{ role: string; reason: string }>;
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const TYPES = ["message", "notification", "screenshot", "photo", "file", "usage", "call", "browsing"];

export function TimelineView() {
  const { query } = useLocation();
  const date = query.get("date") || localDate();
  const page = Number(query.get("page") ?? 1) || 1;
  const device = query.get("device") ?? "";
  const type = query.get("type") ?? "";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const t = useLoad((a) => a.get<TimelineResult>("/api/timeline", { date, tz, page, pageSize: 100, device, type }), [date, page, device, type, tz]);
  const devs = useLoad((a) => a.get("/api/devices"), []);
  const reload = useDebounced(t.reload, 1000);
  useEvents(() => reload(), ["ingest.committed", "coverage.changed", "bin."]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const go = (patch: Record<string, string | number | undefined>) => navigate(href("/timeline", { date, device, type, ...patch }));
  const devices = (devs.data?.devices ?? []) as Array<{ id: string; role: string }>;
  const data = t.data;

  const groups = useMemo(() => {
    if (!data) return [];
    const start = Date.parse(data.window.from);
    const map = new Map<number, Item[]>();
    for (const it of data.items) {
      const h = Math.floor((Date.parse(it.eventTime ?? data.window.from) - start) / 3600_000);
      map.set(h, [...(map.get(h) ?? []), it]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([h, items]) => ({ h, items, total: data.hours.find((x) => x.index === h)?.count ?? items.length, from: new Date(start + h * 3600_000) }));
  }, [data]);

  const locations = (data?.items ?? []).filter((i) => i.detail?.location && typeof i.detail.location.lat === "number");
  const toggle = (h: number) => setCollapsed((s) => { const n = new Set(s); if (n.has(h)) n.delete(h); else n.add(h); return n; });

  return (
    <div>
      <div className="toolbar">
        <label>Date <input type="date" aria-label="Date" value={date} onChange={(e) => go({ date: e.target.value || undefined })} /></label>
        <button onClick={() => { const d = new Date(date + "T12:00:00"); d.setDate(d.getDate() - 1); go({ date: localDate(d) }); }}>Previous day</button>
        <button onClick={() => { const d = new Date(date + "T12:00:00"); d.setDate(d.getDate() + 1); go({ date: localDate(d) }); }}>Next day</button>
        <label>Device
          <select value={device} onChange={(e) => go({ device: e.target.value || undefined })}>
            <option value="">all</option><option value="windows">Windows</option><option value="android">Android</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.role} {d.id.slice(0, 8)}</option>)}
          </select>
        </label>
        <label>Type
          <select value={type} onChange={(e) => go({ type: e.target.value || undefined })}>
            <option value="">all</option>{TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <AiDrawer context={{ date, timeline: true, tz }} label="AI overview of this day" />
        <span className="muted small">times are original event times in {tz}; hover a time for capture/import time</span>
      </div>
      <ErrorLine error={t.error} />
      {data && (
        <>
          <CoverageRibbon from={data.window.from} to={data.window.to} gaps={data.gaps} />
          {data.unavailable.length > 0 && <p className="warn">Unavailable sources: {data.unavailable.map((u) => `${u.role} (${u.reason})`).join(", ")}</p>}
          <p className="muted small" data-testid="timeline-summary">{data.total} records · {Object.entries(data.counts).map(([k, v]) => `${v} ${k}`).join(" · ") || "none"}</p>
          {locations.length > 0 && (
            <section className="map-strip" aria-label="Locations">
              <h3>Locations</h3>
              <ul>{locations.map((i) => <li key={i.id} className="mono">{fmtTime(i.eventTime, false)} {i.detail.location.lat.toFixed(5)}, {i.detail.location.lon.toFixed(5)}</li>)}</ul>
            </section>
          )}
          {data.total === 0 && <Empty>Nothing recorded on {date}. Gaps above show where collectors were not running; empty is not the same as nothing happened.</Empty>}
          {groups.map((g) => (
            <section key={g.h} className="group">
              <button className="group-head" aria-expanded={!collapsed.has(g.h)} onClick={() => toggle(g.h)}>
                <span className="mono">{fmtTime(g.from.toISOString(), false).slice(0, 5)}</span> · {g.items.length}{g.total > g.items.length ? ` of ${g.total}` : ""} record(s) {collapsed.has(g.h) ? "▸" : "▾"}
              </button>
              {!collapsed.has(g.h) && g.items.map((it) => <ItemRow key={`${it.type}:${it.id}`} it={it} devices={devices} />)}
            </section>
          ))}
          {data.pages > 1 && <Pager page={data.page} pages={data.pages} total={data.total} onPage={(p) => go({ page: p })} />}
        </>
      )}
    </div>
  );
}

/** One row per device/collector over the day; red/amber segments are gaps (T5). */
export function CoverageRibbon({ from, to, gaps }: { from: string; to: string; gaps: Gap[] }) {
  const a = Date.parse(from), b = Date.parse(to);
  const rows = new Map<string, Gap[]>();
  for (const g of gaps) rows.set(`${g.role} ${g.collector}`, [...(rows.get(`${g.role} ${g.collector}`) ?? []), g]);
  return (
    <section className="ribbon" aria-label="Coverage ribbon">
      {rows.size === 0 && <p className="muted small">Coverage: no gaps reported by any paired collector for this window.</p>}
      {[...rows.entries()].map(([name, gs]) => (
        <div key={name} className="ribbon-row">
          <span className="ribbon-label">{name}</span>
          <span className="ribbon-bar">
            {gs.map((g, i) => {
              const l = ((Date.parse(g.from) - a) / (b - a)) * 100, w = ((Date.parse(g.to) - Date.parse(g.from)) / (b - a)) * 100;
              return <span key={i} className={`gap gap-${g.reason}`} style={{ left: `${l}%`, width: `${Math.max(w, 0.3)}%` }} title={`${g.reason}: ${fmtTime(g.from)} – ${fmtTime(g.to)}`} />;
            })}
          </span>
          <span className="small muted">{gs.map((g) => `${fmtTime(g.from, false).slice(0, 5)}–${fmtTime(g.to, false).slice(0, 5)} ${g.reason}`).join(", ")}</span>
        </div>
      ))}
    </section>
  );
}
