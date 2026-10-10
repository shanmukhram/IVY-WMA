/**
 * Timestamps are stored as UTC ISO-8601 with milliseconds (`2026-10-10T12:00:00.000Z`),
 * the exact form the Windows app sends (IvyTime.Format), so SQL string comparison
 * orders them correctly. Original event times and capture times stay in separate
 * columns (PRD T4); this only normalises the instant's notation.
 */
export function normTs(s: string | undefined | null): string | null {
  if (s === undefined || s === null || s === "") return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return s; // keep what the source said; never invent a time
  return new Date(ms).toISOString();
}

export const nowIso = (): string => new Date().toISOString();

export function msOf(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** Offset (minutes east of UTC) of an IANA zone at an instant. */
export function zoneOffsetMinutes(timeZone: string, atMs: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const name = fmt.formatToParts(new Date(atMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * [start, end) of a calendar day in a zone. `tz` is an IANA name or a signed
 * offset in minutes ("540", "-300"). Default: the Mac's zone.
 */
export function dayBounds(date: string, tz?: string): { start: string; end: string; tz: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error("date must be YYYY-MM-DD");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utcMidnight = Date.UTC(y, mo - 1, d);
  const zone = tz ?? localZone();
  const offsetAt = (ms: number) => (/^[+-]?\d+$/.test(zone) ? Number(zone) : zoneOffsetMinutes(zone, ms));
  // iterate once so a DST change near midnight resolves to the right offset
  let start = utcMidnight - offsetAt(utcMidnight) * 60_000;
  start = utcMidnight - offsetAt(start) * 60_000;
  const nextUtc = Date.UTC(y, mo - 1, d + 1);
  let end = nextUtc - offsetAt(nextUtc) * 60_000;
  end = nextUtc - offsetAt(end) * 60_000;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), tz: zone };
}

/** Accept YYYY-MM-DD (start of that UTC day) or any ISO timestamp. */
export function parseBound(s: string | undefined, endOfDay = false): string | undefined {
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(s + "T00:00:00.000Z") + (endOfDay ? 86_400_000 : 0);
    return new Date(ms).toISOString();
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`bad timestamp: ${s}`);
  return new Date(ms).toISOString();
}
