import { useEffect, useState, type FormEvent } from "react";
import { useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { Empty, ErrorLine, Pager, Time } from "../ui.tsx";
import { ItemRow, type Item } from "./items.tsx";

export function NotificationsView() {
  const { query } = useLocation();
  const app = query.get("app") ?? "";
  const q = query.get("q") ?? "";
  const page = Number(query.get("page") ?? 1) || 1;
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const apps = useLoad((a) => a.get("/api/notifications/apps"), []);
  const list = useLoad<any>((a) => q.trim()
    ? a.get("/api/search", { q, type: "notification", app, page, pageSize: 50 })
    : a.get("/api/notifications", { app, page, pageSize: 50 }), [app, q, page]);
  const go = (patch: Record<string, string | number | undefined>) => navigate(href("/notifications", { app, q, ...patch }));
  const submit = (e: FormEvent) => { e.preventDefault(); go({ q: text || undefined, page: undefined }); };
  const appList = (apps.data?.apps ?? []) as Array<{ app: string; source: string; count: number; latest: string }>;
  const d = list.data;
  return (
    <div className="search-cols">
      <aside className="rail" aria-label="Apps">
        <button className={!app ? "active" : ""} onClick={() => go({ app: undefined, page: undefined })}>All apps</button>
        {appList.map((a) => (
          <button key={`${a.app}:${a.source}`} className={app === a.app ? "active" : ""} onClick={() => go({ app: a.app, page: undefined })}>
            {a.app} <span className="muted">({a.count}, {a.source})</span><br /><span className="small muted">latest <Time at={a.latest} /></span>
          </button>
        ))}
      </aside>
      <section className="results">
        <form onSubmit={submit} className="searchbar" role="search">
          <input aria-label="Search notifications" placeholder="word, sender, phrase" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit">Search</button>
        </form>
        <p className="warn small">Notifications are previews as the device showed them: partial records, not conversations. Text may be truncated or redacted by the app.</p>
        <ErrorLine error={list.error} />
        {d && d.total === 0 && <Empty>{appList.length === 0 ? "No notifications captured yet. They come from the Windows notification collector and the Android listener." : "No notifications match."}</Empty>}
        {((d?.items ?? []) as Item[]).map((it) => <ItemRow key={it.id} it={it} />)}
        {d && d.pages > 1 && <Pager page={d.page} pages={d.pages} total={d.total} onPage={(p) => go({ page: p })} />}
      </section>
    </div>
  );
}
