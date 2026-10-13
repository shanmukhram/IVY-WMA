/** Files (F1-F4): list with reference / preview / local copy, request original with progress, open local copy, search. */
import { useEffect, useState, type FormEvent } from "react";
import { errText } from "../api.ts";
import { useApi, useEvents, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { useScope } from "../scope.tsx";
import { bytes } from "../format.ts";
import { SearchField } from "../components/Controls.tsx";
import { Badge, Empty, ErrorLine, Pager, Progress, Time } from "../components/Feedback.tsx";
import { AVAILABILITY, AVAILABILITY_SHORT, deviceName, type Item } from "./records.tsx";
import { applyEvent, describe, fromCommand, type CommandView, type RequestState } from "../request.ts";

export function FilesView({ device: fixed, embedded }: { device?: string; embedded?: boolean } = {}) {
  const api = useApi();
  // the device comes from the page that embeds this view, or else from the app's device scope
  const { scope } = useScope();
  const device = fixed ?? scope ?? undefined;
  const loc = useLocation();
  const [local, setLocal] = useState({ q: "", page: 1 });
  const q = embedded ? local.q : loc.query.get("q") ?? "";
  const page = embedded ? local.page : Number(loc.query.get("page") ?? 1) || 1;
  const focus = embedded ? "" : loc.query.get("focus") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const list = useLoad<any>((a) => q.trim()
    ? a.get("/api/search", { q, type: "file", device, page, pageSize: 50 })
    : device ? a.get("/api/views/records", { type: "file", device, page, pageSize: 50 }) : a.get("/api/files", { page, pageSize: 50 }), [q, page, device]);
  const devs = useLoad<any>((a) => a.get("/api/devices"), []);
  const [req, setReq] = useState<Record<string, RequestState>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  const items = (list.data?.items ?? []) as Item[];
  const pages = list.data?.pages ?? Math.max(1, Math.ceil((list.data?.total ?? 0) / 50));

  // pick up requests that are already outstanding for the listed files
  useEffect(() => {
    for (const it of items) {
      const lr = it.detail?.lastRequest;
      if (lr && !req[it.id]) api.get<CommandView>(`/api/commands/${lr.commandId}`).then((c) => setReq((s) => (s[it.id] ? s : { ...s, [it.id]: fromCommand(c) })), () => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

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
    if (ev.type === "file.cached") list.reload();
  }, ["command.", "blob.", "file.cached"]);

  const request = async (it: Item) => {
    setErr((e) => ({ ...e, [it.id]: "" }));
    try {
      const r = await api.post<{ command: CommandView | null; alreadyCached?: boolean }>(`/api/files/${it.id}/request`, {});
      if (r.command) setReq((s) => ({ ...s, [it.id]: fromCommand(r.command!) }));
      else if (r.alreadyCached) list.reload();
    } catch (e) { setErr((x) => ({ ...x, [it.id]: errText(e) })); }
  };
  const go = (patch: { q?: string; page?: number }) => {
    if (embedded) { setLocal((s) => ({ ...s, page: 1, ...patch })); return; }
    navigate(href("/files", { q, page, ...patch }));
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go({ q: text || "", page: 1 }); };

  return (
    <div className={embedded ? "" : "page"}>
      {!embedded && (
        <div className="page-head">
          <div><h1>Files</h1><p className="page-sub">The index of every file on the devices. Originals stay on the device until you request them.</p></div>
        </div>
      )}
      <form onSubmit={submit} role="search" className="row" style={{ marginBottom: 16 }}>
        <SearchField aria-label="Search files" placeholder="Search file names, paths and document text" value={text} onChange={(e) => setText(e.target.value)} className="spacer" />
        <button type="submit" className="btn">Search</button>
        {q && <button type="button" className="btn btn-plain" onClick={() => { setText(""); go({ q: "", page: 1 }); }}>Clear</button>}
      </form>
      <ErrorLine error={list.error} />
      {list.data && items.length === 0 && (
        <Empty icon="doc" title={q ? "No files match" : "No files indexed yet"}>
          {q ? `Nothing matches “${q}”.` : "The Windows and Android file collectors send the index; originals stay on the device until requested."}
        </Empty>
      )}
      {items.length > 0 && (
        <div className="group" role="list" aria-label="Files">
          {items.map((it) => {
            const d = it.detail ?? {};
            const s = req[it.id];
            const isLocal = d.availability === "local" || s?.phase === "done";
            const ext = String(d.ext ?? d.name ?? it.title ?? "").split(".").pop()?.slice(0, 4) ?? "";
            return (
              <div key={it.id} role="listitem" className={`file-row${it.id === focus ? " hit" : ""}`} data-testid={`file-${it.id}`}>
                <span className="fi" aria-hidden="true">{ext}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="fname ellipsis">{d.name ?? it.title}{d.sourceStatus === "deleted_at_source" && <> <Badge tone="red">deleted at source</Badge></>}</div>
                  <div className="fpath ellipsis" title={d.path ?? it.body ?? ""}>{deviceName(it.deviceId, devs.data?.devices)} · <span className="path">{d.path ?? it.body}</span></div>
                </div>
                <span className="fsize">{bytes(d.size)}</span>
                <span className="fdate" title="modified (original time)"><Time at={d.mtime ?? it.eventTime} field={it.timeField} captured={it.capturedAt} withDate /></span>
                <div className="fact">
                  <Badge tone={d.availability === "local" ? "green" : undefined} title={AVAILABILITY[d.availability] ?? d.availability}>
                    <span className="sr-only">{AVAILABILITY[d.availability] ?? d.availability}</span><span aria-hidden="true">{AVAILABILITY_SHORT[d.availability] ?? d.availability}</span>
                  </Badge>
                  {d.contentUrl && d.availability === "local" ? <a href={d.contentUrl} target="_blank" rel="noreferrer">Open local copy</a> : null}
                  {!isLocal && (!s || s.phase === "failed") && <button className="btn btn-sm" onClick={() => void request(it)}>Request original</button>}
                  {s && (
                    <div className={`req req-${s.phase}`} role="status" data-testid="request-status">
                      {describe(s)}
                      {s.phase === "in_progress" && s.total ? <Progress value={s.bytes ?? 0} max={s.total} label="Transfer progress" /> : null}
                    </div>
                  )}
                  {s?.phase === "done" && !d.contentUrl && <span className="small faint">refresh to open</span>}
                  {err[it.id] && <span className="small error">{err[it.id]}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {pages > 1 && <Pager page={page} pages={pages} total={list.data?.total} onPage={(p) => go({ page: p })} />}
      {list.data && <p className="small faint" style={{ marginTop: 8 }}>{list.data.total ?? items.length} file(s)</p>}
    </div>
  );
}
