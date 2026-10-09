#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startMock } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "9000" },
    host: { type: "string", default: "127.0.0.1" },
    root: { type: "string", default: "./.s3" },
    policy: { type: "string" },
    bucket: { type: "string", multiple: true },
  },
});

const policy = values.policy ? JSON.parse(readFileSync(values.policy, "utf8")) : undefined;
const mock = await startMock({ port: Number(values.port), host: values.host, root: resolve(values.root!), policy, buckets: values.bucket });
console.log(`ivy s3-mock listening on ${mock.url} (root ${resolve(values.root!)})`);
const stop = async () => { await mock.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
