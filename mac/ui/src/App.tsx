import { useCallback, useEffect, useState } from "react";
import { ApiError, errText } from "./api.ts";
import { useApi, useEvents, useLoad } from "./ctx.tsx";
import { SCOPE_PARAM, navigate, useLocation } from "./router.ts";
import { Sidebar, LastSync } from "./components/Sidebar.tsx";
import { Icon } from "./components/Icon.tsx";
import { Empty } from "./components/Feedback.tsx";
import { CreatedPanel, LockScreen, TokenScreen, type Created, type KeystoreStatus } from "./views/Lock.tsx";
import { SearchView } from "./views/Search.tsx";
import { TimelineView } from "./views/Timeline.tsx";
import { ConversationsView } from "./views/Conversations.tsx";
import { NotificationsView } from "./views/Notifications.tsx";
import { MediaView } from "./views/Media.tsx";
import { FilesView } from "./views/Files.tsx";
import { CoverageView } from "./views/Coverage.tsx";
import { DevicesView } from "./views/Devices.tsx";
import { DeviceView } from "./views/Device.tsx";
import { SettingsView } from "./views/Settings.tsx";
import { BinView } from "./views/Bin.tsx";
import { ActivityPanel, useActivity } from "./views/Activity.tsx";
import { AiView } from "./views/Ai.tsx";
import { DevicesContext } from "./views/records.tsx";
import { ScopeBar } from "./scope.tsx";

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

  if (boot.kind === "checking") return <div className="center"><p className="muted">Connecting to the IVY service…</p></div>;
  if (boot.kind === "error") {
    return (
      <div className="center">
        <div className="auth-card">
          <h1>Cannot reach IVY</h1>
          <p className="error" role="alert">Cannot reach the IVY service: {boot.error}</p>
          <button className="btn btn-primary btn-lg" onClick={() => void refresh()}>Retry</button>
        </div>
      </div>
    );
  }
  if (boot.kind === "token") return <TokenScreen onDone={refresh} />;
  if (created) return <CreatedPanel c={created} onContinue={() => { setCreated(null); void refresh(); }} />;
  if (boot.status.state !== "unlocked") return <LockScreen status={boot.status} onUnlocked={refresh} onCreated={setCreated} />;
  return <Shell onLocked={refresh} />;
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/(search)?$/, "Search"], [/^\/timeline/, "Timeline"], [/^\/ai/, "Ask AI"], [/^\/media/, "Media"], [/^\/files/, "Files"],
  [/^\/notifications/, "Notifications"], [/^\/conversations/, "Conversations"], [/^\/device\/windows/, "Windows"], [/^\/device\/android/, "Android"],
  [/^\/coverage/, "Coverage"], [/^\/devices/, "Devices"], [/^\/settings/, "Settings"], [/^\/bin/, "Recovery bin"],
];

function Router() {
  const { path } = useLocation();
  const p = path;
  // the window title names the view (predictable history entries, screen-reader context on route change)
  useEffect(() => { const t = TITLES.find(([re]) => re.test(p))?.[1]; document.title = t ? `${t} · IVY` : "IVY"; }, [p]);
  if (p === "/" || p === "/search") return <SearchView />;
  if (p.startsWith("/timeline")) return <TimelineView />;
  if (p.startsWith("/conversations")) return <ConversationsView />;
  if (p.startsWith("/notifications")) return <NotificationsView />;
  if (p.startsWith("/media")) return <MediaView />;
  if (p.startsWith("/files")) return <FilesView />;
  if (p.startsWith("/coverage")) return <CoverageView />;
  if (p.startsWith("/devices")) return <DevicesView />;
  if (p.startsWith("/device/")) return <DeviceView />;
  if (p.startsWith("/settings")) return <SettingsView />;
  if (p.startsWith("/bin")) return <BinView />;
  if (p.startsWith("/ai")) return <AiView />;
  return (
    <div className="page">
      <Empty icon="search" title="Page not found" action={<button className="btn" onClick={() => navigate("/")}>Go to Search</button>}>
        Nothing lives at <span className="path">{p}</span>.
      </Empty>
    </div>
  );
}

