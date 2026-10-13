import { useEffect, useState } from "react";

export interface Loc { path: string; query: URLSearchParams }
const read = (): Loc => ({ path: location.pathname, query: new URLSearchParams(location.search) });

/** The URL query key that holds the dashboard's device scope (see scope.tsx). */
export const SCOPE_PARAM = "device";

/**
 * An in-app URL with the current device scope carried over: when the current URL has device=<x> and `to`
 * names no device of its own, device=<x> is added, so every link and navigation keeps the scope.
 */
export function withScope(to: string): string {
  if (!to.startsWith("/")) return to;
  const cur = new URLSearchParams(location.search).get(SCOPE_PARAM);
  if (!cur) return to;
  const hashAt = to.indexOf("#");
  const hash = hashAt >= 0 ? to.slice(hashAt) : "";
  const base = hashAt >= 0 ? to.slice(0, hashAt) : to;
  const qAt = base.indexOf("?");
  const path = qAt >= 0 ? base.slice(0, qAt) : base;
  const q = new URLSearchParams(qAt >= 0 ? base.slice(qAt + 1) : "");
  if (q.has(SCOPE_PARAM)) return to;
  q.set(SCOPE_PARAM, cur);
  return `${path}?${q.toString()}${hash}`;
}

/** Go to an in-app URL. The device scope is kept unless `keepScope` is false (then `to` is used as is). */
export function navigate(to: string, replace = false, keepScope = true): void {
  const url = keepScope ? withScope(to) : to;
  if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
  window.dispatchEvent(new Event("ivy:navigate"));
}

export function useLocation(): Loc {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener("popstate", on);
    window.addEventListener("ivy:navigate", on);
    return () => { window.removeEventListener("popstate", on); window.removeEventListener("ivy:navigate", on); };
  }, []);
  return loc;
}

/** Build "/path?a=b" dropping empty values. */
export function href(path: string, q: Record<string, string | number | undefined | null> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}
