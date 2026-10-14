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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApi, useDebounced, useEvents, useLoad } from "../ctx.tsx";
import type { ServiceEvent } from "../events.ts";
import type { Api, Query } from "../api.ts";
import { href, navigate, useLocation } from "../router.ts";
import { useScope } from "../scope.tsx";
import { COVERAGE_LABEL, dayKey, dayLabel, fmtTime, friendlyTime, hm, platformLabel, shortWhen, sourceLabel } from "../format.ts";
import { Avatar } from "../components/Avatar.tsx";
import { AppIcon } from "../components/AppIcon.tsx";
import { Icon } from "../components/Icon.tsx";
import { CallRow, callDuration, callLabel, type MsgCall } from "../components/CallRow.tsx";

export { callDuration, callLabel, type MsgCall };
import { SearchField, Segmented } from "../components/Controls.tsx";
import { Badge, Empty, ErrorLine } from "../components/Feedback.tsx";
import { SlideOver } from "../components/Overlay.tsx";
import { chatSourceLabel } from "../components/Sidebar.tsx";
import { BlockedContactsSheet, HiddenChatsSheet, LineSettingsSheet, LineToolbar, useLineAccount } from "./Line.tsx";

type SourceClaim = { source: string; coverage: string };
export interface Chat {
  id: string; platform: string; account: string; convKey: string; peer: string | null; kind: string | null; coverage: string;
  chatTitle?: string | null; chatType?: string | null; participantCount?: number | null;
  /** where the owner's own app lists the chat: normal, archived (Telegram) or hidden (LINE); null/absent when unknown */
  listing?: "normal" | "archived" | "hidden" | null;
  /** LINE's own chat options: notifications off, pinned; null/absent when no source has said */
  muted?: boolean | null; pinned?: boolean | null;
  /** a chat LINE lists but with no message captured on this PC (no conversation to open) */
  placeholder?: boolean;
  coverageSources?: SourceClaim[]; coverageText?: string;
  title?: string | null; avatarUrl?: string | null; source?: string; lastText?: string | null; lastAt?: string | null;
  messageCount: number; firstMessageAt?: string | null; lastMessageAt: string | null;
  lastMessage?: { id: string; sender: string; senderName?: string | null; fromMe?: boolean; sentAt: string; text: string; mediaKind?: string | null; sourceStatus?: string; call?: MsgCall | null } | null;
}
export interface Msg {
  id: string; msg_key: string; sender: string; senderName?: string | null; senderAvatarUrl?: string | null; fromMe?: boolean;
  sent_at: string; sentAt?: string; captured_at: string; capturedAt?: string; text: string; text_quality?: string; previewOnly?: boolean;
  reply_to: string | null; replyTo?: string | null; edited_at: string | null; editedAt?: string | null;
  source_status: string; source_deleted_at?: string | null; deletedAtSource?: string | null;
  forwarded_from: string | null; forwardedFrom?: string | null; media_kind: string | null; mediaKind?: string | null;
  sources?: Array<{ source: string; deletedAtSource: string | null }>; attachments?: Att[];
  call?: MsgCall | null;
}
interface Att { id: string; messageId?: string; kind: string; filename: string; imageUrl?: string | null; status: string; size?: number | null }
/** Where an attachment's original is. phone_only: captured by LINE for Windows, which keeps no
 *  inline media on disk (PLAN decision 12); the original is on the phone, not fetchable from the PC. */
export const attStatusLabel = (status: string) =>
  status === "cached" ? "cached locally" : status === "on_demand" ? "on device (on demand)" : status === "phone_only" ? "original on the phone" : "indexed";

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
/** The service clamps the thread's before/after counts to this. */
const MAX_WINDOW = 200;

/** True when a scroll box is at, or within `slack` px of, its bottom; a live refresh then keeps it pinned there. */
export function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/**
 * Whether an `ingest.committed` event may have changed conversation `id`: a message batch for that
 * conversation, or a message batch whose event does not say which conversation it was for.
 */
export function commitTouches(ev: ServiceEvent, id: string): boolean {
  if (ev.data?.kind !== "message_batch") return false;
  const c = ev.data.conversationId;
  return typeof c !== "string" || c === id;
}

