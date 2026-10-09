/** CLI dispatcher. `cli.ts` is the executable entry; tests call runCli directly. */
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import { startServe, ROLES, type ServeHandle } from "./serve.ts";
import { sendCommand, type CommandParams } from "./commands.ts";
import { passphraseFrom, paths, readCommands, readLedger, readState, type Role } from "./local.ts";
import { renderQr } from "./qr.ts";
import { table } from "./format.ts";
import { staleProtocolBuild } from "./stale.ts";

export interface Io { out(line: string): void; err(line: string): void }
const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

const USAGE = `ivy fake-mac: stands in for the Mac dashboard (S3 mock + pairing + ingest + commands)

  serve         --root DIR [--port 9000] [--role windows|android] [--passphrase P | env IVY_FAKE_MAC_PASSPHRASE]
                [--host 127.0.0.1] [--public-url URL] [--interval 5] [--pair-ttl 15] [--keep] [--no-qr]
  request-file  --root DIR --path "C:\\Users\\me\\Documents\\x.pdf" [--file-id ID] [--device ID]
  rescan        --root DIR --collector NAME [--scope S] [--device ID]
  config        --root DIR --collector NAME [--enabled true|false] [--setting k=v]... [--device ID]
  audit         --root DIR [--marker TEXT]...
  status        --root DIR

Run through pnpm with \`pnpm --filter @ivy/fake-mac run <command> ...\`, or \`node tools/fake-mac/src/cli.ts <command> ...\`.
Relative --root paths resolve against the directory you ran the command from.`;

