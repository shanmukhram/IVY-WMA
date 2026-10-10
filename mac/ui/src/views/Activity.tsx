/** Live activity: every service event, newest first, collected while the dashboard is open; shown in a slide-over. */
import { useEffect, useState } from "react";
import { useApi, useEvents } from "../ctx.tsx";
import type { ServiceEvent } from "../events.ts";
import { fmtTime } from "../format.ts";
import { SlideOver } from "../components/Overlay.tsx";
import { Empty } from "../components/Feedback.tsx";

export const FEED_MAX = 500;

/** Prepend newest first, de-duplicated by id, bounded to FEED_MAX. */
export function pushEvent(list: ServiceEvent[], ev: ServiceEvent): ServiceEvent[] {
  if (ev.id !== undefined && list.some((x) => x.id === ev.id)) return list;
  return [ev, ...list].slice(0, FEED_MAX);
}

/** Collects events for the whole session (mounted by the shell, panel or not). */
export function useActivity(): ServiceEvent[] {
  const api = useApi();
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  useEffect(() => {
    api.get<{ events: ServiceEvent[] }>("/api/activity", { limit: 100 }).then((r) => setEvents((cur) => {
      let out = [...(r?.events ?? [])].reverse().reduce(pushEvent, [] as ServiceEvent[]);
      for (const e of [...cur].reverse()) out = pushEvent(out, e);
      return out;
    }), () => undefined);
  }, [api]);
  useEvents((ev) => { if (ev.type !== "hello") setEvents((l) => pushEvent(l, ev)); });
  return events;
}

function summary(d: Record<string, unknown>): string {
  return Object.entries(d ?? {}).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object").map(([k, v]) => `${k}=${String(v)}`).join(" ").slice(0, 200);
}

export function ActivityPanel({ events, onClose }: { events: ServiceEvent[]; onClose: () => void }) {
  return (
    <SlideOver title="Live activity" label="Live activity" onClose={onClose}>
      {events.length === 0 ? <Empty icon="activity" title="Quiet so far">Sync, ingest, commands and pairing events appear here as they happen, newest first.</Empty> : (
        <ol aria-label="Events">
          {events.map((e, i) => (
            <li key={e.id ?? `l${i}-${e.at}`} className="act-item">
              <time>{fmtTime(e.at, false)}</time>
              <div><div className="act-type">{e.type}</div><div className="act-data">{summary(e.data)}</div></div>
            </li>
          ))}
        </ol>
      )}
    </SlideOver>
  );
}
