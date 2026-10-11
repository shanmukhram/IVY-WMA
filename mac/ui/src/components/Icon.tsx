/** Hand-drawn line icons in the SF Symbols spirit: 16px grid, 1.6 stroke, currentColor. */
const P: Record<string, string> = {
  search: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5",
  timeline: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 4.5V8l2.5 1.6",
  sparkles: "M7 2l1.2 3.3L11.5 6.5 8.2 7.7 7 11 5.8 7.7 2.5 6.5l3.3-1.2zM12.5 10l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z",
  photo: "M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM1.5 10.5l3.5-3 3 2.5 2-1.5 4.5 3.5M10.5 6.5a.5.5 0 1 0 0-.01",
  screenshot: "M2 5V3a1 1 0 0 1 1-1h2M11 2h2a1 1 0 0 1 1 1v2M14 11v2a1 1 0 0 1-1 1h-2M5 14H3a1 1 0 0 1-1-1v-2M5.5 6h5v4h-5z",
  doc: "M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5zM9 1.5V5h3.5M5.5 8.5h5M5.5 11h5",
  folder: "M1.8 4a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .7.3l1.1 1.1h5.5a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z",
  bell: "M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8zM6.5 14a1.6 1.6 0 0 0 3 0",
  chat: "M2 3.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 2.5v-2.5H3a1 1 0 0 1-1-1z",
  laptop: "M3 3.5h10a.5.5 0 0 1 .5.5v6.5h-11V4a.5.5 0 0 1 .5-.5zM1 12.5h14",
  phone: "M5 1.5h6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM7 12.5h2",
  pulse: "M1 8.5h3l1.5-4 3 8 2-5.5 1 1.5H15",
  link: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5l-1.2 1.2a2.8 2.8 0 0 1-4-4L5 7.5",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.8 6.5v5M9.2 6.5v5",
  gear: "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  chevronDown: "M4 6l4 4 4-4",
  chevronLeft: "M10 3L5 8l5 5",
  chevronRight: "M6 3l5 5-5 5",
  lock: "M4 7h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM5.5 7V5a2.5 2.5 0 0 1 5 0v2",
  sync: "M13.5 6.5A5.5 5.5 0 0 0 3.3 4.7M2.5 9.5a5.5 5.5 0 0 0 10.2 1.8M3 2v3h3M13 14v-3h-3",
  activity: "M2 4h12M2 8h8M2 12h10",
  plus: "M8 3v10M3 8h10",
  close: "M4 4l8 8M12 4l-8 8",
  check: "M3 8.5l3.2 3L13 4.5",
  calendar: "M3 3h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM2 6.5h12M5 1.5v3M11 1.5v3",
  info: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7.2v4M8 4.8v.1",
  warn: "M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.1",
  arrowUp: "M8 13V3M3.5 7.5L8 3l4.5 4.5",
  download: "M8 2v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11",
  external: "M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7",
  restore: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3",
  usage: "M2.5 13.5V9M6.2 13.5V5M9.8 13.5V7.5M13.5 13.5V2.5",
  call: "M5.5 2.5l1.5 3-1.6 1.2a8 8 0 0 0 3.9 3.9L10.5 9l3 1.5v2.2a1 1 0 0 1-1.1 1A11 11 0 0 1 2.3 3.6a1 1 0 0 1 1-1.1z",
  globe: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM1.8 8h12.4M8 1.8c2 2 2 10.4 0 12.4M8 1.8c-2 2-2 10.4 0 12.4",
  key: "M10 2.5a3.5 3.5 0 1 1-3.2 4.9L2.5 11.7v1.8h1.8v-1.2h1.2v-1.2h1.2l1.4-1.4A3.5 3.5 0 1 1 10 2.5zM10.8 5.2v.1",
  cloud: "M4.5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 11.8 6a3.2 3.2 0 0 1 .2 6.5z",
  appearance: "M8 1.8a6.2 6.2 0 1 0 0 12.4zM8 1.8a6.2 6.2 0 0 1 0 12.4",
  inbox: "M2 9.5l1.8-6h8.4l1.8 6v3.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5zM2 9.5h3.5l1 1.5h3l1-1.5H14",
  hourglass: "M4 1.5h8M4 14.5h8M5 1.5c0 4 6 4 6 6.5S5 10.5 5 14.5M11 1.5c0 4-6 4-6 6.5s6 2.5 6 6.5",
  select: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM5.2 8.2l2 1.8 3.6-4",
  paperclip: "M11.5 7.5l-4.6 4.6a2.6 2.6 0 0 1-3.7-3.7l5.2-5.2a1.7 1.7 0 0 1 2.5 2.5L5.8 10.8a.8.8 0 0 1-1.2-1.2l4.6-4.6",
  forward: "M9 3.5L13.5 8 9 12.5M13.5 8H6a3.5 3.5 0 0 0-3.5 3.5v1",
  reply: "M7 3.5L2.5 8 7 12.5M2.5 8H10a3.5 3.5 0 0 1 3.5 3.5v1",
  person: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14.5a5.5 5.5 0 0 1 11 0",
  shield: "M8 1.5l5.5 2v4.2c0 3.3-2.3 5.8-5.5 6.8-3.2-1-5.5-3.5-5.5-6.8V3.5z",
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, className, label }: { name: IconName | string; size?: number; className?: string; label?: string }) {
  const d = P[name] ?? P.info!;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label} focusable="false">
      <path d={d} />
    </svg>
  );
}

/** Record type -> icon and tint class (shared by search cards, the timeline and record sheets). */
export const TYPE_ICON: Record<string, IconName> = {
  message: "chat", notification: "bell", screenshot: "screenshot", photo: "photo", file: "doc", usage: "usage", call: "call", browsing: "globe",
};
