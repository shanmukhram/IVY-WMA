/**
 * The LINE area of the conversations view: a small toolbar (hidden chats, blocked contacts, LINE
 * settings), two slide-over sheets for the hidden and blocked lists, and a standalone settings
 * sheet that shows the user's own LINE profile, the full contacts list (All / Blocked), the hidden
 * chats and the stored LINE settings. It reads only, and carries the LINE-green accent from the
 * open conversation (it renders inside `.panes.conv-line`).
 *
 * Shapes it reads, each used when present and with an empty state when a route 404s or returns
 * nothing:
 *   GET /api/views/line/account  -> { account, profile:{ mid, displayName, userId, statusMessage, avatarUrl }, counts:{ contacts, hidden, blocked, settings } }
 *   GET /api/views/line/contacts?filter=all|blocked -> [{ mid, displayName, status, type, settings, blocked, statusMessage, avatarUrl }]
 *   GET /api/views/line/hidden   -> [{ chatId, title, avatarUrl, lastAt }]
 *   GET /api/views/line/settings -> [{ key, value }]
 * Avatar bytes: /api/views/line/contacts/:mid/avatar and /api/views/line/profile/avatar.
 */
import { useState } from "react";
import { ApiError } from "../api.ts";
import { useApi, useLoad } from "../ctx.tsx";
import { friendlyTime } from "../format.ts";
import { Avatar } from "../components/Avatar.tsx";
import { AppIcon } from "../components/AppIcon.tsx";
import { Icon } from "../components/Icon.tsx";
import { Segmented } from "../components/Controls.tsx";
import { Badge, Empty, ErrorLine } from "../components/Feedback.tsx";
import { Sheet, SlideOver } from "../components/Overlay.tsx";

export interface LineProfile { mid?: string; displayName?: string | null; userId?: string | null; statusMessage?: string | null; avatarUrl?: string | null }
export interface LineCounts { contacts?: number; hidden?: number; blocked?: number; settings?: number }
export interface LineAccount { account?: string; profile?: LineProfile; counts?: LineCounts }
export interface LineContact { mid: string; displayName?: string | null; status?: string | null; type?: string | null; settings?: unknown; blocked?: boolean; statusMessage?: string | null; avatarUrl?: string | null }
export interface LineHidden { chatId: string; title?: string | null; avatarUrl?: string | null; lastAt?: string | null }
export interface LineSetting { key: string; value: unknown }
export type ContactFilter = "all" | "blocked";

/** A missing route (404) reads as an empty area, not an error; anything else still surfaces. */
const emptyOn404 = <T,>(fallback: T) => (e: unknown): T => {
  if (e instanceof ApiError && e.status === 404) return fallback;
  throw e;
};

const contactName = (c: LineContact) => c.displayName?.trim() || c.mid;
/** The status a contact has set, shown raw when present (no relabeling). */
const contactStatus = (c: LineContact) => (c.statusMessage?.trim() || c.status?.trim() || "");
const contactAvatar = (c: LineContact) => c.avatarUrl ?? `/api/views/line/contacts/${encodeURIComponent(c.mid)}/avatar`;
const hiddenTitle = (h: LineHidden) => h.title?.trim() || h.chatId;
const settingValue = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** The account summary; only fetched while the open source is LINE. Counts drive the toolbar badges. */
export function useLineAccount(active: boolean) {
  return useLoad<LineAccount | null>(
    (a) => (active ? a.get("/api/views/line/account").catch(emptyOn404(null)) : Promise.resolve(null)),
    [active],
  );
}

function CountPill({ n }: { n: number | undefined }) {
  if (typeof n !== "number") return null;
  return <span className="lt-count" aria-hidden="true">{n}</span>;
}

