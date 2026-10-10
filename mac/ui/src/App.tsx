import { useCallback, useEffect, useState } from "react";
import { ApiError, errText } from "./api.ts";
import { useApi, useEvents } from "./ctx.tsx";
import { useLocation, navigate } from "./router.ts";
import { Link, Time } from "./ui.tsx";
import { CreatedPanel, LockScreen, TokenScreen, type Created, type KeystoreStatus } from "./views/Lock.tsx";
import { SearchView } from "./views/Search.tsx";
import { TimelineView } from "./views/Timeline.tsx";
import { ConversationsView } from "./views/Conversations.tsx";
import { NotificationsView } from "./views/Notifications.tsx";
import { MediaView } from "./views/Media.tsx";
import { FilesView } from "./views/Files.tsx";
import { CoverageView } from "./views/Coverage.tsx";
import { DevicesView } from "./views/Devices.tsx";
import { SettingsView } from "./views/Settings.tsx";
import { BinView } from "./views/Bin.tsx";
import { ActivityFeed } from "./views/Activity.tsx";
import { AiView } from "./views/Ai.tsx";

const NAV: Array<[string, string]> = [
  ["/", "Search"], ["/timeline", "Timeline"], ["/conversations", "Conversations"], ["/notifications", "Notifications"],
  ["/media", "Media"], ["/files", "Files"], ["/coverage", "Coverage"], ["/devices", "Devices"], ["/ai", "Ask AI"], ["/settings", "Settings"], ["/bin", "Recovery bin"],
];

type Boot = { kind: "checking" } | { kind: "token"; error?: string } | { kind: "error"; error: string } | { kind: "keystore"; status: KeystoreStatus };

export function App() {
  const api = useApi();
  const [boot, setBoot] = useState<Boot>({ kind: "checking" });
  const [created, setCreated] = useState<Created | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await api.get<KeystoreStatus>("/api/keystore");
      setBoot({ kind: "keystore", status });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setBoot({ kind: "token" });
      else setBoot({ kind: "error", error: errText(e) });
    }
  }, [api]);

  useEffect(() => {
    (async () => {
      // a token handed over in the URL fragment (#token=...) is exchanged for the session cookie, then removed
      const m = /(?:^#|&)token=([0-9a-f]{64})/.exec(location.hash);
      if (m) {
        history.replaceState(null, "", location.pathname + location.search);
        try { await api.post("/api/session", { token: m[1] }); } catch { /* falls through to the token screen */ }
      }
      await refresh();
    })();
  }, [api, refresh]);

  useEvents((ev) => { if (ev.type.startsWith("keystore.") || ev.type === "hello") void refresh(); }, ["keystore.", "hello"]);
  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener("ivy:locked", on);
    return () => window.removeEventListener("ivy:locked", on);
  }, [refresh]);

  if (boot.kind === "checking") return <div className="center"><p>Connecting to the IVY service…</p></div>;
  if (boot.kind === "error") return <div className="center"><p className="error" role="alert">Cannot reach the IVY service: {boot.error}</p><button onClick={() => void refresh()}>Retry</button></div>;
  if (boot.kind === "token") return <TokenScreen onDone={refresh} />;
  if (created) return <CreatedPanel c={created} onContinue={() => { setCreated(null); void refresh(); }} />;
  if (boot.status.state !== "unlocked") return <LockScreen status={boot.status} onUnlocked={refresh} onCreated={setCreated} />;
  return <Shell status={boot.status} onLocked={refresh} />;
}

