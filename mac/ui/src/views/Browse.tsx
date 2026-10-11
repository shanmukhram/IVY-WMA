/**
 * Browse PC: the whole Windows drive as a file tree, read from the device file catalogue
 * (metadata only). Folders load lazily per directory; any file or folder can be fetched on
 * demand at full quality through the same request-original path the Files view uses. Nothing
 * is fetched automatically.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { errText } from "../api.ts";
import { useApi, useEvents, useLoad } from "../ctx.tsx";
import type { Role } from "../nav.ts";
import { bytes } from "../format.ts";
import { deviceName } from "./records.tsx";
import { Icon } from "../components/Icon.tsx";
import { SearchField, Segmented } from "../components/Controls.tsx";
import { Sheet } from "../components/Overlay.tsx";
import { Badge, Empty, ErrorLine, Progress, Time } from "../components/Feedback.tsx";
import { applyEvent, describe, fromCommand, type CommandView, type RequestState } from "../request.ts";

export interface BrowseFolder { name: string; path: string; fileCount: number; totalBytes: number }
export interface BrowseFile { id: string; name: string; path: string; ext: string; size: number; mtime: string | null; cached: boolean; inR2: boolean }
export interface BrowseResult { folders: BrowseFolder[]; files: BrowseFile[] }

/** A folder with many files is a large fetch; ask twice above this. */
export const BIG_FOLDER = 200;

/** Split a path on either separator, remembering which one it used so breadcrumbs rebuild the real path. */
export function splitPath(path: string): { sep: string; parts: string[] } {
  const sep = path.includes("\\") ? "\\" : "/";
  return { sep, parts: path.split(/[\\/]+/).filter(Boolean) };
}

/** Ancestor crumbs for a directory path, each with the exact path the catalogue uses. */
export function crumbs(path: string): Array<{ name: string; path: string }> {
  const { sep, parts } = splitPath(path);
  return parts.map((name, i) => ({
    name,
    path: sep === "\\" ? (i === 0 ? parts[0] + "\\" : parts.slice(0, i + 1).join("\\")) : "/" + parts.slice(0, i + 1).join("/"),
  }));
}

export function fileStatus(f: BrowseFile, cached: boolean): { label: string; tone?: "green" | "blue" } {
  if (cached) return { label: "Cached", tone: "green" };
  if (f.inR2) return { label: "In R2", tone: "blue" };
  return { label: "Not fetched" };
}

export function BrowseView({ role = "windows", deviceId: fixedDevice }: { role?: Role; deviceId?: string }) {
  const devs = useLoad<any>((a) => (fixedDevice ? Promise.resolve(null) : a.get("/api/devices")), [fixedDevice]);
  const candidates = ((devs.data?.devices ?? []) as Array<{ id: string; role: string }>).filter((d) => d.role === role);
  const [picked, setPicked] = useState<string | null>(null);
  const deviceId = fixedDevice ?? picked ?? candidates[0]?.id ?? null;

  if (!fixedDevice && devs.data && candidates.length === 0) {
    return <Empty icon={role === "windows" ? "laptop" : "phone"} title="No device to browse">Pair the device under Devices; its drive appears here once it reports its file catalogue.</Empty>;
  }
  if (!deviceId) return <p className="muted" style={{ padding: 16 }}>Loading the device…</p>;

  return (
    <div className="stack" style={{ gap: 12 }}>
      {!fixedDevice && candidates.length > 1 && (
        <Segmented label="Device" value={deviceId} onChange={setPicked}
          options={candidates.map((d) => [d.id, deviceName(d.id, candidates)] as [string, string])} />
      )}
      <Browser key={deviceId} deviceId={deviceId} devices={candidates} />
    </div>
  );
}

