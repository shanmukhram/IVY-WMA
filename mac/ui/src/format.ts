/** Formatting helpers: times (original vs capture, T4), sizes, ids, labels. */

const p2 = (n: number) => String(n).padStart(2, "0");

export function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2026-10-09 14:03:22" in local time (stable, sortable; used for hover text and fingerprints of time). */
export function fmtTime(iso: string | null | undefined, withDate = true): string {
  const d = parse(iso);
  if (!d) return iso ? iso : "—";
  const t = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return withDate ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${t}` : t;
}

export const hm = (iso: string | null | undefined): string => { const d = parse(iso); return d ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : "—"; };

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export const dayKey = (iso: string | null | undefined): string => { const d = parse(iso); return d ? localDate(d) : "unknown"; };

/** "Thursday, 24 September 2026" */
export function longDate(dateOrIso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateOrIso) ? new Date(`${dateOrIso}T12:00:00`) : parse(dateOrIso);
  if (!d) return dateOrIso;
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** "Today", "Yesterday", "Thu 24 Sep", "24 Sep 2025" */
export function dayLabel(dateOrIso: string, now = new Date()): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateOrIso) ? new Date(`${dateOrIso}T12:00:00`) : parse(dateOrIso);
  if (!d) return dateOrIso;
  const k = localDate(d), today = localDate(now);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (k === today) return "Today";
  if (k === localDate(y)) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** Short time for list rows: "14:03" today, "Yesterday", "Thu", "24/09/25". */
export function shortWhen(iso: string | null | undefined, now = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  const k = localDate(d), today = localDate(now);
  if (k === today) return hm(iso);
  const days = (now.getTime() - d.getTime()) / 86400_000;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (k === localDate(y)) return "Yesterday";
  if (days < 7 && days > 0) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "2-digit" });
}

/** "3 min ago", "2 h ago", "4 d ago" */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const d = parse(iso);
  if (!d) return "never";
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

export const TYPE_LABEL: Record<string, string> = {
  message: "Message", notification: "Notification", screenshot: "Screenshot", photo: "Photo", file: "File", usage: "App usage", call: "Call",
  browsing: "Google activity",
};
export const TYPE_PLURAL: Record<string, string> = {
  message: "Messages", notification: "Notifications", screenshot: "Screenshots", photo: "Photos", file: "Files", usage: "App usage", call: "Calls",
  browsing: "Google activity",
};

export const PLATFORM_LABEL: Record<string, string> = {
  telegram: "Telegram", line: "LINE", whatsapp: "WhatsApp", sms: "SMS", instagram: "Instagram", snapchat: "Snapchat",
};
export const ROLE_LABEL: Record<string, string> = { windows: "Windows", android: "Android" };
export const platformLabel = (p: string | null | undefined) => (p ? PLATFORM_LABEL[p.toLowerCase()] ?? p : "");
export const roleLabel = (r: string | null | undefined) => (r ? ROLE_LABEL[r] ?? r : "");

/** "windows:telegram-desktop" -> "Windows · Telegram Desktop" */
export function sourceLabel(source: string): string {
  const [role, col] = source.split(":");
  const nice = (col ?? "").replace(/[-_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bLine\b/, "LINE").replace(/\bDb\b/, "database");
  return `${roleLabel(role)} · ${nice}`;
}

export const COVERAGE_LABEL: Record<string, string> = { complete: "Complete", partial: "Partial", notification_only: "Notification-only" };

/** "Today 09:12", "Yesterday 18:02", "Thu 8 Oct 09:00", "8 Oct 2025 09:00" */
export function friendlyTime(iso: string | null | undefined, now = new Date()): string {
  const d = parse(iso);
  if (!d) return iso ? iso : "—";
  return `${dayLabel(localDate(d), now)} ${hm(iso)}`;
}

/** "telegram-desktop" -> "Telegram Desktop", "line-desktop" -> "LINE Desktop", "root-db" -> "Root database" */
export function collectorLabel(name: string): string {
  const s = name.replace(/[-_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return s.replace(/\bLine\b/, "LINE").replace(/\bDb\b/, "Database").replace(/\bSms\b/, "SMS");
}
