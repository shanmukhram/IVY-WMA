/** Notifications (N1-N4): apps in a left column, the stream on the right, grouped by day; every item a partial record. */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { dayKey, dayLabel, shortWhen } from "../format.ts";
import { Avatar } from "../components/Avatar.tsx";
import { SearchField } from "../components/Controls.tsx";
import { Empty, ErrorLine, Notice, Pager } from "../components/Feedback.tsx";
import { RecordCard, type Item } from "./records.tsx";

export function NotificationsView({ device, embedded }: { device?: string; embedded?: boolean } = {}) {
  const loc = useLocation();
  const [local, setLocal] = useState({ app: "", q: "", page: 1 });
  const app = embedded ? local.app : loc.query.get("app") ?? "";
  const q = embedded ? local.q : loc.query.get("q") ?? "";
  const page = embedded ? local.page : Number(loc.query.get("page") ?? 1) || 1;
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const apps = useLoad<any>((a) => (device ? a.get("/api/views/notification-apps", { device }) : a.get("/api/notifications/apps")), [device]);
  const list = useLoad<any>((a) => q.trim()
    ? a.get("/api/search", { q, type: "notification", app, device, page, pageSize: 50 })
    : device ? a.get("/api/views/records", { type: "notification", device, app, page, pageSize: 50 }) : a.get("/api/notifications", { app, page, pageSize: 50 }), [app, q, page, device]);
  const go = (patch: { app?: string; q?: string; page?: number }) => {
    if (embedded) { setLocal((s) => ({ ...s, page: 1, ...patch })); return; }
    navigate(href("/notifications", { app, q, ...patch }));
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go({ q: text, page: 1 }); };
  const appList = (apps.data?.apps ?? []) as Array<{ app: string; source: string; count: number; latest: string }>;
  const d = list.data;
  const days = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of (d?.items ?? []) as Item[]) { const k = dayKey(it.eventTime); m.set(k, [...(m.get(k) ?? []), it]); }
    return [...m.entries()];
  }, [d]);
  const total = appList.reduce((n, a) => n + a.count, 0);

  return (
    <div className="panes" style={embedded ? { height: "auto", minHeight: 480, border: "1px solid var(--separator)", borderRadius: 12, overflow: "hidden" } : undefined}>
      <section className="pane pane-list" aria-label="Apps" style={{ width: 260 }}>
        <div className="pane-head"><h2>{embedded ? "Apps" : "Notifications"}</h2></div>
        <div className="pane-scroll" style={{ padding: 8 }}>
          <button className="app-item" aria-current={!app ? "true" : undefined} onClick={() => go({ app: "", page: 1 })}>
            <span className="app-name">All apps</span><span className="app-count">{total}</span>
          </button>
          {appList.map((a) => (
            <button key={`${a.app}:${a.source}`} className="app-item" aria-current={app === a.app ? "true" : undefined} onClick={() => go({ app: a.app, page: 1 })}>
              <Avatar name={a.app} size={26} />
              <span className="app-name"><span className="ellipsis" style={{ display: "block" }}>{a.app}</span><span className="app-sub">{a.source} · {shortWhen(a.latest)}</span></span>
              <span className="app-count">{a.count}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="pane pane-main" aria-label="Notification stream">
        <div className="pane-head">
          <form onSubmit={submit} role="search" className="row" style={{ flex: 1 }}>
            <SearchField aria-label="Search notifications" placeholder="Search words, senders, phrases" value={text} onChange={(e) => setText(e.target.value)} className="spacer" />
          </form>
        </div>
        <div className="pane-scroll" style={{ padding: "16px 24px" }}>
          <div style={{ marginBottom: 12 }}><Notice tone="warn">Notifications are previews as the device showed them: partial records, not conversations. Text may be truncated or redacted by the app.</Notice></div>
          <ErrorLine error={list.error} />
          {d && d.total === 0 && (
            <Empty icon="bell" title={appList.length === 0 ? "No notifications yet" : "No notifications match"}>
              {appList.length === 0 ? (device === "android" ? "Nothing from Android yet: pair the phone under Devices and enable the notification listener." : "They come from the Windows notification collector and the Android listener.") : "Try another word or app."}
            </Empty>
          )}
          {days.map(([day, its]) => (
            <section key={day} aria-label={day === "unknown" ? "Unknown date" : dayLabel(day)}>
              <h3 className="day-sep">{day === "unknown" ? "Unknown date" : dayLabel(day)}</h3>
              {its.map((it) => <RecordCard key={it.id} it={it} inList />)}
            </section>
          ))}
          {d && d.pages > 1 && <Pager page={d.page} pages={d.pages} total={d.total} onPage={(p) => go({ page: p })} />}
        </div>
      </section>
    </div>
  );
}