function Shell({ status, onLocked }: { status: KeystoreStatus; onLocked: () => void }) {
  const api = useApi();
  const loc = useLocation();
  const [lockOpen, setLockOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(() => { try { return localStorage.getItem("ivy.feed") !== "0"; } catch { return true; } });
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const lock = async (full: boolean) => {
    setLockOpen(false);
    try { await api.post("/api/keystore/lock", { full }); } finally { onLocked(); }
  };
  const sync = async () => {
    setSyncMsg("syncing…");
    try {
      const r = await api.post<any>("/api/ingest/poll", {});
      const committed = Array.isArray(r?.buckets) ? r.buckets.reduce((n: number, b: any) => n + (b.committed ?? 0), 0) : null;
      setSyncMsg(r?.skipped ? `sync skipped: ${r.skipped}` : committed !== null ? `sync done: ${committed} committed` : "sync done");
    } catch (e) { setSyncMsg(`sync failed: ${errText(e)}`); }
  };
  const toggleFeed = () => setFeedOpen((v) => { try { localStorage.setItem("ivy.feed", v ? "0" : "1"); } catch { /* per-viewer only */ } return !v; });

  const p = loc.path;
  const active = (to: string) => (to === "/" ? p === "/" : p === to || p.startsWith(to + "/"));
  let view;
  if (p === "/" || p === "/search") view = <SearchView />;
  else if (p.startsWith("/timeline")) view = <TimelineView />;
  else if (p.startsWith("/conversations")) view = <ConversationsView />;
  else if (p.startsWith("/notifications")) view = <NotificationsView />;
  else if (p.startsWith("/media")) view = <MediaView />;
  else if (p.startsWith("/files")) view = <FilesView />;
  else if (p.startsWith("/coverage")) view = <CoverageView />;
  else if (p.startsWith("/devices")) view = <DevicesView />;
  else if (p.startsWith("/settings")) view = <SettingsView />;
  else if (p.startsWith("/bin")) view = <BinView />;
  else if (p.startsWith("/ai")) view = <AiView />;
  else view = <div><p>Not found: <span className="mono">{p}</span></p><button onClick={() => navigate("/")}>Search</button></div>;

  return (
    <div className={`shell${feedOpen ? " with-feed" : ""}`}>
      <header className="top">
        <strong className="brand">IVY</strong>
        <nav>{NAV.map(([to, label]) => <Link key={to} to={to} className={active(to) ? "active" : ""}>{label}</Link>)}</nav>
        <span className="spacer" />
        {syncMsg && <span className="muted small" role="status">{syncMsg}</span>}
        <button onClick={() => void sync()}>Sync now</button>
        <button onClick={toggleFeed} aria-expanded={feedOpen}>Activity</button>
        <span className="lock-wrap">
          <button onClick={() => setLockOpen((v) => !v)} aria-expanded={lockOpen}>Lock</button>
          {lockOpen && (
            <div className="lock-menu" role="menu">
              <button role="menuitem" onClick={() => void lock(false)}>Lock screen only (key stays in memory; ingest keeps running)</button>
              <button role="menuitem" onClick={() => void lock(true)}>Lock fully (drop the key; ingest stops until unlock)</button>
            </div>
          )}
        </span>
      </header>
      <main className="main">{view}</main>
      {feedOpen && <ActivityFeed />}
      <Footer autoLock={status.autoLockMinutes} />
    </div>
  );
}

function Footer({ autoLock }: { autoLock?: number }) {
  const api = useApi();
  const [stats, setStats] = useState<any>(null);
  const load = useCallback(() => { api.get("/api/stats").then(setStats, () => undefined); }, [api]);
  useEffect(() => { load(); }, [load]);
  useEvents(() => load(), ["ingest.poll", "bin."]);
  const c = stats?.counts ?? {};
  const last = (stats?.lastSync ?? []) as Array<{ bucket: string; at?: string; lastOkAt?: string | null; ok?: boolean }>;
  return (
    <footer className="foot small">
      <span>Index: {c.messages ?? 0} messages · {c.notifications ?? 0} notifications · {c.media ?? 0} media · {c.files ?? 0} files · {c.usage ?? 0} usage · {c.calls ?? 0} calls</span>
      <span>Last sync: {last.length ? last.map((b) => <span key={b.bucket}> {b.bucket} <Time at={b.lastOkAt ?? null} /> {b.ok === false ? "(last poll failed)" : ""}</span>) : "never"}</span>
      {autoLock !== undefined && <span>Auto-lock: {autoLock ? `${autoLock} min` : "off"}</span>}
    </footer>
  );
}
