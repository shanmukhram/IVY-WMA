import { useEffect, useState } from "react";

export interface Loc { path: string; query: URLSearchParams }
const read = (): Loc => ({ path: location.pathname, query: new URLSearchParams(location.search) });

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to); else history.pushState(null, "", to);
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
