/** Console formatting: one-line summaries and the coverage table. */
import type { DeviceReportRecordT } from "@ivy/protocol";

export function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / 1024 / 1024).toFixed(1)}MiB`;
}

export function compactJson(v: unknown, max = 600): string {
  const s = JSON.stringify(v);
  return s.length <= max ? s : `${s.slice(0, max)}... (${s.length} chars)`;
}

function table(header: string[], rows: string[][], indent = "  "): string[] {
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => indent + r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join("  ");
  return [line(header), ...rows.map(line)];
}

export function coverageTable(r: DeviceReportRecordT): string[] {
  const rows = r.collectors.map((c) => [
    c.name, c.enabled ? "yes" : "no", c.lastRunAt ?? "never", c.cursor ?? "-", String(c.queueDepth),
  ]);
  if (rows.length === 0) return ["  (no collectors reported)"];
  return table(["collector", "enabled", "lastRun", "cursor", "queueDepth"], rows);
}

export { table };