const OPTIONS = {
  root: { type: "string" },
  port: { type: "string" },
  role: { type: "string" },
  passphrase: { type: "string" },
  host: { type: "string" },
  "public-url": { type: "string" },
  interval: { type: "string" },
  "pair-ttl": { type: "string" },
  keep: { type: "boolean" },
  "no-qr": { type: "boolean" },
  path: { type: "string" },
  "file-id": { type: "string" },
  device: { type: "string" },
  collector: { type: "string" },
  scope: { type: "string" },
  enabled: { type: "string" },
  setting: { type: "string", multiple: true },
  marker: { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
} as const;

/** Where the user actually ran the command (pnpm runs scripts from the package dir but sets INIT_CWD). */
const userCwd = () => process.env.INIT_CWD ?? process.cwd();

function bool(s: string, flag: string): boolean {
  if (/^(true|yes|on|1)$/i.test(s)) return true;
  if (/^(false|no|off|0)$/i.test(s)) return false;
  throw new Error(`${flag} must be true or false`);
}

function settings(list: string[] | undefined): Record<string, unknown> | undefined {
  if (!list?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const kv of list) {
    const i = kv.indexOf("=");
    if (i <= 0) throw new Error(`--setting must be key=value, got ${kv}`);
    const v = kv.slice(i + 1);
    try { out[kv.slice(0, i)] = JSON.parse(v); } catch { out[kv.slice(0, i)] = v; }
  }
  return out;
}

export interface RunOptions {
  io?: Io;
  /** serve: resolves when the server should stop (default: SIGINT/SIGTERM) */
  until?: (h: ServeHandle) => Promise<void>;
}

export async function runCli(argv: string[], ro: RunOptions = {}): Promise<number> {
  const io = ro.io ?? consoleIo;
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (e) { io.err((e as Error).message); io.err(USAGE); return 2; }
  const { values: v, positionals } = parsed;
  const cmd = positionals[0];
  if (v.help || !cmd) { io.out(USAGE); return v.help ? 0 : 2; }
  if (!v.root) { io.err("--root is required"); return 2; }
  const root = resolve(userCwd(), v.root);
  const stale = staleProtocolBuild();
  if (stale) io.err(stale);

  try {
    switch (cmd) {
      case "serve": return await serve(root, v, io, ro.until);
      case "request-file": {
        if (!v.path && !v["file-id"]) throw new Error("request-file needs --path (or --file-id)");
        const params: CommandParams = { type: "file_request", ...(v.path ? { path: v.path } : {}), ...(v["file-id"] ? { fileId: v["file-id"] } : {}) };
        return await issue(root, params, v.device, io);
      }
      case "rescan": {
        if (!v.collector) throw new Error("rescan needs --collector");
        return await issue(root, { type: "rescan", collector: v.collector, ...(v.scope ? { scope: v.scope } : {}) }, v.device, io);
      }
      case "config": {
        if (!v.collector) throw new Error("config needs --collector");
        const s = settings(v.setting);
        const params: CommandParams = {
          type: "collector_config", collector: v.collector,
          ...(v.enabled !== undefined ? { enabled: bool(v.enabled, "--enabled") } : {}), ...(s ? { settings: s } : {}),
        };
        return await issue(root, params, v.device, io);
      }
      case "audit": {
        const { auditRoot } = await import("./audit.ts"); // lazy: @ivy/audit loads node:sqlite
        const r = await auditRoot(root, v.marker ?? []);
        io.out(`audit of ${r.live ? "the running serve endpoint" : "the on-disk mock store (serve not running)"}, ${r.markers} marker(s) harvested from ledger.json and received/`);
        io.out(r.summary);
        return r.report.pass ? 0 : 1;
      }
      case "status": return status(root, io);
      default:
        io.err(`unknown command ${cmd}`); io.err(USAGE); return 2;
    }
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

async function issue(root: string, params: CommandParams, deviceId: string | undefined, io: Io): Promise<number> {
  const s = await sendCommand(root, params, { deviceId });
  io.out(`COMMAND ${s.key} -> device ${s.deviceId}`);
  io.out(`  commandId ${s.commandId}`);
  io.out(`  params    ${JSON.stringify(s.record.params)}`);
  if (!s.live) io.out("  (serve is not running; written to the on-disk store, the device will see it once serve is up)");
  return 0;
}

async function serve(root: string, v: Record<string, unknown>, io: Io, until?: (h: ServeHandle) => Promise<void>): Promise<number> {
  const role = (v.role as string | undefined) ?? "windows";
  if (!ROLES.includes(role as Role)) throw new Error(`--role must be one of ${ROLES.join(", ")}`);
  const passphrase = passphraseFrom(v.passphrase as string | undefined);
  const interval = Number(v.interval ?? 5);
  io.out("unlocking Mac identity (Argon2id, 64 MiB)...");
  const h = await startServe({
    root, role: role as Role, passphrase,
    port: v.port !== undefined ? Number(v.port) : 9000,
    host: v.host as string | undefined, publicUrl: v["public-url"] as string | undefined,
    intervalMs: interval * 1000, pairTtlMs: Number(v["pair-ttl"] ?? 15) * 60_000,
    keepObjects: Boolean(v.keep), log: io.out,
  });
  const pairingFile = join(root, "pairing.txt");
  writeFileSync(pairingFile, h.pairingString + "\n");
  const exp = new Date(h.state.pairings.at(-1)!.exp);

  io.out("");
  io.out(`IVY fake Mac  role=${h.role}  root=${root}`);
  io.out(`  endpoint         ${h.endpoint}${h.state.endpoint !== h.endpoint ? `   (local: ${h.state.endpoint})` : ""}`);
  io.out(`  buckets          ${h.state.buckets.up} (device write-only), ${h.state.buckets.cmd} (device read-only)`);
  io.out(`  mac fingerprint  ${h.macFingerprint}`);
  const devs = h.state.devices.filter((d) => d.role === h.role);
  io.out(`  paired devices   ${devs.length ? devs.map((d) => `${d.deviceId} [${d.fingerprint}]`).join(", ") : "none"}`);
  io.out("");
  io.out(`Pairing string (expires ${exp.toLocaleTimeString()}; also saved to ${pairingFile}):`);
  io.out("");
  io.out(h.pairingString);
  io.out("");
  if (!v["no-qr"]) {
    const qr = renderQr(h.pairingString);
    io.out(qr ?? "(pairing string too long to render as a terminal QR)");
  }
  io.out(`Ingest loop: polling ${h.state.buckets.up} every ${interval}s${v.keep ? " (--keep: objects stay in the bucket)" : ""}. Ctrl+C to stop.`);
  io.out("");

  await (until ? until(h) : new Promise<void>((res) => {
    const done = () => { process.off("SIGINT", done); process.off("SIGTERM", done); res(); };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  }));
  await h.stop();
  io.out("stopped.");
  return 0;
}

function status(root: string, io: Io): number {
  const s = readState(root);
  if (!s) { io.err(`no state under ${root}`); return 1; }
  io.out(`role=${s.role} endpoint=${s.endpoint}${s.publicEndpoint && s.publicEndpoint !== s.endpoint ? ` (device sees ${s.publicEndpoint})` : ""}`);
  io.out("devices:");
  if (!s.devices.length) io.out("  none");
  else io.out(table(["deviceId", "role", "fingerprint", "pairedAt", "lastReport"], s.devices.map((d) => [d.deviceId, d.role, d.fingerprint, d.pairedAt, d.lastReportAt ?? "-"])).join("\n"));
  const ledger = readLedger(root);
  const by = new Map<string, number>();
  for (const e of ledger) by.set(`${e.kind}/${e.status}`, (by.get(`${e.kind}/${e.status}`) ?? 0) + 1);
  io.out(`ledger: ${ledger.length} entries  ${[...by].map(([k, n]) => `${k}=${n}`).join(" ")}`);
  const cmds = readCommands(root);
  io.out("commands:");
  if (!cmds.length) io.out("  none");
  else io.out(table(["key", "type", "target", "status"], cmds.map((c) => [c.key, c.params.type, String(c.params.path ?? c.params.collector ?? c.params.fileId ?? ""), c.status ? `${c.status}${c.resultOid ? ` -> ${c.resultOid}` : ""}` : "pending"])).join("\n"));
  io.out(`files: ${paths(root).received} (received), ${paths(root).quarantine} (quarantine)`);
  return 0;
}
