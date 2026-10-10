/**
 * App and source icons: recognisable brand marks from `simple-icons` (CC0) rendered inline as SVG,
 * in the brand colour, inside the icon only. Unknown apps get an initials tile with a stable colour.
 * Sizes: 16 in lists and chips, 20 in headers, 32 in cards.
 */
import {
  siGmail, siGoogle, siGooglechrome, siGooglemaps, siGoogleplay, siInstagram, siLine, siSnapchat, siTelegram, siWhatsapp, siYoutube,
  type SimpleIcon,
} from "simple-icons";
import { hashColor, initials } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";

const ICONS: Record<string, SimpleIcon> = {
  telegram: siTelegram, line: siLine, whatsapp: siWhatsapp, instagram: siInstagram, snapchat: siSnapchat,
  google: siGoogle, googlemaps: siGooglemaps, youtube: siYoutube, googleplay: siGoogleplay, gmail: siGmail, chrome: siGooglechrome,
};

/** Normalised identifiers (platform ids, Windows app names, Android packages, Google products) -> icon key. */
const ALIASES: Record<string, string> = {
  telegram: "telegram", telegramdesktop: "telegram", orgtelegrammessenger: "telegram", orgthunderdogchallegram: "telegram",
  line: "line", linedesktop: "line", jpnaverlineandroid: "line",
  whatsapp: "whatsapp", whatsappdesktop: "whatsapp", whatsappbusiness: "whatsapp", comwhatsapp: "whatsapp", comwhatsappw4b: "whatsapp",
  instagram: "instagram", cominstagramandroid: "instagram",
  snapchat: "snapchat", comsnapchatandroid: "snapchat",
  google: "google", search: "google", googlesearch: "google", discover: "google", googleapp: "google", assistant: "google", comgoogleandroidgooglequicksearchbox: "google",
  maps: "googlemaps", googlemaps: "googlemaps", comgoogleandroidappsmaps: "googlemaps",
  youtube: "youtube", youtubemusic: "youtube", comgoogleandroidyoutube: "youtube",
  play: "googleplay", playstore: "googleplay", googleplay: "googleplay", googleplaystore: "googleplay", comandroidvending: "googleplay",
  gmail: "gmail", comgoogleandroidgm: "gmail",
  chrome: "chrome", googlechrome: "chrome", comandroidchrome: "chrome",
};

export const normaliseApp = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The brand icon for an app or platform identifier, or null when there is none (fallback tile). */
export function brandFor(id: string | null | undefined): SimpleIcon | null {
  if (!id) return null;
  const n = normaliseApp(id);
  const key = ALIASES[n] ?? (n.startsWith("google") ? ALIASES[n.slice(6)] : undefined);
  return key ? ICONS[key] ?? null : null;
}

function luminance(hex: string): number {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** Decorative by default (the app name is always written next to it); pass `label` when it stands alone. */
export function AppIcon({ app, size = 16, label }: { app: string | null | undefined; size?: number; label?: string }) {
  const icon = brandFor(app);
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  if (!icon) {
    const text = initials(app || "?").slice(0, 2);
    return (
      <span className="app-icon app-icon-fallback" {...a11y} data-app-icon="fallback" data-initials={text} title={app ?? undefined}
        style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.42)), borderRadius: Math.round(size * 0.24), background: hashColor(normaliseApp(app || "?")) }}
      />
    );
  }
  const lum = luminance(icon.hex);
  // very light marks (Snapchat yellow) sit on their own colour as a tile; near-black marks follow the label colour
  if (lum > 0.6) {
    return (
      <span className="app-icon app-icon-tile" {...a11y} data-app-icon={normaliseApp(icon.title)}
        style={{ width: size, height: size, borderRadius: Math.round(size * 0.24), background: `#${icon.hex}` }}>
        <svg viewBox="0 0 24 24" width={size * 0.7} height={size * 0.7} aria-hidden="true" focusable="false"><path d={icon.path} fill="#000" /></svg>
      </span>
    );
  }
  const fill = lum < 0.04 ? "var(--label)" : `#${icon.hex}`;
  return (
    <svg className="app-icon" viewBox="0 0 24 24" width={size} height={size} {...a11y} data-app-icon={normaliseApp(icon.title)} focusable="false">
      <path d={icon.path} fill={fill} />
    </svg>
  );
}

const COLLECTOR_GLYPH: Record<string, string> = {
  files: "doc", screenshots: "screenshot", usage: "usage", notifications: "bell", calls: "call", photos: "photo", media: "photo", messages: "chat",
};

/** A 32 px card icon for a collector or source: its brand when it has one, else a neutral tile with the type glyph. */
export function SourceTile({ name, glyph }: { name: string; glyph?: string }) {
  if (brandFor(name)) return <span className="icon-tile plain"><AppIcon app={name} size={32} /></span>;
  return <span className="icon-tile" aria-hidden="true"><Icon name={glyph ?? COLLECTOR_GLYPH[name] ?? "pulse"} size={16} /></span>;
}