/**
 * The thread window to fetch after `grow` new messages arrived, or null when a plain reload is enough.
 * Without `around` the route returns the newest message plus `before` older ones, so `before` grows to
 * keep the older messages on screen. With `around` it returns `before` older messages, the pivot and up
 * to `after` newer ones; when the shown window already reaches the newest message (fewer than after+1
 * from the pivot on), `after` grows so the new ones fit. Both are capped at the service's limit.
 */
export function liveWindow(o: { around: string | null; ids: string[]; before: number; after: number; grow: number }): { before: number; after: number } | null {
  if (o.grow <= 0) return null;
  if (!o.around) {
    const before = Math.min(MAX_WINDOW, o.before + o.grow);
    return before !== o.before ? { before, after: o.after } : null;
  }
  const i = o.ids.indexOf(o.around);
  const newer = i < 0 ? 1 : o.ids.length - i; // the pivot and everything after it
  if (newer > o.after) return null; // reading further back than the newest messages: nothing new would show
  const after = Math.min(MAX_WINDOW, Math.max(o.after, newer - 1 + o.grow));
  return after !== o.after ? { before: o.before, after } : null;
}

/** The first message bubble visible in the scroll box and its offset from the box's top edge. */
function firstVisible(el: HTMLElement): { id: string; top: number } | null {
  const box = el.getBoundingClientRect();
  for (const m of el.querySelectorAll<HTMLElement>("[data-mid]")) {
    const r = m.getBoundingClientRect();
    if (r.bottom > box.top) return { id: m.dataset.mid!, top: r.top - box.top };
  }
  return null;
}

const platformTheme = (platform: string | undefined) => {
  const p = (platform ?? "").toLowerCase();
  return p === "telegram" || p === "line" ? ` conv-${p}` : "";
};

/** The best coverage any source claims, with every source's own claim (WX1, C9). */
export function CoverageBadge({ coverage, sources }: { coverage: string; sources?: SourceClaim[] }) {
  const text = (sources ?? []).map((s) => `${COVERAGE_LABEL[s.coverage]?.toLowerCase() ?? s.coverage} via ${s.source}`).join("; ");
  return <Badge tone={covTone(coverage)} title={text || undefined}>{COVERAGE_LABEL[coverage] ?? coverage}</Badge>;
}

/** A small badge for a chat the owner archived (Telegram) or hid (LINE) in their own app; nothing for a normal chat. */
export function ListingBadge({ listing, platform }: { listing?: string | null; platform?: string }) {
  if (listing !== "archived" && listing !== "hidden") return null;
  const word = listing === "archived" ? "Archived" : "Hidden";
  return (
    <span className="listing-badge" data-testid="listing-badge" style={{ flex: "none", fontSize: "var(--text-xs)" }}>
      <Badge title={`${word} in ${platformLabel(platform ?? "")}`}>{word}</Badge>
    </span>
  );
}

/** A small labelled badge for one more tag (Pinned, Muted); nothing when the tag is off or unknown. */
function TagBadge({ on, word, platform, testId }: { on?: boolean | null; word: string; platform?: string; testId: string }) {
  if (!on) return null;
  return (
    <span className="listing-badge" data-testid={testId} style={{ flex: "none", fontSize: "var(--text-xs)" }}>
      <Badge title={`${word} in ${platformLabel(platform ?? "")}`}>{word}</Badge>
    </span>
  );
}

/** Every tag the owner's own app gives a chat, each with its own label: Archived or Hidden, Pinned, Muted. */
export function ChatTags({ chat }: { chat: Pick<Chat, "listing" | "muted" | "pinned" | "platform"> }) {
  return (
    <>
      <ListingBadge listing={chat.listing} platform={chat.platform} />
      <TagBadge on={chat.pinned} word="Pinned" platform={chat.platform} testId="pinned-badge" />
      <TagBadge on={chat.muted} word="Muted" platform={chat.platform} testId="muted-badge" />
    </>
  );
}

/** The chats view pages through the service at most this many at a time. */
const CHATS_PAGE = 500;

/**
 * Every chat for a query, not just the first page: the first page says how many pages there are,
 * the rest follow in order. A chat that moved between pages while they were fetched is kept once.
 */
