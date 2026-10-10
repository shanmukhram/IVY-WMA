import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOcr, type OcrClient } from "../src/index.js";
import { makeFixtures, TEXT_WORDS, type Fixtures } from "./fixtures.js";

let fx: Fixtures;
const clients: OcrClient[] = [];
function client(opts: Parameters<typeof createOcr>[0] = {}): OcrClient {
  const c = createOcr(opts);
  clients.push(c);
  return c;
}
const hasWords = (t: string) => TEXT_WORDS.every((w) => t.toLowerCase().includes(w.toLowerCase()));

beforeAll(() => {
  fx = makeFixtures();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  fx?.cleanup();
});

describe("process management", () => {
  it("20 concurrent requests all complete on one helper, bounded by the concurrency limit", async () => {
    const ocr = client({ concurrency: 4 });
    const files = [fx.png, fx.jpeg, fx.heic, fx.tiff];
    let maxInFlight = 0;
    const poll = setInterval(() => (maxInFlight = Math.max(maxInFlight, ocr.stats().inFlight)), 5);
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => ocr.recognize(files[i % files.length]!)));
    const wall = performance.now() - t0;
    clearInterval(poll);
    expect(results).toHaveLength(20);
    for (const r of results) expect(hasWords(r.text), r.text).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(ocr.stats()).toMatchObject({ restarts: 0, completed: 20, queued: 0, inFlight: 0 });
    console.log(`[mac-ocr throughput] 20 images, concurrency 4: ${wall.toFixed(0)} ms wall, ${(wall / 20).toFixed(0)} ms/image`);
  });

  it("a killed helper restarts transparently (idle and with requests in flight)", async () => {
    const ocr = client({ concurrency: 2 });
    await ocr.ping();
    const pid1 = ocr.pid!;
    process.kill(pid1, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    const r1 = await ocr.recognize(fx.png);
    expect(hasWords(r1.text)).toBe(true);
    const pid2 = ocr.pid!;
    expect(pid2).not.toBe(pid1);

    // Kill while 6 requests are queued / in flight: all of them still resolve.
    const pending = Array.from({ length: 6 }, () => ocr.recognize(fx.png));
    await new Promise((r) => setTimeout(r, 30));
    process.kill(pid2, "SIGKILL");
    const rs = await Promise.all(pending);
    for (const r of rs) expect(hasWords(r.text)).toBe(true);
    expect(ocr.pid).not.toBe(pid2);
    expect(ocr.stats().restarts).toBe(2);
  });

  it("a request that keeps crashing the helper fails after maxAttempts; others are unaffected", async () => {
    const logs: string[] = [];
    const ocr = client({ env: { IVY_OCR_DEBUG: "1" }, maxAttempts: 2, onLog: (l) => logs.push(l) });
    const good = ocr.recognize(fx.png);
    await expect(ocr.raw({ op: "exit" })).rejects.toMatchObject({ code: "process_crashed" });
    expect(hasWords((await good).text)).toBe(true);
    expect(hasWords((await ocr.recognize(fx.png)).text)).toBe(true);
    expect(logs.some((l) => l.includes("restarted"))).toBe(true);
  });

  it("times out a stuck request, restarts the helper, and re-sends the other in-flight work", async () => {
    const ocr = client({ env: { IVY_OCR_DEBUG: "1" }, timeoutMs: 60_000, concurrency: 2 });
    await ocr.ping();
    const pid1 = ocr.pid;
    const t0 = performance.now();
    const stuck = ocr.raw({ op: "sleep", ms: 30_000 }, { timeoutMs: 400 });
    const other = ocr.recognize(fx.png);
    await expect(stuck).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(hasWords((await other).text)).toBe(true);
    expect(ocr.pid).not.toBe(pid1);
  });

  it("the default (60 s) timeout does not cut off a slow request", async () => {
    const ocr = client({ env: { IVY_OCR_DEBUG: "1" } });
    await expect(ocr.raw({ op: "sleep", ms: 1500 })).resolves.toMatchObject({ ok: true });
  });

  it("close() lets in-flight work finish and rejects later calls", async () => {
    const ocr = client();
    const inflight = ocr.recognize(fx.png);
    await new Promise((r) => setTimeout(r, 20));
    await ocr.close();
    expect(hasWords((await inflight).text)).toBe(true);
    expect(ocr.pid).toBeUndefined();
    await expect(ocr.recognize(fx.png)).rejects.toMatchObject({ code: "closed" });
  });

  it("an idle helper does not keep Node alive", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = `
      import { createOcr } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)};
      const ocr = createOcr();
      const r = await ocr.recognize(${JSON.stringify(fx.png)});
      console.log(r.text.split("\\n")[0]);
    `;
    const t0 = Date.now();
    const res = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000, cwd: new URL("..", import.meta.url).pathname });
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("IVY memory vault");
    expect(res.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });
});
