/**
 * The dashboard's device scope: one setting for the whole app that narrows every data view to one paired
 * device or to every device of a role. It lives in the URL as device=<id|windows|android>, so links,
 * reloads and the back button keep it; navigate() and <Link> carry it from page to page (router.ts
 * withScope), and setScope / useScope().set change it. Views with a device dimension pass it to their API
 * calls as `device` (the service gives it one meaning everywhere); pages without one (Devices, Settings,
 * Recovery bin, Ask AI) ignore it but still show the chip. No value means every device, as before.
 */
import { useContext } from "react";
import { SCOPE_PARAM, navigate, useLocation } from "./router.ts";
import { DevicesContext, type DeviceLite } from "./views/records.tsx";
import { DEVICE_SOURCES, ROLES, type Role } from "./nav.ts";
import { roleLabel, shortId } from "./format.ts";
import { Icon } from "./components/Icon.tsx";

export const isRole = (v: string | null | undefined): v is Role => v === "windows" || v === "android";

/** A device's display name: its name when it has one, else its fingerprint. */
export function deviceLabel(d: Pick<DeviceLite, "id" | "fingerprint" | "name">): string {
  return d.name?.trim() || d.fingerprint || shortId(d.id);
}

/** The role a scope belongs to: the role itself, or the paired device's role (null when unknown). */
export function scopeRole(scope: string | null, devices?: DeviceLite[]): Role | null {
  if (!scope) return null;
  if (isRole(scope)) return scope;
  const r = devices?.find((d) => d.id === scope)?.role;
  return isRole(r) ? r : null;
}

/** "Windows (all devices)" or "Windows · <device name>". */
export function scopeLabel(scope: string, devices?: DeviceLite[]): string {
  if (isRole(scope)) return `${roleLabel(scope)} (all devices)`;
  const d = devices?.find((x) => x.id === scope);
  return d ? `${roleLabel(d.role)} · ${deviceLabel(d)}` : `device ${shortId(scope)} (not paired)`;
}

/** Pages with no device dimension. */
const UNSCOPED = ["/devices", "/settings", "/bin", "/ai"];
const under = (path: string, p: string) => path === p || path.startsWith(p + "/");
export const ignoresScope = (path: string) => UNSCOPED.some((p) => under(path, p));

/** Where a per-device source goes when the scope is cleared: the same kind of records for every device. */
const GLOBAL_OF: Record<string, string> = {
  files: "/files", screenshots: "/media?kind=screenshot", media: "/media", notifications: "/notifications",
  telegram: "/conversations", line: "/conversations", whatsapp: "/conversations", sms: "/conversations",
};

/**
 * The URL that shows the current page under another scope. Paging and an open item (chat, focus) are
 * dropped because they may not exist in the new scope. Devices, Settings and the Recovery bin have no
 * device dimension, so choosing a device there opens Search. A per-device page moves to the new device's
 * role; clearing the scope there opens the matching all-device page.
 */
export function scopedUrl(next: string | null, path: string, query: URLSearchParams, devices?: DeviceLite[]): string {
  const q = new URLSearchParams(query);
  for (const k of ["page", "chat", "around", "focus", "c"]) q.delete(k);
  let p = path;
  if (next === null) {
    q.delete(SCOPE_PARAM);
    if (p.startsWith("/device/")) return GLOBAL_OF[p.split("/")[3] ?? ""] ?? "/";
  } else {
    q.set(SCOPE_PARAM, next);
    if (["/devices", "/settings", "/bin"].some((x) => under(p, x))) return `/?${new URLSearchParams({ [SCOPE_PARAM]: next }).toString()}`;
    if (p.startsWith("/device/")) {
      const [, , cur, key] = p.split("/");
      const role = scopeRole(next, devices);
      if (role && role !== cur) p = key && DEVICE_SOURCES[role].some((s) => s.key === key) ? `/device/${role}/${key}` : `/device/${role}`;
    }
  }
  const s = q.toString();
  return s ? `${p}?${s}` : p;
}

export function useScope(): { scope: string | null; devices: DeviceLite[] | undefined; set: (next: string | null) => void } {
  const { query } = useLocation();
  const devices = useContext(DevicesContext);
  const scope = query.get(SCOPE_PARAM) || null;
  const set = (next: string | null) => navigate(scopedUrl(next, location.pathname, new URLSearchParams(location.search), devices), false, false);
  return { scope, devices, set };
}

/** The chip at the top of the main pane while a scope is set, with the control that clears it. */
export function ScopeBar() {
  const { path } = useLocation();
  const { scope, devices, set } = useScope();
  if (!scope) return null;
  const role = scopeRole(scope, devices);
  return (
    <div className="scope-bar" role="region" aria-label="Device scope">
      <span className="chip scope-chip" data-testid="scope-chip"><Icon name={role === "android" ? "phone" : role === "windows" ? "laptop" : "link"} size={13} />Showing: {scopeLabel(scope, devices)}</span>
      <button type="button" className="btn btn-plain btn-sm" onClick={() => set(null)}>Show all devices</button>
      {ignoresScope(path) && <span className="small faint">This page is the same for every device.</span>}
    </div>
  );
}

/** The device picker in a view's filter bar: the same scope as the sidebar and the chip. */
export function ScopeSelect({ className = "select" }: { className?: string }) {
  const { scope, devices, set } = useScope();
  const list = devices ?? [];
  return (
    <select className={className} aria-label="Device" value={scope ?? ""} onChange={(e) => set(e.target.value || null)}>
      <option value="">All devices</option>
      {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)} (all devices)</option>)}
      {list.map((d) => <option key={d.id} value={d.id}>{roleLabel(d.role)} · {deviceLabel(d)}</option>)}
      {scope && !isRole(scope) && !list.some((d) => d.id === scope) && <option value={scope}>{scopeLabel(scope, devices)}</option>}
    </select>
  );
}