export async function fetchAllChats(api: Api, query: Query): Promise<{ total: number; items: Chat[] }> {
  const first = await api.get<{ total: number; pages?: number; items: Chat[] }>("/api/views/chats", { ...query, page: 1, pageSize: CHATS_PAGE });
  const items = [...first.items];
  for (let page = 2; page <= (first.pages ?? 1); page++) {
    const r = await api.get<{ items: Chat[] }>("/api/views/chats", { ...query, page, pageSize: CHATS_PAGE });
    items.push(...r.items);
  }
  const seen = new Set<string>();
  return { ...first, items: items.filter((c) => !seen.has(c.id) && !!seen.add(c.id)) };
}

export type ListingFilter = "all" | "normal" | "archived" | "hidden";
export const LISTING_FILTERS: Array<[ListingFilter, string]> = [["all", "All"], ["normal", "Normal"], ["archived", "Archived"], ["hidden", "Hidden"]];
const LISTING_KEY = "ivy.chats.listing";
/** The chat list filter, remembered for this browser session (sessionStorage may be unavailable: then it is just not remembered). */
function useListingFilter(): [ListingFilter, (v: ListingFilter) => void] {
  const [value, setValue] = useState<ListingFilter>(() => {
    try {
      const v = sessionStorage.getItem(LISTING_KEY);
      return LISTING_FILTERS.some(([k]) => k === v) ? (v as ListingFilter) : "all";
    } catch { return "all"; }
  });
  const set = (v: ListingFilter) => {
    setValue(v);
    try { sessionStorage.setItem(LISTING_KEY, v); } catch { /* not remembered */ }
  };
  return [value, set];
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
  const [listing, setListing] = useListingFilter();
  const device = useScope().scope ?? undefined;
  const list = useLoad((a) => fetchAllChats(a, { source, role, device, platform, q: q.trim() || undefined, listing: listing === "all" ? undefined : listing }),
    [source, role, device, platform, q, listing]);
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
          <Segmented label="Show chats" value={listing} options={LISTING_FILTERS} onChange={setListing} />
          {isLine && <LineToolbar counts={lineAccount.data?.counts} onHidden={() => setLineOpen("hidden")} onBlocked={() => setLineOpen("blocked")} onSettings={() => setLineOpen("settings")} />}
        </div>
        <div className="pane-scroll" style={{ padding: 6 }}>
          <ErrorLine error={list.error} />
          {list.data && chats.length === 0 && (
            <Empty icon="chat" title={q ? "No chats match" : listing !== "all" ? `No ${listing} chats` : "No conversations yet"}>
              {q ? "Try another name." : listing !== "all" ? "Choose All to see every chat." : scope.emptyText ?? "Conversation history comes from the Windows app (Telegram Desktop session, LINE for Windows) and the Android companion's database reads. Notification previews are under Notifications."}
            </Empty>
          )}
          {chats.map((c) => {
            const name = chatName(c);
            const lm = c.lastMessage;
            const mine = lm ? lm.fromMe ?? isMine(lm.sender, c.account) : false;
            const who = lm ? (lm.senderName ?? lm.sender) : "";
            const preview = lm?.call ? callLabel(lm.call)
              : c.lastText ?? (lm ? `${mine ? "You: " : c.kind === "group" ? `${who}: ` : ""}${lm.text || (lm.mediaKind ? `[${lm.mediaKind}]` : "")}`
                : c.placeholder ? "No messages captured on this PC" : "No messages");
            return (
              <button key={c.id} className="chat-item" aria-current={c.id === selected ? "true" : undefined} onClick={() => open(c.id)} data-testid="chat-item"
                data-listing={c.listing ?? undefined} data-placeholder={c.placeholder ? "true" : undefined}>
                <Avatar name={name} size={40} colorKey={`${c.platform}:${c.convKey}`} src={c.avatarUrl} />
                <span className="ci-main">
                  <span className="ci-top"><span className="ci-name" title={name}>{name}</span><ChatTags chat={c} /><span className="ci-time">{shortWhen(c.lastAt ?? c.lastMessageAt)}</span></span>
                  <span className="ci-preview">{preview}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {current?.placeholder ? (
        <PlaceholderPane chat={current} />
      ) : selected ? (
        // keyed on the anchor too: dropping or changing `around` starts a fresh window (and fresh earlier history)
        <Thread key={`${selected}|${around ?? ""}`} id={selected} around={around} hintAvatar={current?.avatarUrl ?? null} onOpenProfile={() => setProfileOpen(true)}
          onJumpLatest={() => {
            if (scope.embedded) setLocal((l) => ({ ...l, around: null }));
            else navigate(href("/conversations", { source, platform, chat: selected }), true);
          }} />
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

/** A chat LINE lists but with no message captured on this PC: its name and tags, and why it is empty. */
function PlaceholderPane({ chat }: { chat: Chat }) {
  const name = chatName(chat);
  return (
    <section className="pane pane-main" aria-label="Chat" data-testid="placeholder-chat">
      <div className="pane-head">
        <Avatar name={name} size={32} colorKey={`${chat.platform}:${chat.convKey}`} src={chat.avatarUrl} />
        <span className="thread-id-text">
          <span className="thread-id-name ellipsis">{name}</span>
          <span className="small faint ellipsis row" style={{ gap: 4 }}><AppIcon app={chat.platform} size={14} />{platformLabel(chat.platform)} · {chat.account}</span>
        </span>
        <span className="spacer" />
        <ChatTags chat={chat} />
      </div>
      <div className="msgs">
        <Empty icon="chat" title="No messages captured on this PC">
          LINE lists this chat, but LINE for Windows holds none of its messages on this PC, so there is nothing to show yet.
        </Empty>
      </div>
    </section>
  );
}

/**
 * The open chat. Its messages are two parts:
 *  - the live window (`before`/`after` around the pivot, refetched by live refreshes, see liveWindow), and
 *  - `earlier`: messages older than the window, loaded by "Load earlier messages" and kept in their own
 *    state so the live window logic is unchanged. `earlier` always ends where the window starts (or
 *    overlaps it); the shown list is `earlier` minus anything the window also has, then the window, so a
 *    refetched window always wins for freshness. Before a live refresh that could move the window's
 *    start forward (the newest window at its 200 cap), the current window is folded into `earlier`, so
 *    nothing between the history and the new window is lost.
 */
function Thread({ id, around, hintAvatar, onOpenProfile, onJumpLatest }: { id: string; around: string | null; hintAvatar: string | null; onOpenProfile: () => void; onJumpLatest: () => void }) {
  const api = useApi();
  const [before, setBefore] = useState(40);
  const [after, setAfter] = useState(40);
  const url = `/api/views/chats/${encodeURIComponent(id)}/messages`;
  const device = useScope().scope ?? undefined;
  const r = useLoad<any>((a) => a.get(url, { around: around ?? undefined, before, after, device }), [id, around, before, after, device]);
  const windowMsgs = (r.data?.messages ?? []) as Msg[];
  const [earlier, setEarlier] = useState<Msg[]>([]);
  const msgs = useMemo(() => {
    if (!earlier.length) return windowMsgs;
    const inWindow = new Set(windowMsgs.map((m) => m.id));
    return [...earlier.filter((m) => !inWindow.has(m.id)), ...windowMsgs];
  }, [earlier, windowMsgs]);
  const conv = r.data?.conversation as (Chat & { conv_key?: string }) | undefined;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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

  // Live updates: when the service commits a message batch for this chat (or one it cannot attribute),
  // refetch the window after a short debounce, growing it so new messages fit (see liveWindow); edits
  // alone, or a window far back in history, get a plain reload of what is shown.
  const pendingNew = useRef(0);
  const folded = useRef<string | null>(null); // newest message id when the window was last folded into `earlier`
  const live = useRef<{ atBottom: boolean; anchor: { id: string; top: number } | null } | null>(null);
  const refresh = useDebounced(() => {
    const grow = pendingNew.current;
    pendingNew.current = 0;
    const el = scroller.current;
    live.current = { atBottom: el ? isNearBottom(el) : true, anchor: el ? firstVisible(el) : null };
    if (earlier.length && windowMsgs.length) {
      // fold the current window into the earlier history so a window whose start moves forward leaves no gap
      const shown = windowMsgs;
      setEarlier((e) => { const s = new Set(shown.map((m) => m.id)); return [...e.filter((m) => !s.has(m.id)), ...shown]; });
      folded.current = shown[shown.length - 1]!.id;
    }
    const w = liveWindow({ around, ids: windowMsgs.map((m) => m.id), before, after, grow });
    if (w) { setBefore(w.before); setAfter(w.after); } else r.reload();
  }, 500);
  useEvents((ev) => {
    if (!commitTouches(ev, id)) return;
    const n = ev.data.inserted;
    pendingNew.current += typeof n === "number" ? Math.max(0, n) : 1; // an event without a count: assume one new message
    refresh();
  }, ["ingest.committed"]);
  // When a live refresh lands: stay pinned to the bottom if the reader was there, else keep the
  // message they were looking at in the same place.
  useLayoutEffect(() => {
    const s = live.current, el = scroller.current;
    if (!s || r.loading || !el) return;
    live.current = null;
    if (s.atBottom) { el.scrollTop = el.scrollHeight; return; }
    if (!s.anchor) return;
    for (const m of el.querySelectorAll<HTMLElement>("[data-mid]")) {
      if (m.dataset.mid !== s.anchor.id) continue;
      const delta = m.getBoundingClientRect().top - el.getBoundingClientRect().top - s.anchor.top;
      if (delta) el.scrollTop += delta;
      break;
    }
  }, [r.data, r.loading, earlier]);

  // After a fold, the refetched window normally still contains the folded newest message. If more new
  // messages arrived than the window holds, it does not: page forward from there until the window's
  // first message is reached, so the history stays contiguous.
  useEffect(() => {
    const from = folded.current;
    if (!from || r.loading || !windowMsgs.length) return;
    folded.current = null;
    if (windowMsgs.some((m) => m.id === from)) return;
    const first = windowMsgs[0]!.id;
    const inWindow = new Set(windowMsgs.map((m) => m.id));
    (async () => {
      const add: Msg[] = [];
      let cursor = from;
      for (;;) {
        const page = await api.get<any>(url, { around: cursor, before: 0, after: MAX_WINDOW, device });
        if (!alive.current) return;
        const got = ((page?.messages ?? []) as Msg[]).filter((m) => m.id !== cursor);
        add.push(...got.filter((m) => !inWindow.has(m.id)));
        if (!got.length || got.length < MAX_WINDOW || got.some((m) => m.id === first)) break;
        cursor = got[got.length - 1]!.id;
      }
      if (add.length) setEarlier((e) => { const s = new Set(e.map((m) => m.id)); return [...e, ...add.filter((m) => !s.has(m.id))]; });
    })().catch(() => {});
  }, [r.data, r.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Load earlier messages": one click pages the route backwards (`around` = the oldest shown message,
  // `before` = the service's 200 cap, `after` = 0) until a page comes back short, i.e. the chat's first
  // message is on screen. Each page is prepended to `earlier` with the reader's place kept.
  const [hist, setHist] = useState<{ loading: boolean; done: boolean; count: number; error: unknown }>({ loading: false, done: false, count: 0, error: null });
  const loadHistory = async () => {
    if (hist.loading || !msgs.length) return;
    let list = msgs;
    setHist({ loading: true, done: false, count: list.length, error: null });
    try {
      for (;;) {
        const oldest = list[0]!.id;
        const page = await api.get<any>(url, { around: oldest, before: MAX_WINDOW, after: 0, device });
        if (!alive.current) return;
        const got = (page?.messages ?? []) as Msg[];
        if (!got.some((m) => m.id === oldest)) throw new Error("The oldest shown message is no longer in the archive; reopen the chat and try again.");
        const olderRaw = got.filter((m) => m.id !== oldest);
        const have = new Set(list.map((m) => m.id));
        const older = olderRaw.filter((m) => !have.has(m.id));
        if (older.length) {
          const el = scroller.current;
          if (el && !live.current) live.current = { atBottom: false, anchor: firstVisible(el) };
          list = [...older, ...list];
          setEarlier((e) => { const s = new Set(e.map((m) => m.id)); return [...older.filter((m) => !s.has(m.id)), ...e]; });
          setHist((h) => ({ ...h, count: list.length }));
        }
        if (!older.length || olderRaw.length < MAX_WINDOW) break;
      }
      setHist({ loading: false, done: true, count: list.length, error: null });
    } catch (error) {
      if (alive.current) setHist((h) => ({ ...h, loading: false, error }));
    }
  };
  // the first window may already reach the chat's first message (fewer older messages came back than asked for)
  const windowAtStart = !!r.data && !earlier.length && (() => {
    if (!around) return windowMsgs.length - 1 < before;
    const i = windowMsgs.findIndex((m) => m.id === around);
    return i >= 0 && i < before;
  })();
  const showEarlier = msgs.length > 0 && !hist.done && !windowAtStart;

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
        {conv && <ChatTags chat={conv} />}
        {conv && <span data-testid="coverage-sources" title={conv.coverageText}><CoverageBadge coverage={conv.coverage} sources={conv.coverageSources} /></span>}
      </div>
      <div className="msgs" ref={scroller} role="log" aria-label="Messages">
        <ErrorLine error={r.error} />
        {conv && msgs.length === 0 && <Empty icon="chat" title="No archived messages">This conversation has no archived messages.</Empty>}
        {showEarlier && (
          <button className="btn btn-sm load-more" onClick={loadHistory} disabled={hist.loading} aria-busy={hist.loading || undefined}>
            {hist.loading ? `Loading history… ${hist.count.toLocaleString("en-US")} messages` : "Load earlier messages"}
          </button>
        )}
        {showEarlier && <ErrorLine error={hist.error} />}
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
              <div className={`msg ${mine ? "mine" : "theirs"}${m.id === around ? " hit" : ""}${deleted ? " deleted" : ""}`} data-testid={m.id === around ? "thread-hit" : "message"} data-mid={m.id} data-mine={mine ? "true" : "false"}>
                {showAvatar && (showSender
                  ? <Avatar name={senderLabel} size={26} colorKey={`${conv?.platform}:${m.sender}`} src={m.senderAvatarUrl} />
                  : <span className="msg-ava-gap" aria-hidden="true" />)}
                <div className="msg-col">
                  {showSender && (
                    <button className={`sender${senderIsId ? " is-id" : ""}`} onClick={onOpenProfile} aria-haspopup="dialog">{senderLabel}</button>
                  )}
                  <div className="mb">
                    {mForwarded(m) && <span className="fwd"><Icon name="forward" size={11} /> Forwarded from {mForwarded(m)}</span>}
                    {mReplyTo(m) && <span className="quote" data-testid="reply-quote">{quoted ? <><b>{fromMe(quoted, account) ? "You" : quoted.senderName ?? quoted.sender}</b>{quoted.call ? callLabel(quoted.call) : quoted.text || (mMediaKind(quoted) ? `[${mMediaKind(quoted)}]` : "")}</> : "Reply to an earlier message"}</span>}
                    {m.call ? <CallRow call={m.call} />
                      : m.text || (mMediaKind(m) ? <span className="media-kind">[{mMediaKind(m)}]</span> : (mAtts.length === 0 && <span className="media-kind">(no text)</span>))}
                    {mAtts.length > 0 && (
                      <div className="atts">{mAtts.map((a) => (a.imageUrl ? (
                        <button key={a.id} type="button" className="att-img" data-testid="attachment-image" onClick={() => setLightbox(imageIndex.get(a.id) ?? 0)}>
                          <img src={a.imageUrl} alt={a.filename} loading="lazy" />
                        </button>
                      ) : (
                        <span key={a.id} className="att-chip" data-testid="attachment"><Icon name="paperclip" size={12} />{a.filename}
                          <span className="att-status">{a.kind} · {attStatusLabel(a.status)}</span></span>
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
        {/* opened at a search hit: drop the anchor to show the newest messages (the thread then stays live at the bottom) */}
        {around && msgs.length > 0 && <button className="btn btn-sm load-more" onClick={onJumpLatest}>Jump to latest</button>}
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
  const device = useScope().scope ?? undefined;
  const p = useLoad<any>((a) => a.get(`/api/views/chats/${encodeURIComponent(id)}/profile`, { device }), [id, device]);
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
                <div className="group-row"><span className="row-label muted">Attachments</span><span className="small">{Object.entries(d.attachments).map(([k, n]) => `${n} ${k === "phone_only" ? "with original on the phone" : k.replace("_", " ")}`).join(" · ")}</span></div>
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