function Browser({ deviceId, devices }: { deviceId: string; devices: Array<{ id: string; role: string }> }) {
  const api = useApi();
  const [cache, setCache] = useState<Record<string, BrowseResult>>({});
  const [status, setStatus] = useState<Record<string, { loading: boolean; error?: string }>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("");
  const [req, setReq] = useState<Record<string, RequestState>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  const [fetched, setFetched] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<BrowseFolder | null>(null);
  const [folderMsg, setFolderMsg] = useState("");

  // search mode: a filename query across the device, shown flat in the right pane
  const [text, setText] = useState("");
  const [search, setSearch] = useState<{ q: string; loading: boolean; error?: string; result?: BrowseResult } | null>(null);

  const inflight = useRef<Set<string>>(new Set());
  const markFetched = (id: string) => setFetched((s) => (s.has(id) ? s : new Set(s).add(id)));

  const load = useCallback(async (path: string): Promise<BrowseResult> => {
    const key = path;
    if (inflight.current.has(key)) return cache[key] ?? { folders: [], files: [] };
    inflight.current.add(key);
    setStatus((s) => ({ ...s, [key]: { loading: true } }));
    try {
      const res = await api.get<BrowseResult>(`/api/devices/${deviceId}/browse`, { path: path || undefined });
      setCache((c) => ({ ...c, [key]: res }));
      setStatus((s) => ({ ...s, [key]: { loading: false } }));
      return res;
    } catch (e) {
      setStatus((s) => ({ ...s, [key]: { loading: false, error: errText(e) } }));
      throw e;
    } finally {
      inflight.current.delete(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, deviceId]);

  // load the roots (drives) once per device
  useEffect(() => { void load(""); }, [load]);

  useEvents((ev) => {
    setReq((s) => {
      let changed = false;
      const next: Record<string, RequestState> = {};
      for (const [k, v] of Object.entries(s)) { const n = applyEvent(v, ev); if (n !== v) changed = true; next[k] = n; }
      return changed ? next : s;
    });
    if (ev.type === "command.status") {
      const fileId = Object.entries(req).find(([, v]) => v.commandId === ev.data.commandId)?.[0];
      if (fileId) api.get<CommandView>(`/api/commands/${ev.data.commandId}`).then((c) => setReq((s) => {
        const cur = s[fileId]; if (!cur) return s;
        const f = fromCommand(c);
        return { ...s, [fileId]: cur.phase === "done" ? cur : { ...f, bytes: f.bytes ?? cur.bytes, total: f.total ?? cur.total } };
      }), () => undefined);
    }
    if (ev.type === "file.cached" && typeof ev.data.fileId === "string") markFetched(ev.data.fileId);
  }, ["command.", "blob.", "file.cached"]);

  const open = (path: string) => { setSelected(path); setExpanded((s) => new Set(s).add(path)); void load(path); };
  const toggle = (path: string) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(path)) next.delete(path); else { next.add(path); void load(path); }
    return next;
  });

  const request = async (f: BrowseFile) => {
    setErr((e) => ({ ...e, [f.id]: "" }));
    try {
      const r = await api.post<{ command: CommandView | null; alreadyCached?: boolean }>(`/api/files/${f.id}/request`, {});
      if (r.command) setReq((s) => ({ ...s, [f.id]: fromCommand(r.command!) }));
      else if (r.alreadyCached) markFetched(f.id);
    } catch (e) { setErr((x) => ({ ...x, [f.id]: errText(e) })); }
  };

  const fetchFolder = async (f: BrowseFolder) => {
    setConfirm(null);
    setFolderMsg(`Fetching ${f.name}…`);
    try {
      const res = await load(f.path);
      const pending = res.files.filter((x) => !(x.cached || fetched.has(x.id)));
      for (const file of pending) await request(file);
      setFolderMsg(pending.length ? `Requested ${pending.length} file(s) in ${f.name}.` : `Everything in ${f.name} is already here.`);
    } catch (e) { setFolderMsg(`Could not fetch ${f.name}: ${errText(e)}`); }
  };

  const runSearch = async (q: string) => {
    if (!q.trim()) { setSearch(null); return; }
    setSearch({ q, loading: true });
    try {
      const result = await api.get<BrowseResult>(`/api/devices/${deviceId}/browse/search`, { q });
      setSearch({ q, loading: false, result });
    } catch (e) { setSearch({ q, loading: false, error: errText(e) }); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void runSearch(text); };
  const clearSearch = () => { setText(""); setSearch(null); };

  const rootStatus = status[""];
  const roots = cache[""]?.folders ?? [];
  const current = cache[selected];
  const files = search ? search.result?.files ?? [] : current?.files ?? [];

  const row = (f: BrowseFile) => {
    const s = req[f.id];
    const isCached = f.cached || fetched.has(f.id) || s?.phase === "done";
    const chip = fileStatus(f, isCached);
    return (
      <div key={f.id} role="listitem" className="file-row" data-testid={`browse-file-${f.id}`}>
        <span className="fi" aria-hidden="true">{(f.ext || f.name.split(".").pop() || "").slice(0, 4)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="fname ellipsis">{f.name}</div>
          <div className="fpath ellipsis path" title={f.path}>{f.path}</div>
        </div>
        <span className="fsize">{bytes(f.size)}</span>
        <span className="fdate"><Time at={f.mtime} field="mtime" withDate /></span>
        <div className="fact">
          <Badge tone={chip.tone} title={chip.label}>{chip.label}</Badge>
          {isCached && <a href={`/api/files/${f.id}/content`} target="_blank" rel="noreferrer">Open</a>}
          {!isCached && (!s || s.phase === "failed") && <button className="btn btn-sm" onClick={() => void request(f)}>Fetch</button>}
          {s && s.phase !== "done" && (
            <div className={`req req-${s.phase}`} role="status" data-testid={`browse-status-${f.id}`}>
              {describe(s)}
              {s.phase === "in_progress" && s.total ? <Progress value={s.bytes ?? 0} max={s.total} label="Transfer progress" /> : null}
            </div>
          )}
          {err[f.id] && <span className="small error">{err[f.id]}</span>}
        </div>
      </div>
    );
  };

  const tree = (path: string, depth: number) => {
    const st = status[path];
    const folders = cache[path]?.folders ?? [];
    if (st?.loading && !cache[path]) return <p className="browse-hint small faint" style={{ paddingLeft: depth * 16 + 28 }}>Loading…</p>;
    if (st?.error) return <p className="browse-hint small error" style={{ paddingLeft: depth * 16 + 28 }}>{st.error}</p>;
    if (cache[path] && folders.length === 0) return depth === 0 ? <p className="browse-hint small faint">No drives reported.</p> : null;
    return folders.map((f) => {
      const isOpen = expanded.has(f.path);
      return (
        <div key={f.path} role="treeitem" aria-expanded={isOpen} aria-label={f.name}>
          <div className={`browse-node${selected === f.path ? " sel" : ""}`} style={{ paddingLeft: depth * 16 + 4 }}>
            <button className="browse-twist" aria-label={isOpen ? `Collapse ${f.name}` : `Expand ${f.name}`} onClick={() => toggle(f.path)}>
              <Icon name="chevronRight" size={12} className={isOpen ? "twist-open" : undefined} />
            </button>
            <button className="browse-folder ellipsis" onClick={() => open(f.path)} title={f.path}>
              <Icon name="folder" size={16} /><span className="ellipsis">{f.name}</span>
            </button>
            <span className="small faint tnum browse-count">{f.fileCount}</span>
            <button className="btn btn-sm" onClick={() => setConfirm(f)}>Fetch folder</button>
          </div>
          {isOpen && <div role="group">{tree(f.path, depth + 1)}</div>}
        </div>
      );
    });
  };

  return (
    <div className="panes browse" style={{ height: 620, border: "1px solid var(--separator)", borderRadius: 12, overflow: "hidden" }}>
      <section className="pane pane-list" aria-label="Folders">
        <div className="pane-head"><Icon name="laptop" size={16} /><h2 className="ellipsis">{deviceName(deviceId, devices)}</h2></div>
        <div className="pane-scroll" style={{ padding: 6 }} role="tree" aria-label="Folder tree">
          <button className={`browse-node browse-root${selected === "" ? " sel" : ""}`} onClick={() => setSelected("")}>
            <Icon name="laptop" size={14} /><span>This PC</span>
          </button>
          {rootStatus?.error ? <ErrorLine error={rootStatus.error} /> : tree("", 0)}
        </div>
      </section>

      <section className="pane pane-main" aria-label="Files">
        <div className="pane-head" style={{ gap: 12 }}>
          <form onSubmit={submit} role="search" className="row spacer" style={{ gap: 8 }}>
            <SearchField aria-label="Search file names" placeholder="Search file names on this device" value={text} onChange={(e) => setText(e.target.value)} className="spacer" />
            {search ? <button type="button" className="btn btn-sm" onClick={clearSearch}>Clear</button> : <button type="submit" className="btn btn-sm">Search</button>}
          </form>
        </div>

        {!search && (
          <nav className="browse-crumbs" aria-label="Current folder">
            <button className="crumb" onClick={() => setSelected("")}>This PC</button>
            {crumbs(selected).map((c) => (
              <span key={c.path}><span className="crumb-sep" aria-hidden="true">›</span><button className="crumb" onClick={() => open(c.path)}>{c.name}</button></span>
            ))}
          </nav>
        )}
        {folderMsg && <p className="small faint browse-folder-msg" role="status">{folderMsg}</p>}

        <div className="pane-scroll">
          {search ? (
            <>
              {search.loading && <p className="muted" style={{ padding: 16 }}>Searching…</p>}
              {search.error && <ErrorLine error={search.error} />}
              {!search.loading && !search.error && files.length === 0 && <Empty icon="folder" title="No files match">Nothing on this device matches “{search.q}”.</Empty>}
            </>
          ) : selected === "" ? (
            <Empty icon="folder" title="Pick a folder">Open a drive on the left to see its files. Originals stay on the device until you fetch them.</Empty>
          ) : status[selected]?.loading && !current ? (
            <p className="muted" style={{ padding: 16 }}>Loading…</p>
          ) : status[selected]?.error ? (
            <ErrorLine error={status[selected]!.error} />
          ) : current && files.length === 0 ? (
            <Empty icon="folder" title="No files here">This folder holds no files of its own.</Empty>
          ) : null}
          {files.length > 0 && <div className="group" role="list" aria-label={search ? "Search results" : "Files"}>{files.map(row)}</div>}
        </div>
      </section>

      {confirm && (
        <Sheet title="Fetch folder" label="Confirm fetch folder" onClose={() => setConfirm(null)}
          footer={<>
            <button className="btn" data-close onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void fetchFolder(confirm)}>Fetch {confirm.fileCount} file(s)</button>
          </>}>
          <p>Fetch every file in <b className="path">{confirm.name}</b>?</p>
          <p className="small faint">{confirm.fileCount} file(s), {bytes(confirm.totalBytes)} in total. Each original is pulled from the device at full quality; this can take a while and use disk space.</p>
          {confirm.fileCount > BIG_FOLDER && <p className="small error">This is a large folder ({confirm.fileCount} files). Fetch only if you mean to.</p>}
          <p className="small faint">Subfolders are not included; fetch them separately.</p>
        </Sheet>
      )}
    </div>
  );
}
