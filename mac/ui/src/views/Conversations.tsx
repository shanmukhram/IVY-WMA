import { useEffect, useState } from "react";
import { useApi, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { Chip, Empty, ErrorLine, Link, Pager, Time } from "../ui.tsx";

const COVERAGE_LABEL: Record<string, string> = { complete: "complete", partial: "partial", notification_only: "notification-only" };

export function CoverageBadge({ coverage }: { coverage: string }) {
  return <Chip kind={`cov-${coverage}`}>{COVERAGE_LABEL[coverage] ?? coverage}</Chip>;
}

export function ConversationsView() {
  const { path } = useLocation();
  const m = /^\/conversations\/([^/]+)/.exec(path);
  return m ? <Thread id={decodeURIComponent(m[1]!)} /> : <ConversationList />;
}

function ConversationList() {
  const { query } = useLocation();
  const platform = query.get("platform") ?? "";
  const page = Number(query.get("page") ?? 1) || 1;
  const r = useLoad((a) => a.get("/api/conversations", { platform, page }), [platform, page]);
  const d = r.data;
  const platforms = [...new Set(((d?.platforms ?? []) as Array<{ platform: string }>).map((p) => p.platform))];
  return (
    <div>
      <div className="toolbar">
        <label>App
          <select value={platform} onChange={(e) => navigate(href("/conversations", { platform: e.target.value || undefined }))}>
            <option value="">all</option>{platforms.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        {d?.platforms?.length > 0 && <span className="small muted">Coverage per app: {(d.platforms as any[]).map((p) => `${p.platform} ${COVERAGE_LABEL[p.coverage] ?? p.coverage} (${p.n})`).join(" · ")}</span>}
      </div>
      <ErrorLine error={r.error} />
      {d && d.total === 0 && (
        <Empty>No conversations in the vault yet. Conversation history comes from the Android companion's rooted database reads (LINE first, then Telegram, WhatsApp, SMS). Until then nothing is captured here; notification previews are under Notifications.</Empty>
      )}
      {d && d.total > 0 && (
        <table>
          <thead><tr><th>App</th><th>Conversation</th><th>Account</th><th>Kind</th><th>Coverage</th><th>Messages</th><th>Last message</th></tr></thead>
          <tbody>
            {(d.items as any[]).map((c) => (
              <tr key={c.id}>
                <td>{c.platform}</td>
                <td><Link to={`/conversations/${c.id}`}>{c.peer ?? c.convKey}</Link></td>
                <td>{c.account}</td><td>{c.kind}</td><td><CoverageBadge coverage={c.coverage} /></td>
                <td>{c.messageCount}</td><td><Time at={c.lastMessageAt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d && d.pages > 1 && <Pager page={d.page} pages={d.pages} total={d.total} onPage={(p) => navigate(href("/conversations", { platform, page: p }))} />}
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const api = useApi();
  const { query } = useLocation();
  const around = query.get("around") ?? "";
  const [before, setBefore] = useState(20);
  const [after, setAfter] = useState(20);
  useEffect(() => { setBefore(20); setAfter(20); }, [id, around]);
  const r = useLoad((a) => a.get(`/api/conversations/${encodeURIComponent(id)}/messages`, { around, before, after }), [id, around, before, after]);
  const msgs = (r.data?.messages ?? []) as any[];
  const [atts, setAtts] = useState<Record<string, any[]>>({});
  const ids = msgs.map((m) => m.id).join(",");
  useEffect(() => {
    if (!ids) { setAtts({}); return; }
    api.get("/api/attachments", { message: ids }).then((x: any) => {
      const by: Record<string, any[]> = {};
      for (const a of x.items) (by[a.messageId] ??= []).push(a);
      setAtts(by);
    }, () => setAtts({}));
  }, [api, ids]);
  const conv = r.data?.conversation;
  return (
    <div>
      <p><Link to="/conversations">← All conversations</Link></p>
      <ErrorLine error={r.error} />
      {conv && (
        <h2>{conv.platform} · {conv.peer ?? conv.conv_key} <span className="small muted">{conv.account} · {conv.kind}</span> <CoverageBadge coverage={conv.coverage} /></h2>
      )}
      {conv && msgs.length === 0 && <Empty>This conversation has no archived messages.</Empty>}
      {msgs.length > 0 && <button onClick={() => setBefore((b) => b + 20)}>Show 20 earlier</button>}
      <ol className="thread">
        {msgs.map((m) => (
          <li key={m.id} className={m.id === around ? "msg hit" : "msg"} data-testid={m.id === around ? "thread-hit" : undefined}>
            <div className="small"><strong>{m.sender}</strong> <Time at={m.sent_at} field="sent_at" captured={m.captured_at} />
              {m.edited_at && <Chip>edited <Time at={m.edited_at} /></Chip>}
              {m.source_status === "deleted_at_source" && <Chip kind="warn">deleted at source (kept in vault)</Chip>}
              {m.reply_to && <Chip>reply</Chip>}
            </div>
            <p className="msg-text">{m.text}</p>
            {(atts[m.id] ?? []).map((a) => (
              <Chip key={a.id} kind={`att-${a.status}`}>{a.kind} · {a.filename} · {a.status === "cached" ? "cached locally" : a.status === "on_demand" ? "on device (on demand)" : "indexed"}</Chip>
            ))}
          </li>
        ))}
      </ol>
      {msgs.length > 0 && <button onClick={() => setAfter((x) => x + 20)}>Show 20 later</button>}
    </div>
  );
}
