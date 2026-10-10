/** PASS/FAIL table for the terminal and the markdown report (docs/reports/gate-g1-<date>.md). */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { host } from "./r2.ts";
import type { GateResult, ItemResult } from "./run.ts";

const label = (i: ItemResult) => (i.id === "P" ? "Preflight" : i.id.length === 1 ? `G1 (${i.id})` : i.id === "audit" ? "Continuous: zero-plaintext audit" : "Continuous: honesty test");
const t = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function terminalTable(r: GateResult): string {
  const rows = r.items.map((i) => [label(i), i.status, t(i.startedAt), t(i.finishedAt), i.title]);
  const head = ["Item", "Result", "Started", "Finished", "Check"];
  const w = head.map((h, k) => Math.max(h.length, ...rows.map((x) => x[k]!.length)));
  const line = (x: string[]) => x.map((c, k) => c.padEnd(w[k]!)).join("  ");
  return [line(head), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(line), "", `GATE G1: ${r.pass ? "PASS" : "NOT PASSED"} (a-d must all be PASS)`].join("\n");
}

export function markdownReport(r: GateResult): string {
  const out: string[] = [];
  out.push(`# Gate G1 run, ${r.startedAt.slice(0, 10)}`, "");
  out.push(`Written by \`@ivy/gate-g1\` (see \`docs/GATE-G1.md\`). Result: **${r.pass ? "PASS" : "NOT PASSED"}** (G1 passes when a, b, c and d are all PASS).`, "");
  out.push("| Item | Value |", "| --- | --- |");
  out.push(`| Started / finished | ${t(r.startedAt)} / ${t(r.finishedAt)} |`);
  out.push(`| Mac service | ${r.serviceUrl} (version ${r.serviceVersion ?? "?"}) |`);
  out.push(`| R2 endpoint | ${r.r2Endpoint ? host(r.r2Endpoint) : "(from the service, no r2.json)"}${r.realR2 ? " (Cloudflare R2)" : ""} |`);
  out.push(`| Mac fingerprint | \`${r.macFingerprint ?? "?"}\` |`);
  out.push(`| Windows device | ${r.device ? `\`${r.device.id}\`, fingerprint \`${r.device.fingerprint}\`` : "none"} |`, "");
  out.push("## Results", "", "| Item | Criterion | Result | Started | Finished |", "| --- | --- | --- | --- | --- |");
  for (const i of r.items) out.push(`| ${label(i)} | ${cell(i.criterion)} | **${i.status}** | ${t(i.startedAt)} | ${t(i.finishedAt)} |`);
  out.push("");
  for (const i of r.items) {
    out.push(`## ${label(i)}: ${i.title}`, "", `Result: **${i.status}**. ${i.criterion}.`, "");
    for (const e of i.evidence) out.push(`- ${e}`);
    out.push("");
  }
  out.push("## Manual steps", "", "Steps a person did, as prompted by the gate, with the time the answer was given.", "");
  out.push("| Time | Item | Step | Prompt | Answer |", "| --- | --- | --- | --- | --- |");
  for (const m of r.manual) out.push(`| ${t(m.at)} | ${m.item} | \`${m.id}\` | ${cell(m.prompt)} | ${cell(m.answer || "(Enter)")} |`);
  out.push("");
  return out.join("\n");
}

export function writeReport(path: string, r: GateResult): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdownReport(r));
}
