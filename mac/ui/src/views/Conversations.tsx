/**
 * Conversations (C1-C10, WX1): one entry per capture source in the sidebar, each opening an app-like
 * three-pane view: chats (avatar, last message, time) | the chat in bubbles (mine right, theirs left,
 * date separators, reply quotes, edit marks, deleted-at-source marks, attachment chips, forwarded-from)
 * | the profile (peer, platform, account, coverage per source, counts, first and last message).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApi, useDebounced, useEvents, useLoad } from "../ctx.tsx";
import { href, navigate, useLocation } from "../router.ts";
import { COVERAGE_LABEL, dayKey, dayLabel, fmtTime, friendlyTime, hm, platformLabel, shortWhen, sourceLabel } from "../format.ts";
import { Avatar } from "../components/Avatar.tsx";
import { AppIcon } from "../components/AppIcon.tsx";
import { Icon } from "../components/Icon.tsx";
import { SearchField } from "../components/Controls.tsx";
import { Badge, Empty, ErrorLine } from "../components/Feedback.tsx";
import { chatSourceLabel } from "../components/Sidebar.tsx";

type SourceClaim = { source: string; coverage: string };
export interface Chat {
  id: string; platform: string; account: string; convKey: string; peer: string | null; kind: string; coverage: string;
  chatTitle?: string | null; chatType?: string | null; participantCount?: number | null;
  coverageSources?: SourceClaim[]; coverageText?: string;
  messageCount: number; firstMessageAt?: string | null; lastMessageAt: string | null;
  lastMessage?: { id: string; sender: string; sentAt: string; text: string; mediaKind?: string | null; sourceStatus?: string } | null;
}
export interface Msg {
  id: string; msg_key: string; sender: string; sent_at: string; captured_at: string; text: string; text_quality?: string;
  reply_to: string | null; edited_at: string | null; source_status: string; source_deleted_at?: string | null;
  forwarded_from: string | null; media_kind: string | null; sources?: Array<{ source: string; deletedAtSource: string | null }>;
}

const covTone = (c: string) => (c === "complete" ? "green" : c === "partial" ? "amber" : undefined) as "green" | "amber" | undefined;
export const chatName = (c: Pick<Chat, "peer" | "chatTitle" | "convKey">) => c.peer ?? c.chatTitle ?? c.convKey;
/** Mine: the sender is the account itself (Telegram user id) or the platform's own-message marker. */
export const isMine = (sender: string, account: string) => sender === account || /^(me|you|self|\(me\))$/i.test(sender.trim());

/** The best coverage any source claims, with every source's own claim (WX1, C9). */
export function CoverageBadge({ coverage, sources }: { coverage: string; sources?: SourceClaim[] }) {
  const text = (sources ?? []).map((s) => `${COVERAGE_LABEL[s.coverage]?.toLowerCase() ?? s.coverage} via ${s.source}`).join("; ");
  return <Badge tone={covTone(coverage)} title={text || undefined}>{COVERAGE_LABEL[coverage] ?? coverage}</Badge>;
}

export interface ChatsScope { source?: string; role?: string; platform?: string; title?: string; embedded?: boolean; emptyText?: string }

