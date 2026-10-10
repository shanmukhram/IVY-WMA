import { useEffect, useState } from "react";
import { useApi, useEvents } from "../ctx.tsx";
import type { ServiceEvent } from "../events.ts";
import { fmtTime } from "../ui.tsx";

export const FEED_MAX = 500;

/** Prepend newest first, de-duplicated by id, bounded to FEED_MAX. */
export function pushEvent(list: ServiceEvent[], ev: ServiceEvent): ServiceEvent[] {
  if (ev.id !== undefined && list.some((x) => x.id === ev.id)) return list;
  return [ev, ...list].slice(0, FEED_MAX);
}

export function ActivityFeed() {
  const api = useApi();
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    api.get<{ events: ServiceEvent[] }>("/api/activity", { limit: 100 }).then((r) => setEvents((cur) => {
      let out = [...r.events].reverse().reduce(pushEvent, [] as ServiceEvent[]);
      for (const e of [...cur].reverse()) out = pushEvent(out, e);
      return out;
    }), () => undefined);
  }, [api]);
  useEvents((ev) => { if (ev.type !== "hello") setEvents((l) => pushEvent(l, ev)); });
  return (
    <aside className="feed" aria-label="Live activity">
      <button className="feed-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>Live activity ({events.length}) {open ? "▾" : "▸"}</button>
      {open && (
        <ol className="feed-list">
          {events.map((e, i) => (
            <li key={e.id ?? `l${i}-${e.at}`}><span className="mono">{fmtTime(e.at, false)}</span> <strong>{e.type}</strong> <span className="small muted">{summary(e.data)}</span></li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function summary(d: Record<string, unknown>): string {
  return Object.entries(d ?? {}).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object").map(([k, v]) => `${k}=${String(v)}`).join(" ").slice(0, 200);
}
