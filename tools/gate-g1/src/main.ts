/** Argument parsing and the CLI entry (cli.ts only calls main()). */
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Gate, ALL_ITEMS, type GateOptions, type GateResult, type ItemId } from "./run.ts";
import { terminalIO, type GateIO } from "./io.ts";
import { terminalTable, writeReport } from "./report.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const USAGE = `usage: ivy-gate-g1 [options]
  --url URL               Mac service (default http://127.0.0.1:4777)
  --data DIR              the service's data directory (default IVY_DATA_DIR, else mac/service/data)
  --r2 FILE               optional fallback: r2.json with the Mac's tokens, to read the buckets directly
                          (default: the service audits them with its own tokens, POST /api/r2/audit)
  --path WINPATH          the ~50 MB test PDF on the PC, e.g. "C:\\Users\\admin\\Desktop\\IVY-G1\\g1-50mb.pdf"
  --sha256 HEX            its SHA-256 from the PC (asked if missing)
  --collector NAME        collector to switch off for the honesty test (default notifications)
  --only a,b,c,d,audit,honesty   run some items only (preflight always runs)
  --pairing new|existing  (a) pair again, or reuse the paired device (default: ask)
  --no-hold               (d) do not pause Mac ingest during the reboot (the queue is then not audited in R2)
  --reboot-dir DIR        (d) indexed folder on the PC for the marker files (default: the folder of --path)
  --reboot-files N        (d) marker files to create (default 10)
  --min-size BYTES        (b) minimum file size (default 50000000)
  --report-interval-min N device report interval (default 5)
  --poll-sec N            ask the service to ingest this often while waiting (default 15)
  --wait-min N            give up on a transfer after N minutes (default 45)
  --work DIR              pairing.txt / markers.txt (default .gate-g1/ at the repo root)
  --export-markers        write the audit markers to <work>/markers.txt for the PC queue audit
  --out FILE              report path (default docs/reports/gate-g1-<date>.md)
  --allow-non-r2          accept an endpoint that is not Cloudflare R2 (rehearsal against the mock)
Type skip at any prompt to record that item as SKIP and go on. Ctrl-C (or SIGTERM) writes the
report with what was gathered so far (the item in progress INTERRUPTED, the rest NOT RUN).
exit: 0 = G1 passed, 1 = not passed, 2 = usage error or the run stopped on an error, 130/143 = interrupted by SIGINT/SIGTERM`;

export function defaultReportPath(date = new Date()): string {
  return join(repoRoot, "docs", "reports", `gate-g1-${date.toISOString().slice(0, 10)}.md`);
}

/** `pnpm --filter ... run gate` runs in the package directory; INIT_CWD is where the user typed the command. */
export function parseCli(argv: string[], env = process.env, cwd = env.INIT_CWD || process.cwd()): { opts: GateOptions; out: string } | { help: true } {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" }, data: { type: "string" }, r2: { type: "string" }, path: { type: "string" }, sha256: { type: "string" },
      collector: { type: "string" }, only: { type: "string" }, pairing: { type: "string" }, "no-hold": { type: "boolean" },
      "reboot-dir": { type: "string" }, "reboot-files": { type: "string" }, "min-size": { type: "string" },
      "report-interval-min": { type: "string" }, "poll-sec": { type: "string" }, "wait-min": { type: "string" },
      work: { type: "string" }, "export-markers": { type: "boolean" }, out: { type: "string" }, "allow-non-r2": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (v.help) return { help: true };
  const num = (s: string | undefined, name: string) => {
    if (s === undefined) return undefined;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
    return n;
  };
  const only = v.only?.split(",").map((s) => s.trim()).filter(Boolean) as ItemId[] | undefined;
  for (const o of only ?? []) if (!ALL_ITEMS.includes(o)) throw new Error(`--only: unknown item ${o} (use ${ALL_ITEMS.join(",")})`);
  if (v.pairing && v.pairing !== "new" && v.pairing !== "existing") throw new Error("--pairing must be new or existing");
  const abs = (p: string) => resolve(cwd, p);
  const opts: GateOptions = {
    url: v.url ?? "http://127.0.0.1:4777",
    dataDir: abs(v.data ?? env.IVY_DATA_DIR ?? join(repoRoot, "mac", "service", "data")),
    r2File: v.r2 ? abs(v.r2) : undefined,
    workDir: abs(v.work ?? join(repoRoot, ".gate-g1")),
    only,
    windowsPath: v.path,
    sha256: v.sha256,
    minBytes: num(v["min-size"], "min-size"),
    collector: v.collector,
    reportIntervalMs: (num(v["report-interval-min"], "report-interval-min") ?? 5) * 60_000,
    pollEveryMs: (num(v["poll-sec"], "poll-sec") ?? 15) * 1000,
    waitMs: (num(v["wait-min"], "wait-min") ?? 45) * 60_000,
    hold: !v["no-hold"],
    rebootDir: v["reboot-dir"],
    rebootFiles: num(v["reboot-files"], "reboot-files"),
    pairing: v.pairing as "new" | "existing" | undefined,
    allowNonR2: !!v["allow-non-r2"],
    exportMarkers: !!v["export-markers"],
  };
  return { opts, out: v.out ? abs(v.out) : defaultReportPath() };
}

export async function main(argv: string[], io?: GateIO & { close?(): void }): Promise<number> {
  let parsed;
  try { parsed = parseCli(argv); } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); return 2; }
  if ("help" in parsed) { console.log(USAGE); return 0; }
  const { out } = parsed;
  const term = io ?? terminalIO();
  const gate = new Gate(parsed.opts, term);
  let done = false;
  const finish = (result: GateResult) => {
    try {
      writeReport(out, result);
      term.log("");
      term.log(terminalTable(result));
      term.log(`report: ${out}`);
    } catch (e) { console.error(`could not write the report: ${(e as Error).message}`); }
  };
  // Ctrl-C / SIGTERM: resume ingest if the gate paused it, write what was gathered, exit non-zero.
  const onSignal = (sig: NodeJS.Signals) => {
    if (done) return;
    done = true;
    term.log("");
    term.log(`${sig}: stopping; writing the report with what was gathered so far`);
    void (async () => {
      await gate.release().catch(() => false);
      finish(gate.result(`interrupted by ${sig}`));
      term.close?.();
      process.exit(sig === "SIGINT" ? 130 : 143);
    })();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    term.log("IVY gate G1. Steps that need you are prompts: do what they say, then answer or press Enter. Type skip at any prompt to skip that item.");
    const result = await gate.run();
    if (done) return 130; // a signal handler is finishing the run
    done = true;
    finish(result);
    if (result.interrupted) { console.error(`stopped: ${result.interrupted}`); return 2; }
    return result.pass ? 0 : 1;
  } catch (e) {
    // run() records its own errors; this is a last resort (for example the report itself failed)
    if (!done) { done = true; await gate.release().catch(() => false); finish(gate.result(`error: ${(e as Error).message}`)); }
    console.error(`fatal: ${(e as Error).stack ?? (e as Error).message}`);
    return 2;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    term.close?.();
  }
}