export function ConversationsView(scope: ChatsScope = {}) {
  const loc = useLocation();
  const [local, setLocal] = useState<{ chat: string | null; around: string | null }>({ chat: null, around: null });
  const source = scope.embedded ? scope.source : loc.query.get("source") ?? undefined;
  const platform = scope.embedded ? scope.platform : loc.query.get("platform") ?? undefined;
  const role = scope.role;
  const chatParam = scope.embedded ? local.chat : loc.query.get("chat");
  const around = scope.embedded ? local.around : loc.query.get("around");
  const [q, setQ] = useState("");
  const list = useLoad<any>((a) => a.get("/api/views/chats", { source, role, platform, q: q.trim() || undefined }), [source, role, platform, q]);
  const reload = useDebounced(list.reload, 1500);
  useEvents(() => reload(), ["ingest.committed"]);
  const chats = (list.data?.items ?? []) as Chat[];
  const selected = chatParam ?? chats[0]?.id ?? null;
  const open = (id: string) => {
    if (scope.embedded) setLocal({ chat: id, around: null });
    else navigate(href("/conversations", { source, platform, chat: id }), true);
  };
  const title = scope.title ?? (source ? chatSourceLabel({ platform: platform ?? "", role: source.split(":")[0]!, collector: source.split(":")[1] ?? "" }).replace(/^ · /, "") : "All chats");

  return (
    <div className="panes" style={scope.embedded ? { height: 620, border: "1px solid var(--separator)", borderRadius: 12, overflow: "hidden" } : undefined}>
      <section className="pane pane-list" aria-label="Chats">
        <div className="pane-head" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div className="row">{(platform || source) && <AppIcon app={platform ?? ""} size={20} />}<h1 className="ellipsis">{title}</h1><span className="spacer" />{list.data && <span className="small faint">{list.data.total}</span>}</div>
          <SearchField aria-label="Search chats" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="pane-scroll" style={{ padding: 6 }}>
          <ErrorLine error={list.error} />
          {list.data && chats.length === 0 && (
            <Empty icon="chat" title={q ? "No chats match" : "No conversations yet"}>
              {q ? "Try another name." : scope.emptyText ?? "Conversation history comes from the Windows app (Telegram Desktop session, LINE for Windows) and the Android companion's database reads. Notification previews are under Notifications."}
            </Empty>
          )}
          {chats.map((c) => {
            const name = chatName(c);
            const lm = c.lastMessage;
            const preview = lm ? `${isMine(lm.sender, c.account) ? "You: " : c.kind === "group" ? `${lm.sender}: ` : ""}${lm.text || (lm.mediaKind ? `[${lm.mediaKind}]` : "")}` : "No messages";
            return (
              <button key={c.id} className="chat-item" aria-current={c.id === selected ? "true" : undefined} onClick={() => open(c.id)} data-testid="chat-item">
                <Avatar name={name} size={40} colorKey={`${c.platform}:${c.convKey}`} />
                <span className="ci-main">
                  <span className="ci-top"><span className="ci-name" title={name}>{name}</span><span className="ci-time">{shortWhen(c.lastMessageAt)}</span></span>
                  <span className="ci-preview">{preview}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {selected ? <Thread key={selected} id={selected} around={around} /> : (
        <section className="pane pane-main" aria-label="Chat"><Empty icon="chat" title="No chat selected">Pick a chat on the left.</Empty></section>
      )}
      {selected && <Profile id={selected} />}
    </div>
  );
}

function Thread({ id, around }: { id: string; around: string | null }) {
  const api = useApi();
  const [before, setBefore] = useState(40);
  const [after, setAfter] = useState(40);
  const r = useLoad<any>((a) => a.get(`/api/conversations/${encodeURIComponent(id)}/messages`, { around: around ?? undefined, before, after }), [id, around, before, after]);
  const msgs = (r.data?.messages ?? []) as Msg[];
  const conv = r.data?.conversation as (Chat & { conv_key?: string }) | undefined;
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
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!msgs.length || scrolled) return;
    const hit = around ? scroller.current?.querySelector<HTMLElement>("[data-testid='thread-hit']") : null;
    if (hit?.scrollIntoView) hit.scrollIntoView({ block: "center" });
    else if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    setScrolled(true);
  }, [msgs.length, around, scrolled]);

  const byId = useMemo(() => new Map(msgs.map((m) => [m.id, m])), [msgs]);
  const multiSource = (conv?.coverageSources?.length ?? 0) > 1 || msgs.some((m) => (m.sources?.length ?? 0) > 1);
  const name = conv ? chatName({ peer: conv.peer, chatTitle: conv.chatTitle, convKey: conv.convKey ?? conv.conv_key ?? "" }) : "";
  let lastDay = "", lastSender = "";

  return (
    <section className="pane pane-main" aria-label="Chat">
      <div className="pane-head">
        {conv && <Avatar name={name} size={30} colorKey={`${conv.platform}:${conv.convKey ?? conv.conv_key}`} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="ellipsis" style={{ fontSize: "var(--text-base)" }}>{name}</h2>
          {conv && <div className="small faint ellipsis row" style={{ gap: 4 }}><AppIcon app={conv.platform} size={16} />{platformLabel(conv.platform)} · {conv.account} · {conv.kind === "group" ? `group${conv.participantCount ? ` of ${conv.participantCount}` : ""}` : "direct"}</div>}
        </div>
        {conv && <span data-testid="coverage-sources" title={conv.coverageText}><CoverageBadge coverage={conv.coverage} sources={conv.coverageSources} /></span>}
      </div>
      <div className="msgs" ref={scroller} role="log" aria-label="Messages">
        <ErrorLine error={r.error} />
        {conv && msgs.length === 0 && <Empty icon="chat" title="No archived messages">This conversation has no archived messages.</Empty>}
        {msgs.length > 0 && <button className="btn btn-sm load-more" onClick={() => setBefore((b) => b + 40)}>Load earlier messages</button>}
        {msgs.map((m) => {
          const day = dayKey(m.sent_at);
          const sep = day !== lastDay ? <div className="date-chip" role="separator" aria-label={dayLabel(day)}>{dayLabel(day)}</div> : null;
          const mine = conv ? isMine(m.sender, conv.account) : false;
          const showSender = !mine && conv?.kind === "group" && (m.sender !== lastSender || !!sep);
          lastDay = day; lastSender = m.sender;
          const quoted = m.reply_to ? byId.get(m.reply_to) : undefined;
          const deleted = m.source_status === "deleted_at_source";
          const sources = m.sources ?? [];
          return (
            <div key={m.id} style={{ display: "contents" }}>
              {sep}
              <div className={`msg ${mine ? "mine" : "theirs"}${m.id === around ? " hit" : ""}${deleted ? " deleted" : ""}`} data-testid={m.id === around ? "thread-hit" : "message"} data-mine={mine ? "true" : "false"}>
                {showSender && <span className="sender">{m.sender}</span>}
                <div className="mb">
                  {m.forwarded_from && <span className="fwd"><Icon name="forward" size={11} /> Forwarded from {m.forwarded_from}</span>}
                  {m.reply_to && <span className="quote" data-testid="reply-quote">{quoted ? <><b>{isMine(quoted.sender, conv?.account ?? "") ? "You" : quoted.sender}</b>{quoted.text || (quoted.media_kind ? `[${quoted.media_kind}]` : "")}</> : "Reply to an earlier message"}</span>}
                  {m.text || (m.media_kind ? <span className="media-kind">[{m.media_kind}]</span> : <span className="media-kind">(no text)</span>)}
                </div>
                {(atts[m.id] ?? []).length > 0 && (
                  <div className="atts">{(atts[m.id] ?? []).map((a) => (
                    <span key={a.id} className="att-chip" data-testid="attachment"><Icon name="paperclip" size={12} />{a.filename}
                      <span className="att-status">{a.kind} · {a.status === "cached" ? "cached locally" : a.status === "on_demand" ? "on device (on demand)" : "indexed"}</span></span>
                  ))}</div>
                )}
                <div className="mmeta">
                  <time dateTime={m.sent_at} title={`sent: ${fmtTime(m.sent_at)}\ncaptured: ${fmtTime(m.captured_at)}`}>{hm(m.sent_at)}</time>
                  {m.edited_at && <span title={`edited ${fmtTime(m.edited_at)}`}>edited</span>}
                  {deleted && <Badge tone="red">deleted at source (kept in vault)</Badge>}
                  {m.text_quality === "preview" && <Badge tone="amber">notification preview only</Badge>}
                  {multiSource && sources.length > 0 && (
                    <span title="capture sources">via {sources.map((s) => `${s.source}${s.deletedAtSource ? " (deleted there)" : ""}`).join(", ")}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {msgs.length > 0 && <button className="btn btn-sm load-more" onClick={() => setAfter((x) => x + 40)}>Load later messages</button>}
      </div>
    </section>
  );
}

function Profile({ id }: { id: string }) {
  const p = useLoad<any>((a) => a.get(`/api/views/chats/${encodeURIComponent(id)}/profile`), [id]);
  const d = p.data;
  const c = d?.conversation;
  const name = c ? chatName(c) : "";
  return (
    <aside className="pane pane-side" aria-label="Profile">
      <div className="pane-scroll">
        <ErrorLine error={p.error} />
        {c && (
          <div className="profile">
            <div className="p-head">
              <Avatar name={name} size={72} colorKey={`${c.platform}:${c.convKey}`} />
              <h2>{name}</h2>
              <span className="small muted row" style={{ gap: 4 }}><AppIcon app={c.platform} size={16} />{platformLabel(c.platform)} · {c.kind === "group" ? `group${c.participantCount ? ` · ${c.participantCount} members` : ""}` : "direct chat"}</span>
              <CoverageBadge coverage={c.coverage} sources={c.coverageSources} />
            </div>
            <div>
              <h2 className="group-title">Details</h2>
              <div className="group">
                <div className="group-row"><span className="row-label muted">Platform</span><span className="row" style={{ gap: 6 }}><AppIcon app={c.platform} size={16} />{platformLabel(c.platform)}</span></div>
                <div className="group-row"><span className="row-label muted">Account</span><span className="ellipsis">{c.account}</span></div>
                {c.chatType && <div className="group-row"><span className="row-label muted">Chat type</span><span>{c.chatType}</span></div>}
                <div className="group-row"><span className="row-label muted">Messages</span><span className="tnum">{d.messages}</span></div>
                <div className="group-row"><span className="row-label muted">First message</span><span className="tnum small" title={fmtTime(d.firstMessageAt)}>{friendlyTime(d.firstMessageAt)}</span></div>
                <div className="group-row"><span className="row-label muted">Last message</span><span className="tnum small" title={fmtTime(d.lastMessageAt)}>{friendlyTime(d.lastMessageAt)}</span></div>
                {(d.edited > 0 || d.deletedAtSource > 0) && <div className="group-row"><span className="row-label muted">Edited · deleted at source</span><span className="tnum">{d.edited} · {d.deletedAtSource}</span></div>}
                {Object.keys(d.attachments ?? {}).length > 0 && (
                  <div className="group-row"><span className="row-label muted">Attachments</span><span className="small">{Object.entries(d.attachments).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(" · ")}</span></div>
                )}
              </div>
            </div>
            <div>
              <h2 className="group-title">Coverage per source</h2>
              <div className="group" aria-label="Coverage per source">
                {(d.sources as any[]).length === 0 && <div className="group-row small muted">No source has reported this chat.</div>}
                {(d.sources as any[]).map((s) => (
                  <div key={s.source} className="group-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 2 }} data-testid="profile-source">
                    <div className="row"><Icon name={s.source.startsWith("android:") ? "phone" : "laptop"} size={16} /><span style={{ fontWeight: 500, minWidth: 0 }}>{sourceLabel(s.source)}</span><span className="spacer" />{s.coverage ? <Badge tone={covTone(s.coverage)}>{COVERAGE_LABEL[s.coverage] ?? s.coverage}</Badge> : <Badge>no claim</Badge>}</div>
                    <span className="small faint">{s.messages} message(s){s.deletedThere ? ` · ${s.deletedThere} deleted there` : ""}{s.lastSeenAt ? ` · last seen ${shortWhen(s.lastSeenAt)}` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
            {(d.senders as any[]).length > 1 && (
              <div>
                <h2 className="group-title">Most messages from</h2>
                <div className="group">{(d.senders as Array<{ sender: string; n: number }>).map((s) => (
                  <div key={s.sender} className="group-row"><Avatar name={s.sender} size={22} /><span className="row-label ellipsis">{isMine(s.sender, c.account) ? `${s.sender} (you)` : s.sender}</span><span className="tnum faint">{s.n}</span></div>
                ))}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

