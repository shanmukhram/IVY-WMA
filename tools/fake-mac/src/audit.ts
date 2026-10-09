/**
 * `audit`: the @ivy/audit zero-plaintext scan over all four mock buckets, with
 * markers harvested from what this fake Mac decrypted (ledger records and
 * received blobs). A pass means none of that plaintext is in the bucket in the
 * clear. received/ and ledger.json are Mac-side plaintext by design, so they are
 * marker sources, not scan targets.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runAudit, formatSummary } from "@ivy/audit";
import type { AuditReport } from "@ivy/audit";
import { paths, readLedger, requireState } from "./local.ts";
import { withEndpoint } from "./endpoint.ts";
import { ALL_BUCKETS } from "./serve.ts";
import { parseToken } from "./s3.ts";

const OID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SKIP_FIELDS = new Set(["v", "kind", "deviceId", "eventTime", "captureTime", "blobOid", "thumbBlobOid", "resultOid", "pairingId", "role"]);

function stringsOf(v: unknown, out: Set<string>, field?: string) {
  if (typeof v === "string") {
    if (field && SKIP_FIELDS.has(field)) return;
    // things that legitimately appear in object keys or are too generic to be evidence
    if (v.length < 6 || OID.test(v) || /^[0-9a-f]{32}$/.test(v) || /^\d{4}-\d\d-\d\dT/.test(v)) return;
    out.add(v);
  } else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, field);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) stringsOf(x, out, k);
}

/** Printable ASCII runs (>= 16 chars) from the start of a received file, as markers. */
function printableRuns(buf: Buffer, max = 5): string[] {
  const out: string[] = [];
  const s = buf.subarray(0, 1 << 20).toString("latin1");
  for (const m of s.matchAll(/[\x20-\x7e]{16,}/g)) { out.push(m[0].slice(0, 64)); if (out.length >= max) break; }
  return out;
}

export function harvestMarkers(root: string): string[] {
  const set = new Set<string>();
  for (const e of readLedger(root)) if (e.status === "committed" && e.record) stringsOf(e.record, set);
  const dir = paths(root).received;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isFile()) for (const r of printableRuns(readFileSync(p))) set.add(r);
    }
  }
  return [...set];
}

/**
 * A pending pairing bootstrap `pair/<id>` is, by spec (PROTOCOL §7), a sealed JSON
 * container `{v, nonce, ct}` with base64 fields, so it is printable by nature. Its
 * printable-run hits are dropped; marker and magic hits still count.
 */
export function exemptBootstrap(r: AuditReport): AuditReport {
  const items = r.items.map((i) =>
    /^ivy-cmd-[a-z]+\/pair\/[0-9a-f]+$/.test(i.name) ? { ...i, hits: i.hits.filter((h) => !h.rule.startsWith("printable-run")) } : i);
  const totalHits = items.reduce((n, i) => n + i.hits.length, 0);
  return { ...r, items, totalHits, pass: totalHits === 0 && r.errors.length === 0 && items.every((i) => !i.error) };
}

export async function auditRoot(root: string, extraMarkers: string[] = []): Promise<{ report: AuditReport; summary: string; markers: number; live: boolean }> {
  const state = requireState(root);
  const markers = [...new Set([...harvestMarkers(root), ...extraMarkers])];
  return withEndpoint(root, state, async (endpoint, live) => {
    const report = exemptBootstrap(await runAudit({ buckets: ALL_BUCKETS, s3: { endpoint, ...parseToken(state.tokens.mac) }, markers }));
    return { report, summary: formatSummary(report), markers: markers.length, live };
  });
}
