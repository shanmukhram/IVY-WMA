/**
 * Conversations (C1-C10, WX1): one entry per capture source in the sidebar, each opening an
 * app-like two-pane view — the chat list (avatar, last message, time) and the open chat in
 * bubbles (mine on the right, theirs on the left, real names, sender avatars in groups, inline
 * images, date separators, reply quotes, edit marks, deleted-at-source marks, forwarded-from,
 * attachment chips). The peer profile is not a permanent pane: it opens as a slide-over when the
 * header name/avatar or a sender name is clicked, and closes with Esc or its close button.
 *
 * The Telegram chats carry a Telegram-blue accent, the LINE chats a LINE-green one; the accent and
 * own-bubble color follow the open conversation's platform, light and dark alike.
 *
 * Fields the service is growing (used when present, with a graceful fallback when absent):
 *   chat list item   { id, title?, avatarUrl?, lastText?, lastAt?, platform, source?, ...current }
 *   thread message   { id, fromMe?, sender, senderName?, senderAvatarUrl?, sentAt?, text, editedAt?,
 *                      deletedAtSource?, forwardedFrom?, previewOnly?, attachments?/sources? ...current }
 *   attachment       { kind, filename, imageUrl?, status, ...current }
 *   profile          { title?, avatarUrl?, platform, account, coverageText?, messageCount?, firstAt?,
 *                      lastAt?, members?, ...current }
 * The current shapes (snake_case message fields, `lastMessage`, `messages`/`firstMessageAt`, …) are
 * still read, so this merges cleanly whichever lands first.
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
import { SlideOver } from "../components/Overlay.tsx";
import { chatSourceLabel } from "../components/Sidebar.tsx";
import { BlockedContactsSheet, HiddenChatsSheet, LineSettingsSheet, LineToolbar, useLineAccount } from "./Line.tsx";

type SourceClaim = { source: string; coverage: string };
export interface Chat {
  id: string; platform: string; account: string; convKey: string; peer: string | null; kind: string; coverage: string;
  chatTitle?: string | null; chatType?: string | null; participantCount?: number | null;
  coverageSources?: SourceClaim[]; coverageText?: string;
  title?: string | null; avatarUrl?: string | null; source?: string; lastText?: string | null; lastAt?: string | null;
  messageCount: number; firstMessageAt?: string | null; lastMessageAt: string | null;
  lastMessage?: { id: string; sender: string; senderName?: string | null; fromMe?: boolean; sentAt: string; text: string; mediaKind?: string | null; sourceStatus?: string } | null;
}
export interface Msg {
  id: string; msg_key: string; sender: string; senderName?: string | null; senderAvatarUrl?: string | null; fromMe?: boolean;
  sent_at: string; sentAt?: string; captured_at: string; capturedAt?: string; text: string; text_quality?: string; previewOnly?: boolean;
  reply_to: string | null; replyTo?: string | null; edited_at: string | null; editedAt?: string | null;
  source_status: string; source_deleted_at?: string | null; deletedAtSource?: string | null;
  forwarded_from: string | null; forwardedFrom?: string | null; media_kind: string | null; mediaKind?: string | null;
  sources?: Array<{ source: string; deletedAtSource: string | null }>; attachments?: Att[];
}
interface Att { id: string; messageId?: string; kind: string; filename: string; imageUrl?: string | null; status: string; size?: number | null }

const covTone = (c: string) => (c === "complete" ? "green" : c === "partial" ? "amber" : undefined) as "green" | "amber" | undefined;
export const chatName = (c: Pick<Chat, "peer" | "chatTitle" | "convKey" | "title">) => c.title ?? c.peer ?? c.chatTitle ?? c.convKey;
/** Mine: an explicit per-message flag when the source gives one, else the sender is the account itself. */
export const isMine = (sender: string, account: string) => sender === account || /^(me|you|self|\(me\))$/i.test(sender.trim());
const fromMe = (m: Msg, account: string) => m.fromMe ?? isMine(m.sender, account);
/** A raw platform id (e.g. "u15614381…", a long number) rather than a person's name. */
export const looksLikeId = (s: string) => /^[a-z]?\d{6,}$/i.test(s.trim()) || /^u[0-9a-f]{6,}$/i.test(s.trim()) || /^[0-9a-f]{12,}$/i.test(s.trim());