/** The LINE toolbar: hidden chats, blocked contacts and the settings entry. Real buttons, focusable. */
export function LineToolbar({ counts, onHidden, onBlocked, onSettings }: {
  counts?: LineCounts; onHidden: () => void; onBlocked: () => void; onSettings: () => void;
}) {
  return (
    <div className="line-toolbar" role="group" aria-label="LINE">
      <button type="button" className="btn btn-sm" onClick={onHidden}
        aria-label={typeof counts?.hidden === "number" ? `Hidden chats (${counts.hidden})` : "Hidden chats"}>
        <Icon name="chat" size={13} />Hidden chats<CountPill n={counts?.hidden} />
      </button>
      <button type="button" className="btn btn-sm" onClick={onBlocked}
        aria-label={typeof counts?.blocked === "number" ? `Blocked contacts (${counts.blocked})` : "Blocked contacts"}>
        <Icon name="person" size={13} />Blocked contacts<CountPill n={counts?.blocked} />
      </button>
      <span className="spacer" />
      <button type="button" className="btn btn-sm" onClick={onSettings} aria-label="LINE settings">
        <Icon name="gear" size={13} />LINE settings
      </button>
    </div>
  );
}

function ContactRow({ c }: { c: LineContact }) {
  const name = contactName(c);
  const status = contactStatus(c);
  return (
    <div className="group-row line-contact" data-testid="line-contact">
      <Avatar name={name} size={30} colorKey={`line:${c.mid}`} src={contactAvatar(c)} />
      <div className="lc-main">
        <span className="lc-name" title={name}>{name}</span>
        {status && <span className="lc-status" title={status}>{status}</span>}
      </div>
      {c.blocked === true && <Badge>blocked</Badge>}
    </div>
  );
}

function HiddenRow({ h }: { h: LineHidden }) {
  const title = hiddenTitle(h);
  return (
    <div className="group-row line-contact" data-testid="line-hidden-row">
      <Avatar name={title} size={30} colorKey={`line:${h.chatId}`} src={h.avatarUrl ?? undefined} />
      <div className="lc-main">
        <span className="lc-name" title={title}>{title}</span>
        {h.lastAt && <span className="lc-status">Last message {friendlyTime(h.lastAt)}</span>}
      </div>
    </div>
  );
}

/** Slide-over list of hidden chats, with an honest empty state. */
export function HiddenChatsSheet({ onClose }: { onClose: () => void }) {
  const r = useLoad<LineHidden[]>((a) => a.get("/api/views/line/hidden").catch(emptyOn404([])), []);
  const items = r.data ?? [];
  return (
    <SlideOver title="Hidden chats" label="Hidden chats" onClose={onClose}>
      <div className="line-sheet-body">
        <ErrorLine error={r.error} />
        {r.data && items.length === 0 && (
          <Empty icon="chat" title="No hidden chats">No LINE chats are hidden. Hidden chats you have on LINE would appear here.</Empty>
        )}
        {items.length > 0 && <div className="group">{items.map((h) => <HiddenRow key={h.chatId} h={h} />)}</div>}
      </div>
    </SlideOver>
  );
}

/** Slide-over list of blocked contacts, with an honest empty state (often empty — that is correct). */
export function BlockedContactsSheet({ onClose }: { onClose: () => void }) {
  const r = useLoad<LineContact[]>((a) => a.get("/api/views/line/contacts", { filter: "blocked" }).catch(emptyOn404([])), []);
  const items = r.data ?? [];
  return (
    <SlideOver title="Blocked contacts" label="Blocked contacts" onClose={onClose}>
      <div className="line-sheet-body">
        <ErrorLine error={r.error} />
        {r.data && items.length === 0 && (
          <Empty icon="person" title="No blocked contacts">You have not blocked anyone on LINE.</Empty>
        )}
        {items.length > 0 && <div className="group">{items.map((c) => <ContactRow key={c.mid} c={c} />)}</div>}
      </div>
    </SlideOver>
  );
}

