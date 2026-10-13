/** macOS-style source list: sections, collapsible groups, selection highlight, footer actions. */
import { useContext, useEffect, useState, type ReactNode } from "react";
import { useDebounced, useEvents, useLoad } from "../ctx.tsx";
import { href, useLocation } from "../router.ts";
import { DEVICE_SOURCES, ROLES, type Role } from "../nav.ts";
import { ago, platformLabel, roleLabel } from "../format.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Link } from "./Controls.tsx";
import { Dot } from "./Feedback.tsx";
import { AppIcon } from "./AppIcon.tsx";
import { DevicesContext } from "../views/records.tsx";
import { deviceLabel, scopedUrl } from "../scope.tsx";
import { SCOPE_PARAM } from "../router.ts";

export interface ChatSource { source: string; role: string; collector: string; platform: string; conversations: number; messages: number; lastMessageAt: string | null }

const readOpen = (k: string, dflt: boolean) => { try { const v = localStorage.getItem(`ivy.nav.${k}`); return v === null ? dflt : v === "1"; } catch { return dflt; } };
const writeOpen = (k: string, v: boolean) => { try { localStorage.setItem(`ivy.nav.${k}`, v ? "1" : "0"); } catch { /* per-viewer only */ } };

/** Sidebar label of a conversation source: "Telegram · Windows", "LINE · Android (notifications)". */
export function chatSourceLabel(s: Pick<ChatSource, "platform" | "role" | "collector">): string {
  return `${platformLabel(s.platform)} · ${roleLabel(s.role)}${s.collector === "notification" ? " (notifications)" : ""}`;
}
export const chatSourceHref = (s: Pick<ChatSource, "source" | "platform">) => href("/conversations", { source: s.source, platform: s.platform });

