/**
 * End-to-end smoke: the real @ivy/mac-service (child process, temp data dir) serving the built UI,
 * the S3 mock as R2, a simulated Windows device speaking @ivy/protocol, and Playwright chromium
 * driving the dashboard: set passphrase -> settings R2 -> pairing -> device uploads file_meta and
 * a screenshot -> search -> timeline -> request original -> status progresses to done.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { makeTokens, startS3, tempDir, rm, BUCKETS } from "../../service/test/helpers/harness.ts";
import { SimDevice, PNG_1x1, iso } from "../../service/test/helpers/device.ts";

const here = resolve(import.meta.dirname, "..");
const SERVICE = resolve(here, "../service/src/main.ts");
const DIST = join(here, "dist");
const PASS = "e2e smoke passphrase, long enough";

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.unref(); s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

let svc: ChildProcess; let browser: Browser; let page: Page; let base = "";
let s3: Awaited<ReturnType<typeof startS3>>; let tokens: ReturnType<typeof makeTokens>; let dataDir = "";
let dev: SimDevice | null = null; let log = "";

/** Sidebar link by its exact name ("Files" is not "Windows Files"). */
async function nav(p: Page, name: string) {
  await p.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name, exact: true }).click();
}

async function sync(p: Page) {
  await p.getByRole("button", { name: "Sync now" }).click();
  await p.getByRole("status").filter({ hasText: /^sync (done|skipped|failed)/ }).waitFor();
  const t = await p.getByRole("status").filter({ hasText: /^sync / }).textContent();
  expect(t).toMatch(/^sync done/);
}

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the UI first (pnpm --filter @ivy/mac-ui build)");
  tokens = makeTokens();
  s3 = await startS3(tokens);
  void BUCKETS;
  dataDir = tempDir("ivy-e2e-");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  svc = spawn(process.execPath, [SERVICE, "--data", dataDir, "--port", String(port), "--static", DIST, "--poll-ms", "0"], {
    env: { ...process.env, IVY_OCR: "off", IVY_THUMBNAILS: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  svc.stdout!.on("data", (b) => { log += b; });
  svc.stderr!.on("data", (b) => { log += b; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not yet */ }
    if (i > 150 || svc.exitCode !== null) throw new Error(`service did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch();
  page = await (await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })).newPage();
  page.setDefaultTimeout(20_000);
});

afterAll(async () => {
  dev?.close();
  await browser?.close();
  if (svc && svc.exitCode === null) { svc.kill("SIGTERM"); await new Promise((r) => svc.once("exit", r)); }
  await s3?.mock.stop();
  if (dataDir) rm(dataDir);
  if (s3) rm(s3.root);
});

describe("Mac dashboard against the real service", () => {
  it("drives setup, pairing, ingest, search, timeline and file retrieval", async () => {
    const token = readFileSync(join(dataDir, "session.token"), "utf8").trim();
    await page.goto(`${base}/#token=${token}`);

    // ---- set passphrase -> salt note -> dashboard
    await page.getByRole("heading", { name: "Set a passphrase" }).waitFor();
    await page.getByLabel("Passphrase", { exact: true }).fill(PASS);
    await page.getByLabel("Repeat passphrase").fill(PASS);
    await page.getByRole("button", { name: "Set passphrase" }).click();
    await page.getByRole("heading", { name: "Vault created" }).waitFor({ timeout: 30_000 });
    expect(await page.getByText(/identity\.json/).first().textContent()).toMatch(/salt/);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("navigation", { name: "Sidebar" }).waitFor();
    expect(page.url()).not.toContain("token="); // the fragment is consumed

    // ---- settings: R2 (the S3 mock) and a connection check; secrets come back masked
    await nav(page, "Settings");
    await page.getByLabel("Endpoint (instead of account id)").fill(s3.mock.url);
    await page.getByLabel("Mac token, all four buckets (fallback)").fill(tokens.mac);
    await page.getByLabel("Windows device: up-bucket write token").fill(tokens.winUp);
    await page.getByLabel("Windows device: cmd-bucket read token").fill(tokens.winCmd);
    await page.getByRole("button", { name: "Save R2 configuration" }).click();
    await page.getByText(/^Saved\. Secrets are stored sealed/).waitFor();
    const secret = tokens.mac.split(":")[1]!;
    expect(await page.content()).not.toContain(secret);
    await page.getByText(`${tokens.mac.split(":")[0]}:********`).first().waitFor();
    await page.getByRole("button", { name: "Check connection" }).click();
    await page.getByRole("table", { name: "Connection check" }).waitFor();
    expect(await page.getByRole("table", { name: "Connection check" }).getByText("reachable").count()).toBe(4);

    // ---- start pairing: string + QR + fingerprint
    await nav(page, "Devices");
    await page.getByRole("button", { name: "Start pairing: Windows" }).click();
    const pairingString = await page.getByLabel("Pairing string").inputValue();
    expect(pairingString).toMatch(/^IVYPAIR1\./);
    await page.getByRole("img", { name: "Pairing QR code" }).waitFor();
    expect(await page.getByTestId("countdown").textContent()).toMatch(/^(10:00|9:\d\d)$/);

    // ---- a simulated Windows device pairs and uploads
    dev = new SimDevice(pairingString);
    await dev.pair();
    await page.getByRole("dialog", { name: "Pairing" }).getByRole("button", { name: "Check now" }).click();
    await page.getByRole("status").filter({ hasText: /^Paired windows device/ }).waitFor();
    expect(await page.getByText(dev.fingerprint).count()).toBeGreaterThan(0);

    const now = Date.now();
    await dev.put("file_meta", { path: "C:\\Users\\bunny\\Documents\\Robotics Offer.pdf", name: "Robotics Offer.pdf", ext: "pdf", size: 2048, mtime: iso(now - 60_000), quickHash: "qh" });
    const shotBytes = new Uint8Array([...PNG_1x1, ...randomBytes(600)]);
    const shot = dev.blob(shotBytes, "screenshot", 256);
    await dev.put("screenshot", { sourcePath: "C:\\Users\\bunny\\Pictures\\Screenshots\\robotics-collab.png", width: 1, height: 1,
      sha256: createHash("sha256").update(shotBytes).digest("hex"), blobOid: shot.oid, takenAt: iso(now - 30_000), savedAt: iso(now - 29_000) });
    await dev.putBlob(shot);
    await dev.report([{ name: "files", lastRunAt: iso() }, { name: "screenshots", lastRunAt: iso() }]);
    await sync(page);

    // ---- search finds both
    await nav(page, "Search");
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("robotics");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByTestId("search-summary").filter({ hasText: /^2 matches/ }).waitFor();
    await page.getByTestId("item-file").waitFor();
    await page.getByTestId("item-screenshot").waitFor();
    expect(await page.locator("mark").first().textContent()).toMatch(/robotics/i);
    expect(await page.getByTestId("item-file").textContent()).toMatch(/reference only/);

    // ---- timeline (today) shows them, image inline
    await nav(page, "Timeline");
    await page.getByTestId("timeline-summary").filter({ hasText: /^2 records/ }).waitFor();
    await page.getByTestId("item-screenshot").locator("img").waitFor();
    expect(await page.getByTestId("item-screenshot").locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    await page.getByRole("region", { name: "Day timeline" }).waitFor();

    // ---- request original: queued -> in progress -> done
    await nav(page, "Files");
    await page.getByRole("button", { name: "Request original" }).click();
    await page.getByTestId("request-status").filter({ hasText: "waiting for the device" }).waitFor();
    const cmds = await dev.commands();
    const req = cmds.find((c) => c.record.params.type === "file_request")!;
    expect(req.record.params).toMatchObject({ path: "C:\\Users\\bunny\\Documents\\Robotics Offer.pdf" });
    const original = new Uint8Array(randomBytes(2048));
    const blob = dev.blob(original, "file_original", 512);
    await dev.up.put(blob.manifest.key, blob.manifest.bytes);
    await dev.up.put(blob.parts[0]!.key, blob.parts[0]!.bytes);
    await dev.put("command_status", { commandId: req.record.commandId, status: "uploaded", resultOid: blob.oid, reportedAt: iso() });
    await sync(page);
    await page.getByTestId("request-status").filter({ hasText: /in progress: 512 of 2048 bytes \(25%\)/ }).waitFor();
    for (const p of blob.parts.slice(1)) await dev.up.put(p.key, p.bytes);
    await sync(page);
    await page.getByTestId("request-status").filter({ hasText: "done: local copy available" }).waitFor();
    const link = page.getByRole("link", { name: "Open local copy" });
    await link.waitFor();
    const got = await page.evaluate(async (u) => new Uint8Array(await (await fetch(u!)).arrayBuffer()).length, await link.getAttribute("href"));
    expect(got).toBe(2048);

    // ---- coverage shows the device with dots; activity feed saw the events
    await nav(page, "Coverage");
    await page.getByRole("region", { name: "windows coverage" }).waitFor();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    expect(await page.getByRole("complementary", { name: "Live activity" }).textContent()).toMatch(/file\.cached/);
    await page.keyboard.press("Escape");
    await page.getByRole("complementary", { name: "Live activity" }).waitFor({ state: "detached" });

    // ---- the Windows group lists its sources; a source opens the per-device view
    await page.getByRole("navigation", { name: "Sidebar" }).getByRole("button", { name: "Windows", exact: true }).click();
    await nav(page, "Windows Files");
    await page.getByRole("region", { name: "Windows status" }).waitFor();
    await page.getByText("Robotics Offer.pdf").first().waitFor();

    // ---- screen lock keeps the key; unlock comes back
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await page.getByRole("menuitem", { name: /screen only/ }).click();
    await page.getByRole("heading", { name: "IVY is locked" }).waitFor();
    expect(await page.getByText(/key is still in memory/).count()).toBe(1);
    await page.getByLabel("Passphrase").fill(PASS);
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByRole("navigation", { name: "Sidebar" }).waitFor({ timeout: 30_000 });
  });
});
