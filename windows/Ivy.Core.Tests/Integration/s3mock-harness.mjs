// Test harness around @ivy/s3-mock's startMock(): same server as `pnpm --filter @ivy/s3-mock start`,
// plus a loopback admin endpoint (GET /requests) exposing the mock's recorded requests and SigV4
// access key ids, so the .NET tests can assert token separation. Run from the repo root with:
//   pnpm --filter @ivy/s3-mock exec node <this file> --port P --root DIR --bucket B ... [--policy policy.json]
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    root: { type: "string" },
    policy: { type: "string" },
    bucket: { type: "string", multiple: true },
    "mock-src": { type: "string", default: join(here, "../../../packages/s3-mock/src/index.ts") },
  },
});

const { startMock } = await import(pathToFileURL(resolve(values["mock-src"])).href);
const policy = values.policy ? JSON.parse(readFileSync(values.policy, "utf8")) : undefined;
const mock = await startMock({ port: Number(values.port), host: "127.0.0.1", root: resolve(values.root), policy, buckets: values.bucket });

const admin = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/requests") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mock.requests()));
  } else if (req.method === "POST" && req.url === "/clear") {
    mock.clearRequests();
    res.writeHead(204).end();
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => admin.listen(0, "127.0.0.1", r));
console.log(`IVY-S3-MOCK READY s3=${mock.url} admin=http://127.0.0.1:${admin.address().port}`);

const stop = async () => { admin.close(); await mock.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdin.on("end", stop); // parent died / closed our stdin
process.stdin.resume();