/** The standalone LINE settings area: own profile, contacts (All / Blocked), hidden chats, settings. */
export function LineSettingsSheet({ account, onClose }: { account: LineAccount | null; onClose: () => void }) {
  const [filter, setFilter] = useState<ContactFilter>("all");
  const contacts = useLoad<LineContact[]>((a) => a.get("/api/views/line/contacts", { filter }).catch(emptyOn404([])), [filter]);
  const hidden = useLoad<LineHidden[]>((a) => a.get("/api/views/line/hidden").catch(emptyOn404([])), []);
  const settings = useLoad<LineSetting[]>((a) => a.get("/api/views/line/settings").catch(emptyOn404([])), []);

  const profile = account?.profile;
  const name = profile?.displayName?.trim() || account?.account || "Your LINE";
  const profileAvatar = profile?.avatarUrl ?? "/api/views/line/profile/avatar";
  const contactList = contacts.data ?? [];
  const hiddenList = hidden.data ?? [];
  const settingList = settings.data ?? [];

  return (
    <Sheet title="LINE" label="LINE settings" onClose={onClose} wide>
      <div className="line-settings">
        <div className="line-prof">
          <Avatar name={name} size={64} colorKey={`line:${profile?.mid ?? "self"}`} src={profileAvatar} alt={`${name} avatar`} />
          <div className="lp-text">
            <span className="lp-name row" style={{ gap: 6 }}><AppIcon app="line" size={16} />{name}</span>
            {profile?.userId && <span className="lp-sub">{profile.userId}</span>}
            {profile?.statusMessage?.trim() && <span className="lp-status">{profile.statusMessage}</span>}
          </div>
        </div>

        <div>
          <h2 className="group-title">Account</h2>
          <div className="group">
            <div className="group-row"><span className="row-label">Account</span><span className="small faint ellipsis">{account?.account ?? "—"}</span></div>
            {profile?.mid && <div className="group-row"><span className="row-label">Member id</span><span className="small faint tnum ellipsis">{profile.mid}</span></div>}
            {profile?.userId && <div className="group-row"><span className="row-label">LINE ID</span><span className="small faint ellipsis">{profile.userId}</span></div>}
          </div>
        </div>

        <div>
          <div className="row" style={{ marginBottom: "var(--sp-2)" }}>
            <h2 className="group-title" style={{ margin: 0 }}>Contacts{typeof account?.counts?.contacts === "number" ? ` · ${account.counts.contacts}` : ""}</h2>
            <span className="spacer" />
            <Segmented label="Filter contacts" value={filter} onChange={setFilter} options={[["all", "All"], ["blocked", "Blocked"]]} />
          </div>
          <ErrorLine error={contacts.error} />
          <div className="group">
            {contacts.data && contactList.length === 0 && (
              <div className="group-row small muted">{filter === "blocked" ? "No blocked contacts" : "No contacts"}</div>
            )}
            {contactList.map((c) => <ContactRow key={c.mid} c={c} />)}
          </div>
        </div>

        <div>
          <h2 className="group-title">Hidden chats{typeof account?.counts?.hidden === "number" ? ` · ${account.counts.hidden}` : ""}</h2>
          <ErrorLine error={hidden.error} />
          <div className="group">
            {hidden.data && hiddenList.length === 0 && <div className="group-row small muted">No hidden chats</div>}
            {hiddenList.map((h) => <HiddenRow key={h.chatId} h={h} />)}
          </div>
        </div>

        <div>
          <h2 className="group-title">LINE settings{typeof account?.counts?.settings === "number" ? ` · ${account.counts.settings}` : ""}</h2>
          <ErrorLine error={settings.error} />
          <div className="group">
            {settings.data && settingList.length === 0 && <div className="group-row small muted">No settings recorded</div>}
            {settingList.map((s) => (
              <div key={s.key} className="group-row" data-testid="line-setting">
                <span className="row-label ellipsis" title={s.key}>{s.key}</span>
                <span className="small faint ellipsis" title={settingValue(s.value)}>{settingValue(s.value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
