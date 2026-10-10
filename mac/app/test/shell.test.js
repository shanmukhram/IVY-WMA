import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { config, readToken, startService, stopService, waitForHealth, REPO } from "../shell.js";

test("config defaults run the service from source with the built UI", () => {
  const c = config({});
  assert.equal(c.url, "http://127.0.0.1:4777");
  assert.equal(c.command.args[0], join(REPO, "mac/service/src/main.ts"));
  assert.ok(c.command.args.includes(join(REPO, "mac/ui/dist")));
  assert.equal(config({ IVY_SERVICE_CMD: "/opt/ivy/svc", IVY_PORT: "5000" }).command.cmd, "/opt/ivy/svc");
});

test("starts the service, waits for health, reads the token, stops it", async () => {
  const port = await new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = mkdtempSync(join(tmpdir(), "ivy-app-"));
  const cfg = config({ IVY_DATA_DIR: dir, IVY_PORT: String(port), IVY_NODE: process.execPath });
  const child = startService(cfg, () => undefined);
  try {
    await waitForHealth(cfg.url, child, 30_000);
    assert.match(readToken(cfg), /^[0-9a-f]{64}$/);
  } finally {
    await stopService(child);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(child.exitCode !== null || child.signalCode);
  assert.ok(!existsSync(join(dir, "session.token")));
});