const mSentAt = (m: Msg) => m.sentAt ?? m.sent_at;
const mEditedAt = (m: Msg) => m.editedAt ?? m.edited_at ?? null;
const mReplyTo = (m: Msg) => m.replyTo ?? m.reply_to ?? null;
const mForwarded = (m: Msg) => m.forwardedFrom ?? m.forwarded_from ?? null;
const mMediaKind = (m: Msg) => m.mediaKind ?? m.media_kind ?? null;
const mPreview = (m: Msg) => m.previewOnly ?? m.text_quality === "preview";
const mDeleted = (m: Msg) => m.deletedAtSource != null || m.source_status === "deleted_at_source";

/** Telegram blue / LINE green, applied around the open conversation only. */
const platformTheme = (platform: string | undefined) => {
  const p = (platform ?? "").toLowerCase();
  return p === "telegram" || p === "line" ? ` conv-${p}` : "";
};

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
  const [profileOpen, setProfileOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState<null | "hidden" | "blocked" | "settings">(null);
  const list = useLoad<any>((a) => a.get("/api/views/chats", { source, role, platform, q: q.trim() || undefined }), [source, role, platform, q]);
  const reload = useDebounced(list.reload, 1500);
  useEvents(() => reload(), ["ingest.committed"]);
  const chats = (list.data?.items ?? []) as Chat[];
  const selected = chatParam ?? chats[0]?.id ?? null;
  const current = chats.find((c) => c.id === selected);
  const activePlatform = current?.platform ?? platform;
  const isLine = (activePlatform ?? "").toLowerCase() === "line";
  const lineAccount = useLineAccount(isLine);
  useEffect(() => { if (!isLine) setLineOpen(null); }, [isLine]);
  const open = (id: string) => {
    setProfileOpen(false);
    if (scope.embedded) setLocal({ chat: id, around: null });
    else navigate(href("/conversations", { source, platform, chat: id }), true);
  };
  const title = scope.title ?? (source ? chatSourceLabel({ platform: platform ?? "", role: source.split(":")[0]!, collector: source.split(":")[1] ?? "" }).replace(/^ · /, "") : "All chats");

  return (
    <div className={`panes${platformTheme(activePlatform)}`} style={scope.embedded ? { height: 620, border: "1px solid var(--separator)", borderRadius: 12, overflow: "hidden" } : undefined}>
      <section className="pane pane-list" aria-label="Chats">
        <div className="pane-head" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <div className="row">{(platform || source) && <AppIcon app={platform ?? ""} size={20} />}<h1 className="ellipsis">{title}</h1><span className="spacer" />{list.data && <span className="small faint">{list.data.total}</span>}</div>
          <SearchField aria-label="Search chats" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
          {isLine && <LineToolbar counts={lineAccount.data?.counts} onHidden={() => setLineOpen("hidden")} onBlocked={() => setLineOpen("blocked")} onSettings={() => setLineOpen("settings")} />}
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
            const mine = lm ? lm.fromMe ?? isMine(lm.sender, c.account) : false;
            const who = lm ? (lm.senderName ?? lm.sender) : "";
            const preview = c.lastText ?? (lm ? `${mine ? "You: " : c.kind === "group" ? `${who}: ` : ""}${lm.text || (lm.mediaKind ? `[${lm.mediaKind}]` : "")}` : "No messages");
            return (
              <button key={c.id} className="chat-item" aria-current={c.id === selected ? "true" : undefined} onClick={() => open(c.id)} data-testid="chat-item">
                <Avatar name={name} size={40} colorKey={`${c.platform}:${c.convKey}`} src={c.avatarUrl} />
                <span className="ci-main">
                  <span className="ci-top"><span className="ci-name" title={name}>{name}</span><span className="ci-time">{shortWhen(c.lastAt ?? c.lastMessageAt)}</span></span>
                  <span className="ci-preview">{preview}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {selected ? (
        <Thread key={selected} id={selected} around={around} hintAvatar={current?.avatarUrl ?? null} onOpenProfile={() => setProfileOpen(true)} />
      ) : (
        <section className="pane pane-main" aria-label="Chat"><Empty icon="chat" title="No chat selected">Pick a chat on the left.</Empty></section>
      )}
      {selected && profileOpen && <ProfileSheet id={selected} onClose={() => setProfileOpen(false)} />}
      {isLine && lineOpen === "hidden" && <HiddenChatsSheet onClose={() => setLineOpen(null)} />}
      {isLine && lineOpen === "blocked" && <BlockedContactsSheet onClose={() => setLineOpen(null)} />}
      {isLine && lineOpen === "settings" && <LineSettingsSheet account={lineAccount.data} onClose={() => setLineOpen(null)} />}
    </div>
  );
}

function Thread({ id, around, hintAvatar, onOpenProfile }: { id: string; around: string | null; hintAvatar: string | null; onOpenProfile: () => void }) {
  const api = useApi();
  const [before, setBefore] = useState(40);
  const [after, setAfter] = useState(40);
  const r = useLoad<any>((a) => a.get(`/api/views/chats/${encodeURIComponent(id)}/messages`, { around: around ?? undefined, before, after }), [id, around, before, after]);
  const msgs = (r.data?.messages ?? []) as Msg[];
  const conv = r.data?.conversation as (Chat & { conv_key?: string }) | undefined;
  const [lightbox, setLightbox] = useState<number | null>(null);
  // the thread route serves each message's attachments inline; fall back to the separate lookup
  const inlineAtts = useMemo(() => {
    let has = false; const by: Record<string, Att[]> = {};
    for (const m of msgs) if (Array.isArray(m.attachments)) { has = true; for (const a of m.attachments) (by[m.id] ??= []).push(a); }
    return has ? by : null;
  }, [msgs]);
  const [fetched, setFetched] = useState<Record<string, Att[]>>({});
  const ids = msgs.map((m) => m.id).join(",");
  useEffect(() => {
    if (inlineAtts || !ids) { setFetched({}); return; }
    api.get("/api/attachments", { message: ids }).then((x: any) => {
      const by: Record<string, Att[]> = {};
      for (const a of x.items as Att[]) (by[a.messageId ?? ""] ??= []).push(a);
      setFetched(by);
    }, () => setFetched({}));
  }, [api, ids, inlineAtts]);
  const atts = inlineAtts ?? fetched;
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
  const account = conv?.account ?? "";
  const group = conv?.kind === "group";
  // every inline image in thread order, so the lightbox can page through them
  const images = useMemo(() => {
    const out: Array<{ id: string; url: string; name: string }> = [];
    for (const m of msgs) for (const a of atts[m.id] ?? []) if (a.imageUrl) out.push({ id: a.id, url: a.imageUrl, name: a.filename });
    return out;
  }, [msgs, atts]);
  const imageIndex = useMemo(() => new Map(images.map((im, i) => [im.id, i])), [images]);
  const multiSource = (conv?.coverageSources?.length ?? 0) > 1 || msgs.some((m) => (m.sources?.length ?? 0) > 1);
  const name = conv ? chatName({ peer: conv.peer, chatTitle: conv.chatTitle, convKey: conv.convKey ?? conv.conv_key ?? "", title: conv.title }) : "";
  let lastDay = "", lastSender = "";

  return (
    <section className="pane pane-main" aria-label="Chat">
      <div className="pane-head">
        {conv && (
          <button className="thread-id" onClick={onOpenProfile} aria-label={`About ${name}`} aria-haspopup="dialog">
            <Avatar name={name} size={32} colorKey={`${conv.platform}:${conv.convKey ?? conv.conv_key}`} src={conv.avatarUrl ?? hintAvatar} />
            <span className="thread-id-text">
              <span className="thread-id-name ellipsis">{name}</span>
              {conv && <span className="small faint ellipsis row" style={{ gap: 4 }}><AppIcon app={conv.platform} size={14} />{platformLabel(conv.platform)} · {conv.account} · {group ? `group${conv.participantCount ? ` of ${conv.participantCount}` : ""}` : "direct"}</span>}
            </span>
          </button>
        )}
        <span className="spacer" />
        {conv && <span data-testid="coverage-sources" title={conv.coverageText}><CoverageBadge coverage={conv.coverage} sources={conv.coverageSources} /></span>}
      </div>
      <div className="msgs" ref={scroller} role="log" aria-label="Messages">
        <ErrorLine error={r.error} />
        {conv && msgs.length === 0 && <Empty icon="chat" title="No archived messages">This conversation has no archived messages.</Empty>}
        {msgs.length > 0 && <button className="btn btn-sm load-more" onClick={() => setBefore((b) => b + 40)}>Load earlier messages</button>}
        {msgs.map((m) => {
          const at = mSentAt(m);
          const day = dayKey(at);
          const sep = day !== lastDay ? <div className="date-chip" role="separator" aria-label={dayLabel(day)}>{dayLabel(day)}</div> : null;
          const mine = conv ? fromMe(m, account) : false;
          const runStart = m.sender !== lastSender || !!sep;
          const showSender = !mine && group && runStart;
          const showAvatar = !mine && group; // reserve the gutter; the photo shows at a run start
          lastDay = day; lastSender = m.sender;
          const quoted = mReplyTo(m) ? byId.get(mReplyTo(m)!) : undefined;
          const deleted = mDeleted(m);
          const sources = m.sources ?? [];
          const senderLabel = m.senderName ?? m.sender;
          const senderIsId = !m.senderName && looksLikeId(m.sender);
          const mAtts = atts[m.id] ?? [];
          return (
            <div key={m.id} style={{ display: "contents" }}>
              {sep}
              <div className={`msg ${mine ? "mine" : "theirs"}${m.id === around ? " hit" : ""}${deleted ? " deleted" : ""}`} data-testid={m.id === around ? "thread-hit" : "message"} data-mine={mine ? "true" : "false"}>
                {showAvatar && (showSender
                  ? <Avatar name={senderLabel} size={26} colorKey={`${conv?.platform}:${m.sender}`} src={m.senderAvatarUrl} />
                  : <span className="msg-ava-gap" aria-hidden="true" />)}
                <div className="msg-col">
                  {showSender && (
                    <button className={`sender${senderIsId ? " is-id" : ""}`} onClick={onOpenProfile} aria-haspopup="dialog">{senderLabel}</button>
                  )}
                  <div className="mb">
                    {mForwarded(m) && <span className="fwd"><Icon name="forward" size={11} /> Forwarded from {mForwarded(m)}</span>}
                    {mReplyTo(m) && <span className="quote" data-testid="reply-quote">{quoted ? <><b>{fromMe(quoted, account) ? "You" : quoted.senderName ?? quoted.sender}</b>{quoted.text || (mMediaKind(quoted) ? `[${mMediaKind(quoted)}]` : "")}</> : "Reply to an earlier message"}</span>}
                    {m.text || (mMediaKind(m) ? <span className="media-kind">[{mMediaKind(m)}]</span> : (mAtts.length === 0 && <span className="media-kind">(no text)</span>))}
                    {mAtts.length > 0 && (
                      <div className="atts">{mAtts.map((a) => (a.imageUrl ? (
                        <button key={a.id} type="button" className="att-img" data-testid="attachment-image" onClick={() => setLightbox(imageIndex.get(a.id) ?? 0)}>
                          <img src={a.imageUrl} alt={a.filename} loading="lazy" />
                        </button>
                      ) : (
                        <span key={a.id} className="att-chip" data-testid="attachment"><Icon name="paperclip" size={12} />{a.filename}
                          <span className="att-status">{a.kind} · {a.status === "cached" ? "cached locally" : a.status === "on_demand" ? "on device (on demand)" : "indexed"}</span></span>
                      )))}</div>
                    )}
                  </div>
                  <div className="mmeta">
                    <time dateTime={at} title={`sent: ${fmtTime(at)}\ncaptured: ${fmtTime(m.capturedAt ?? m.captured_at)}`}>{hm(at)}</time>
                    {mEditedAt(m) && <span title={`edited ${fmtTime(mEditedAt(m))}`}>edited</span>}
                    {deleted && <Badge tone="red">deleted at source (kept in vault)</Badge>}
                    {mPreview(m) && <Badge tone="amber">notification preview only</Badge>}
                    {multiSource && sources.length > 0 && (
                      <span title="capture sources">via {sources.map((s) => `${s.source}${s.deletedAtSource ? " (deleted there)" : ""}`).join(", ")}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {msgs.length > 0 && <button className="btn btn-sm load-more" onClick={() => setAfter((x) => x + 40)}>Load later messages</button>}
      </div>
      {lightbox !== null && images[lightbox] && (
        <Lightbox images={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </section>
  );
}

function Lightbox({ images, index, onIndex, onClose }: { images: Array<{ url: string; name: string }>; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const prev = () => onIndex(Math.max(0, index - 1));
  const next = () => onIndex(Math.min(images.length - 1, index + 1));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });
  const im = images[index]!;
  return (
    <div className="att-lightbox" role="dialog" aria-modal="true" aria-label={`Image: ${im.name}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="btn btn-sm lb-close" onClick={onClose} aria-label="Close image" autoFocus><Icon name="close" size={13} />Close</button>
      {images.length > 1 && <span className="lb-count tnum">{index + 1} of {images.length}</span>}
      {images.length > 1 && <button className="lb-nav lb-prev" onClick={prev} disabled={index <= 0} aria-label="Previous image"><Icon name="chevronLeft" size={18} /></button>}
      <img src={im.url} alt={im.name} />
      {images.length > 1 && <button className="lb-nav lb-next" onClick={next} disabled={index >= images.length - 1} aria-label="Next image"><Icon name="chevronRight" size={18} /></button>}
    </div>
  );
}

function ProfileSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const p = useLoad<any>((a) => a.get(`/api/views/chats/${encodeURIComponent(id)}/profile`), [id]);
  const d = p.data;
  const c = d?.conversation;
  const name = c ? chatName(c) : "Profile";
  const avatarUrl = d?.avatarUrl ?? c?.avatarUrl ?? null;
  const memberList: any[] | null = Array.isArray(d?.members) ? d.members : null;
  const memberCount = d?.memberCount ?? c?.participantCount ?? memberList?.length ?? null;
  const messageCount = d?.messageCount ?? d?.messages ?? 0;
  const firstAt = d?.firstAt ?? d?.firstMessageAt ?? null;
  const lastAt = d?.lastAt ?? d?.lastMessageAt ?? null;
  return (
    <SlideOver title={c ? name : "Profile"} label="Profile" onClose={onClose}>
      <ErrorLine error={p.error} />
      {c && (
        <div className="profile">
          <div className="p-head">
            <Avatar name={name} size={72} colorKey={`${c.platform}:${c.convKey}`} src={avatarUrl} alt={`${name} avatar`} />
            <span className="small muted row" style={{ gap: 4 }}><AppIcon app={c.platform} size={16} />{platformLabel(c.platform)} · {c.kind === "group" ? `group${memberCount ? ` · ${memberCount} members` : ""}` : "direct chat"}</span>
            <CoverageBadge coverage={c.coverage} sources={c.coverageSources} />
          </div>
          <div>
            <h2 className="group-title">Details</h2>
            <div className="group">
              <div className="group-row"><span className="row-label muted">Platform</span><span className="row" style={{ gap: 6 }}><AppIcon app={c.platform} size={16} />{platformLabel(c.platform)}</span></div>
              <div className="group-row"><span className="row-label muted">Account</span><span className="ellipsis">{c.account}</span></div>
              {c.chatType && <div className="group-row"><span className="row-label muted">Chat type</span><span>{c.chatType}</span></div>}
              <div className="group-row"><span className="row-label muted">Messages</span><span className="tnum">{messageCount}</span></div>
              <div className="group-row"><span className="row-label muted">First message</span><span className="tnum small" title={fmtTime(firstAt)}>{friendlyTime(firstAt)}</span></div>
              <div className="group-row"><span className="row-label muted">Last message</span><span className="tnum small" title={fmtTime(lastAt)}>{friendlyTime(lastAt)}</span></div>
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
          {((memberList && memberList.length > 1) || (d.senders as any[])?.length > 1) && (
            <div>
              <h2 className="group-title">{memberList && memberList.length > 1 ? "Members" : "Most messages from"}</h2>
              <div className="group">{(memberList && memberList.length > 1 ? memberList : d.senders).map((s: any) => {
                const label = s.name ?? s.senderName ?? s.sender;
                const key = s.id ?? s.sender ?? label;
                return (
                  <div key={key} className="group-row"><Avatar name={label} size={22} src={s.avatarUrl} /><span className="row-label ellipsis">{s.sender && isMine(s.sender, c.account) ? `${label} (you)` : label}</span>{typeof s.n === "number" && <span className="tnum faint">{s.n}</span>}</div>
                );
              })}</div>
            </div>
          )}
        </div>
      )}
    </SlideOver>
  );
}
