/** Recovery bin (B1-B4): restore, or permanently delete after a confirmation naming what is removed. */
import { useState } from "react";
import { errText } from "../api.ts";
import { useApi, useEvents, useLoad } from "../ctx.tsx";
import { TYPE_ICON, Icon } from "../components/Icon.tsx";
import { Link } from "../components/Controls.tsx";
import { Empty, ErrorLine, Notice, Pager, Time } from "../components/Feedback.tsx";
import { Sheet } from "../components/Overlay.tsx";

const REMOVES: Record<string, string> = {
  message: "the message text, its prior edit versions, its search index entries and its attachments' local copies",
  conversation: "the conversation, all its messages, their attachments' local copies and search index entries",
  attachment: "the attachment record and its local copy",
  notification: "the notification text and its search index entries",
  screenshot: "the original image, its thumbnail, the OCR text and its search index entries",
  photo: "the original image, its thumbnail, the OCR text and its search index entries",
  media: "the original image, its thumbnail, the OCR text and its search index entries",
  file: "the file record, any retrieved local copy, its thumbnail and its search index entries",
  usage: "the usage record and its search index entries",
  call: "the call record and its search index entries",
  browsing: "the imported Google activity row and its search index entries (it is not imported again; Activity Vault itself is not changed)",
  ai_conversation: "the AI conversation: questions, answers and the record excerpts its tools retrieved",
};

export function BinView() {
  const api = useApi();
  const [page, setPage] = useState(1);
  const b = useLoad<any>((a) => a.get("/api/bin", { page }), [page]);
  useEvents(() => b.reload(), ["bin."]);
  const [confirm, setConfirm] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); } catch (e) { setMsg(errText(e)); } setConfirm(null); b.reload(); };
  const d = b.data;
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1>Recovery bin</h1>
          <p className="page-sub">Items deleted inside the vault stay here for {d?.retentionDays ?? "…"} days, then are removed permanently. Deletion at the source (on a device) is different: those records stay in the vault, marked “deleted at source”.</p>
        </div>
        <div className="page-actions"><Link to="/settings?section=bin" className="btn btn-sm">Retention…</Link></div>
      </div>
      <div className="stack">
        <ErrorLine error={b.error} />
        {msg && <Notice role="status">{msg}</Notice>}
        {d && d.total === 0 && <div className="group"><Empty icon="trash" title="The recovery bin is empty">Anything you move to the bin from search, media or AI history waits here before it is removed.</Empty></div>}
        {d && d.total > 0 && (
          <div className="group" role="list" aria-label="Deleted items">{d.items.map((it: any) => (
            <div key={`${it.type}:${it.id}`} className="bin-row" role="listitem">
              <span className={`rec-icon t-${it.type}`} style={{ width: 28, height: 28 }}><Icon name={TYPE_ICON[it.type] ?? (it.type === "ai_conversation" ? "sparkles" : "doc")} size={14} /></span>
              <div className="b-main">
                <div className="b-title ellipsis">{it.title ?? it.id}</div>
                <div className="b-sub">{it.type.replace("_", " ")} · deleted <Time at={it.deletedAt} /> · removed for good <Time at={it.purgeAt} /></div>
                {it.detail ? <div className="b-sub ellipsis">{String(it.detail).slice(0, 160)}</div> : null}
              </div>
              <button className="btn btn-sm" onClick={() => void act(() => api.post(`/api/bin/${it.type}/${it.id}/restore`, {}), `Restored ${it.type}.`)}><Icon name="restore" size={13} />Restore</button>
              <button className="btn btn-sm btn-danger" onClick={() => setConfirm(it)}>Delete permanently…</button>
            </div>
          ))}</div>
        )}
        {d && Math.ceil(d.total / d.pageSize) > 1 && <Pager page={d.page} pages={Math.ceil(d.total / d.pageSize)} total={d.total} onPage={setPage} />}
      </div>
      {confirm && (
        <Sheet title="Delete permanently?" label="Confirm permanent delete" onClose={() => setConfirm(null)}
          footer={<><button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-danger-fill" onClick={() => void act(() => api.del(`/api/bin/${confirm.type}/${confirm.id}`), `Permanently deleted ${confirm.type}.`)}>Delete permanently</button></>}>
          <p role="alert">Permanently delete {confirm.type} “{confirm.title ?? confirm.id}”? This removes {REMOVES[confirm.type] ?? "the stored copy, extracted text, thumbnails and search entries"}. It cannot be undone.</p>
        </Sheet>
      )}
    </div>
  );
}
