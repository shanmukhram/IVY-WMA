#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { runAudit, formatSummary } from "./audit.ts";

const { values } = parseArgs({
  options: {
    bucket: { type: "string", multiple: true },
    markers: { type: "string" },
    sqlite: { type: "string", multiple: true },
    dir: { type: "string", multiple: true },
    out: { type: "string" },
    "size-threshold": { type: "string" },
    "large-sample": { type: "string" },
    "min-run": { type: "string" },
    "header-allowance": { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help || (!values.bucket && !values.sqlite && !values.dir)) {
  console.log(`usage: ivy-audit [--bucket NAME]... [--sqlite vault-agent.db]... [--dir PARTS_DIR]...
                 [--markers FILE] [--out report.json] [--size-threshold BYTES] [--large-sample N]
env for --bucket: S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY [S3_REGION]
exit: 0 = zero hits, 1 = hits or unreadable source, 2 = usage/fatal error`);
  process.exit(values.help ? 0 : 2);
}

const markers = values.markers
  ? readFileSync(values.markers, "utf8").split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith("#"))
  : [];
const num = (s?: string) => (s === undefined ? undefined : Number(s));

try {
  const env = process.env;
  const s3 = values.bucket
    ? (() => {
        for (const k of ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) if (!env[k]) throw new Error(`${k} not set`);
        return { endpoint: env.S3_ENDPOINT!, accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY!, region: env.S3_REGION };
      })()
    : undefined;
  const report = await runAudit({
    buckets: values.bucket, s3, sqliteFiles: values.sqlite, dirs: values.dir, markers,
    sizeThreshold: num(values["size-threshold"]), largeSample: num(values["large-sample"]),
    minPrintableRun: num(values["min-run"]), headerAllowance: num(values["header-allowance"]),
  });
  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report));
  console.error(formatSummary(report));
  process.exit(report.pass ? 0 : 1);
} catch (e) {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(2);
}
