import { useEffect, useState, type FormEvent } from "react";
import { errText } from "../api.ts";
import { useApi, useEvents, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { Chip, DeviceChip, Empty, ErrorLine, Mono, Pager, Time, bytes } from "../ui.tsx";
import { AVAILABILITY, type Item } from "./items.tsx";
import { applyEvent, describe, fromCommand, type CommandView, type RequestState } from "../request.ts";

export function FilesView() {
  const api = useApi();
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const page = Number(query.get("page") ?? 1) || 1;
  const focus = query.get("focus") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const list = useLoad<any>((a) => q.trim() ? a.get("/api/search", { q, type: "file", page, pageSize: 50 }) : a.get("/api/files", { page, pageSize: 50 }), [q, page]);
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
  const go = (patch: Record<string, string | number | undefined>) => navigate(href("/files", { q, page, ...patch }));
  const submit = (e: FormEvent) => { e.preventDefault(); go({ q: text || undefined, page: undefined }); };

  return (
    <div>
      <form onSubmit={submit} className="searchbar" role="search">
        <input aria-label="Search files" placeholder="file name or path" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Search</button>
      </form>
      <ErrorLine error={list.error} />
      {list.data && items.length === 0 && <Empty>{q ? "No files match." : "No files indexed yet. The Windows and Android file collectors send the index; originals stay on the device until requested."}</Empty>}
      {items.length > 0 && (
        <table className="files">
          <thead><tr><th>Name</th><th>Device / path</th><th>Size</th><th>Modified</th><th>Copy</th><th>Original</th></tr></thead>
          <tbody>
            {items.map((it) => {
              const d = it.detail ?? {};
              const s = req[it.id];
              const local = d.availability === "local" || s?.phase === "done";
              return (
                <tr key={it.id} className={it.id === focus ? "hit" : ""} data-testid={`file-${it.id}`}>
                  <td>{d.name ?? it.title}{d.sourceStatus === "deleted_at_source" && <> <Chip kind="warn">deleted at source</Chip></>}</td>
                  <td><DeviceChip id={it.deviceId} devices={devs.data?.devices} /> <Mono>{d.path ?? it.body}</Mono></td>
                  <td>{bytes(d.size)}</td>
                  <td><Time at={d.mtime ?? it.eventTime} field={it.timeField} captured={it.capturedAt} /></td>
                  <td><Chip kind={d.availability === "local" ? "ok" : "ref"}>{AVAILABILITY[d.availability] ?? d.availability}</Chip></td>
                  <td>
                    {d.contentUrl && d.availability === "local" ? <a href={d.contentUrl} target="_blank" rel="noreferrer">Open local copy</a> : null}
                    {!local && (!s || s.phase === "failed") && <button onClick={() => void request(it)}>Request original</button>}
                    {s && <div className={`req req-${s.phase}`} role="status" data-testid="request-status">{describe(s)}
                      {s.phase === "in_progress" && s.total ? <progress max={s.total} value={s.bytes ?? 0} /> : null}</div>}
                    {s?.phase === "done" && !d.contentUrl && <div className="small muted">refresh to open</div>}
                    {err[it.id] && <div className="error">{err[it.id]}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {pages > 1 && <Pager page={page} pages={pages} total={list.data?.total} onPage={(p) => go({ page: p })} />}
    </div>
  );
}
