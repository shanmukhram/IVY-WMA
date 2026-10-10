#!/usr/bin/env node
/**
 * Run the IVY Mac service from source (Node 25 strips the types):
 *   node src/main.ts [--data ./data] [--port 4777] [--static ./public] [--poll-ms 120000]
 * Relative paths resolve against the working directory. Without --static the built
 * dashboard (mac/ui/dist, located relative to this package) is served when it exists.
 * Environment equivalents: IVY_DATA_DIR, IVY_DB_PATH, IVY_PORT, IVY_STATIC_DIR, IVY_POLL_INTERVAL_MS,
 * IVY_AUTO_LOCK_MINUTES, IVY_OCR=0, IVY_OCR_COMMAND, IVY_OCR_CONCURRENCY, IVY_THUMBNAILS=0.
 */
import { createService } from "./service.ts";
import type { ServiceConfig } from "./config.ts";

function args(argv: string[]): Partial<ServiceConfig> {
  const o: Partial<ServiceConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!, v = argv[i + 1];
    const need = () => { if (v === undefined) throw new Error(`${a} needs a value`); i++; return v; };
    if (a === "--data") o.dataDir = need();
    else if (a === "--db") o.dbPath = need();
    else if (a === "--port") o.port = Number(need());
    else if (a === "--host") o.host = need();
    else if (a === "--static") o.staticDir = need();
    else if (a === "--poll-ms") o.pollIntervalMs = Number(need());
    else if (a === "--auto-lock-minutes") o.autoLockMinutes = Number(need());
    else if (a === "--help" || a === "-h") { console.log("usage: node src/main.ts [--data DIR] [--db FILE] [--port N] [--host 127.0.0.1] [--static DIR] [--poll-ms N] [--auto-lock-minutes N]"); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const svc = await createService(args(process.argv.slice(2)));
const url = await svc.listen();
console.log(`IVY Mac service ${svc.version} listening on ${url}`);
console.log(`  data:    ${svc.config.dataDir}`);
console.log(`  ui:      ${svc.config.staticDir}`);
console.log(`  token:   ${svc.config.tokenPath} (send as "Authorization: Bearer <token>")`);
console.log(`  vault:   ${svc.ctx.keystore.state()}`);
const shutdown = async () => { await svc.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