function Shell({ onLocked }: { onLocked: () => void }) {
  const api = useApi();
  const [lockOpen, setLockOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const events = useActivity();
  const { query } = useLocation();
  const scope = query.get(SCOPE_PARAM) || undefined;
  const stats = useLoad<any>((a) => a.get("/api/stats", { device: scope }), [scope]);
  const devs = useLoad<any>((a) => a.get("/api/devices"), []);
  useEvents((ev) => {
    devs.reload();
    // a forgotten device no longer exists: a scope that pointed at it returns to every device
    if (ev.type === "device.forgotten" && ev.data.deviceId && new URLSearchParams(location.search).get(SCOPE_PARAM) === ev.data.deviceId) {
      const q = new URLSearchParams(location.search); q.delete(SCOPE_PARAM);
      navigate(`${location.pathname}${q.toString() ? `?${q}` : ""}`, true, false);
    }
  }, ["pairing.completed", "device.revoked", "device.forgotten", "device.renamed"]);
  useEvents(() => stats.reload(), ["ingest.poll"]);
  const lastOk = ((stats.data?.lastSync ?? []) as Array<{ lastOkAt?: string | null }>).map((b) => b.lastOkAt).filter(Boolean).sort().at(-1) ?? null;

  const lock = async (full: boolean) => {
    setLockOpen(false);
    try { await api.post("/api/keystore/lock", { full }); } finally { onLocked(); }
  };
  const sync = async () => {
    setSyncing(true); setSyncMsg("syncing…");
    try {
      const r = await api.post<any>("/api/ingest/poll", {});
      const committed = Array.isArray(r?.buckets) ? r.buckets.reduce((n: number, b: any) => n + (b.committed ?? 0), 0) : null;
      setSyncMsg(r?.skipped ? `sync skipped: ${r.skipped}` : committed !== null ? `sync done: ${committed} committed` : "sync done");
      stats.reload();
    } catch (e) { setSyncMsg(`sync failed: ${errText(e)}`); }
    finally { setSyncing(false); }
  };
  useEffect(() => {
    if (!lockOpen) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setLockOpen(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [lockOpen]);

  const footer = (
    <>
      <div className="foot-row">
        <button className="btn" onClick={() => void sync()} disabled={syncing}><Icon name="sync" size={14} />Sync now</button>
        <button className="btn" onClick={() => setFeedOpen(true)} aria-expanded={feedOpen} aria-label="Activity"><Icon name="activity" size={14} />Activity</button>
      </div>
      <div className="foot-row menu-wrap">
        <button className="btn" onClick={() => setLockOpen((v) => !v)} aria-expanded={lockOpen} aria-haspopup="menu" aria-label="Lock"><Icon name="lock" size={14} />Lock</button>
        {lockOpen && (
          <div className="menu up" role="menu" aria-label="Lock">
            <button role="menuitem" onClick={() => void lock(false)} autoFocus>Lock screen only<span className="menu-sub">The key stays in memory; ingest keeps running.</span></button>
            <button role="menuitem" onClick={() => void lock(true)}>Lock fully<span className="menu-sub">Drop the key; ingest stops until unlock.</span></button>
          </div>
        )}
      </div>
      <div className="sync-line">{syncMsg ? <span role="status">{syncMsg}</span> : <LastSync at={lastOk} />}</div>
    </>
  );

  return (
    <DevicesContext.Provider value={devs.data?.devices}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <div className="shell">
        <Sidebar footer={footer} />
        <main className="main" id="main" tabIndex={-1}><ScopeBar /><div className="main-body"><Router /></div></main>
        {feedOpen && <ActivityPanel events={events} onClose={() => setFeedOpen(false)} />}
      </div>
    </DevicesContext.Provider>
  );
}