function Group({ id, title, defaultOpen, forceOpen, children }: { id: string; title: string; defaultOpen: boolean; forceOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const toggle = () => setOpen((v) => { writeOpen(id, !v); return !v; });
  return (
    <div className="nav-section">
      <button className="nav-heading" aria-expanded={open} aria-controls={`nav-${id}`} onClick={toggle}>
        {title}<Icon name="chevronDown" size={12} className="chev" />
      </button>
      {open && <div id={`nav-${id}`} role="group" aria-label={title}>{children}</div>}
    </div>
  );
}

function Item({ to, icon, app, label, current, sub, aria, trailing, describedBy }: { to: string; icon: IconName; app?: string; label: string; current: boolean; sub?: boolean; aria?: string; trailing?: ReactNode; describedBy?: string }) {
  return (
    <Link to={to} className={`nav-item${sub ? " sub" : ""}`} aria-current={current ? "page" : undefined} aria-label={aria ?? label} aria-describedby={describedBy}>
      {app ? <AppIcon app={app} size={16} /> : <Icon name={icon} size={16} />}<span className="ellipsis" title={label}>{label}</span>{trailing}
    </Link>
  );
}

export function Sidebar({ footer }: { footer: ReactNode }) {
  const { path, query } = useLocation();
  const paired = useContext(DevicesContext) ?? [];
  const scope = query.get(SCOPE_PARAM) || undefined;
  // the chat-source counts follow the device scope; coverage stays whole so every device keeps its status dot
  const sources = useLoad<{ sources: ChatSource[] }>((a) => a.get("/api/views/sources", { device: scope }), [scope]);
  const cov = useLoad<any>((a) => a.get("/api/coverage"), []);
  const reload = useDebounced(() => { sources.reload(); cov.reload(); }, 3000);
  useEvents(() => reload(), ["ingest.committed", "coverage.changed", "pairing.completed", "device.revoked", "device.forgotten"]);

  const is = (p: string) => path === p;
  const starts = (p: string) => path === p || path.startsWith(p + "/");
  const srcList = sources.data?.sources ?? [];
  const devStatus = (role: Role): string | null => {
    const devs = ((cov.data?.devices ?? []) as Array<{ role: string; status: string }>).filter((d) => d.role === role);
    return devs.length ? devs[0]!.status : null;
  };
  const statusOf = (id: string): string | null =>
    ((cov.data?.devices ?? []) as Array<{ deviceId: string; status: string }>).find((d) => d.deviceId === id)?.status ?? null;

  return (
    <nav className="sidebar" aria-label="Sidebar">
      <div className="sidebar-brand"><span className="brand-mark"><Icon name="shield" size={13} /></span>IVY</div>
      <div className="sidebar-nav">
        <div className="nav-section">
          <Item to="/" icon="search" label="Search" current={is("/") || is("/search")} />
          <Item to="/timeline" icon="timeline" label="Timeline" current={starts("/timeline")} />
          <Item to="/ai" icon="sparkles" label="Ask AI" current={starts("/ai")} />
        </div>

        <Group id="library" title="Library" defaultOpen>
          <Item to="/media" icon="photo" label="Media" current={starts("/media")} />
          <Item to="/files" icon="doc" label="Files" current={starts("/files")} />
          <Item to="/notifications" icon="bell" label="Notifications" current={starts("/notifications")} />
        </Group>

        <Group id="conversations" title="Conversations" defaultOpen forceOpen={starts("/conversations")}>
          <Item to="/conversations" icon="chat" label="All chats" current={is("/conversations") && !query.get("source")} />
          {srcList.map((s) => (
            <Item key={`${s.source}|${s.platform}`} to={chatSourceHref(s)} icon="chat" app={s.platform} sub label={chatSourceLabel(s)}
              current={is("/conversations") && query.get("source") === s.source && (query.get("platform") ?? "") === s.platform}
              trailing={<span className="nav-count">{s.conversations}</span>} />
          ))}
          {sources.data && srcList.length === 0 && <p className="nav-empty">No chat sources yet</p>}
        </Group>

        {ROLES.map((role) => {
          const st = devStatus(role);
          return (
            <Group key={role} id={role} title={roleLabel(role)} defaultOpen={false} forceOpen={starts(`/device/${role}`)}>
              <Item to={href(`/device/${role}`, { [SCOPE_PARAM]: role })} icon={role === "windows" ? "laptop" : "phone"} label="Overview" aria={`${roleLabel(role)} overview`}
                current={is(`/device/${role}`)} trailing={st ? <span className="nav-dot"><Dot s={st} label={`${role} ${st}`} /></span> : <span className="nav-count">not paired</span>} />
              {paired.filter((d) => d.role === role).map((d) => {
                const label = deviceLabel(d);
                const ds = statusOf(d.id);
                // choosing a device sets the scope and stays on the current view (Search from Devices or Settings)
                return (
                  <Item key={d.id} to={scopedUrl(d.id, path, query, paired)} icon={role === "windows" ? "laptop" : "phone"} label={label} aria={`${roleLabel(role)} device ${label}`}
                    current={scope === d.id} trailing={ds ? <span className="nav-dot"><Dot s={ds} label={`${label} ${ds}`} /></span> : <span className="nav-count">no report</span>} />
                );
              })}
              {DEVICE_SOURCES[role].map((s) => (
                <Item key={s.key} sub to={`/device/${role}/${s.key}`} icon={s.icon} app={s.view.kind === "chats" ? s.view.platform : undefined} label={s.label} aria={`${roleLabel(role)} ${s.label}`} current={is(`/device/${role}/${s.key}`)} />
              ))}
            </Group>
          );
        })}

        <Group id="vault" title="Vault" defaultOpen>
          <Item to="/coverage" icon="pulse" label="Coverage" current={starts("/coverage")}
            describedBy={cov.data ? "nav-coverage-state" : undefined}
            trailing={cov.data?.problems?.length ? (
              <span className="nav-problems" id="nav-coverage-state" title={`${cov.data.problems.length} problem(s) need attention`}>
                <span aria-hidden="true">{cov.data.problems.length}</span><span className="sr-only">{cov.data.problems.length} problem(s) need attention</span>
                <Dot s={(cov.data.problems as Array<{ severity: string }>).some((p) => p.severity === "red") ? "red" : "amber"} label="" />
              </span>
            ) : cov.data ? <span className="nav-dot" id="nav-coverage-state"><span className="sr-only">no problems</span><Dot s="green" label="" /></span> : undefined} />
          <Item to="/devices" icon="link" label="Devices" current={starts("/devices")} />
          <Item to="/bin" icon="trash" label="Recovery bin" current={starts("/bin")} />
          <Item to="/settings" icon="gear" label="Settings" current={starts("/settings")} />
        </Group>
      </div>
      <div className="sidebar-foot">{footer}</div>
    </nav>
  );
}

export function LastSync({ at }: { at: string | null }) {
  return <span>{at ? `Last sync ${ago(at)}` : "Not synced yet"}</span>;
}
