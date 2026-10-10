/** Avatar circle with initials; the color is stable per name (same peer, same color everywhere). */
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

export function Avatar({ name, size = 36, colorKey }: { name: string; size?: number; colorKey?: string }) {
  return (
    <span className="avatar" aria-hidden="true" data-initials={initials(name)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: hashColor(colorKey ?? name) }}>
      {initials(name)}
    </span>
  );
}
