import { useState } from "react";
import { errText } from "../api.ts";
import { useApi, useEvents, useLoad } from "../ctx.tsx";
import { Empty, ErrorLine, Pager, Time } from "../ui.tsx";

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
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); } catch (e) { setMsg(errText(e)); } setConfirm(null); b.reload(); };
  const d = b.data;
  return (
    <div>
      <h2>Recovery bin</h2>
      <p className="small muted">Items deleted inside the vault stay here for {d?.retentionDays ?? "…"} days, then are removed permanently. Deletion at the source (on a device) is different: those records stay in the vault, marked “deleted at source”.</p>
      <ErrorLine error={b.error} />
      {msg && <p role="status">{msg}</p>}
      {d && d.total === 0 && <Empty>The recovery bin is empty.</Empty>}
      {d && d.total > 0 && (
        <table>
          <thead><tr><th>Type</th><th>Item</th><th>Deleted in vault</th><th>Purged automatically</th><th></th></tr></thead>
          <tbody>{d.items.map((it: any) => {
            const k = `${it.type}:${it.id}`;
            return (
              <tr key={k}>
                <td>{it.type}</td>
                <td>{it.title ?? it.id}{it.detail ? <div className="small muted">{String(it.detail).slice(0, 160)}</div> : null}</td>
                <td><Time at={it.deletedAt} /></td><td><Time at={it.purgeAt} /></td>
                <td>
                  <button onClick={() => void act(() => api.post(`/api/bin/${it.type}/${it.id}/restore`, {}), `Restored ${it.type}.`)}>Restore</button>{" "}
                  {confirm === k ? (
                    <span className="confirm" role="alertdialog" aria-label="Confirm permanent delete">
                      <span className="warn">Permanently delete {it.type} “{it.title ?? it.id}”? This removes {REMOVES[it.type] ?? "the stored copy, extracted text, thumbnails and search entries"}. It cannot be undone.</span>{" "}
                      <button onClick={() => void act(() => api.del(`/api/bin/${it.type}/${it.id}`), `Permanently deleted ${it.type}.`)}>Delete permanently</button>{" "}
                      <button onClick={() => setConfirm(null)}>Cancel</button>
                    </span>
                  ) : <button onClick={() => setConfirm(k)}>Delete permanently…</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      {d && Math.ceil(d.total / d.pageSize) > 1 && <Pager page={d.page} pages={Math.ceil(d.total / d.pageSize)} total={d.total} onPage={setPage} />}
    </div>
  );
}
