/** Avatar circle: a photo when the source gives one, else initials on a stable per-peer color. */
import { useState } from "react";

const COLORS = ["#ff6b5f", "#ff9f0a", "#e5b000", "#34c759", "#00b8a9", "#32ade6", "#007aff", "#5e5ce6", "#af52de", "#ff375f"];

export function hashColor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return COLORS[(h >>> 0) % COLORS.length]!;
}

export function initials(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!clean) return "#";
  const parts = clean.split(/\s+/);
  const a = [...parts[0]!][0] ?? "";
  const b = parts.length > 1 ? [...parts[parts.length - 1]!][0] ?? "" : [...parts[0]!][1] ?? "";
  return (a + (parts.length > 1 ? b : "")).toUpperCase() || "#";
}

/**
 * `src` is the peer/sender photo when the API serves one; it falls back to initials if it is
 * absent or fails to load. `alt` makes the avatar meaningful to screen readers (header, profile);
 * omit it for the decorative avatars that sit beside names already in the text.
 */
export function Avatar({ name, size = 36, colorKey, src, alt }: { name: string; size?: number; colorKey?: string; src?: string | null; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const showImg = !!src && !failed;
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (showImg) {
    return (
      <img className="avatar" style={{ ...style, objectFit: "cover" }} src={src!} alt={alt ?? ""} aria-hidden={alt ? undefined : true}
        draggable={false} onError={() => setFailed(true)} />
    );
  }
  return (
    <span className="avatar" aria-hidden={alt ? undefined : true} role={alt ? "img" : undefined} aria-label={alt} data-initials={initials(name)}
      style={{ ...style, background: hashColor(colorKey ?? name) }}>
      {initials(name)}
    </span>
  );
}
