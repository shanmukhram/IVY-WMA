/** Light / dark: follows the system (prefers-color-scheme) unless overridden here. Per-viewer, so localStorage. */
export type ThemeChoice = "system" | "light" | "dark";
const KEY = "ivy.theme";

export function getTheme(): ThemeChoice {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}

export function applyTheme(t: ThemeChoice = getTheme()): void {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", t);
}

export function setTheme(t: ThemeChoice): void {
  try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* per-viewer convenience only */ }
  applyTheme(t);
  window.dispatchEvent(new Event("ivy:theme"));
}
