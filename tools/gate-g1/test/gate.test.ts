/**
 * The gate against the real Mac service (listening on loopback), the S3 mock with
 * scoped tokens, and a simulated Windows device. The human steps are a scripted
 * operator keyed by prompt id; the device's side of each one is simulated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encryptEnvelope, newOid, upKey, utf8 } from "@ivy/protocol";
import { makeService, makeTokens, startS3, r2ConfigFor, tempDir, rm, PASS } from "../../../mac/service/test/helpers/harness.ts";
import type { Service } from "../../../mac/service/src/service.ts";
import { Gate, type GateOptions } from "../src/run.ts";
import type { GateIO, Step } from "../src/io.ts";
import { markdownReport, terminalTable, writeReport } from "../src/report.ts";
import { parseCli } from "../src/main.ts";
import { compareWithService, parseR2Json } from "../src/r2.ts";
import { exemptBootstrap, redactRule } from "../src/run.ts";
import { harvestVaultMarkers } from "../src/markers.ts";

const PATH = "C:\\Users\\bunny\\Documents\\g1-test.pdf";
const NOTIF = "Robotics collaboration offer attached";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let svc: Service;
let s3: Awaited<ReturnType<typeof startS3>>;
let tokens: ReturnType<typeof makeTokens>;
let dataDir: string;
let work: string;
let url: string;
let r2File: string;
let pdf: Uint8Array;
let sim: SimWindowsT | null = null;
type SimWindowsT = import("./sim.ts").SimWindows;

beforeAll(async () => {
  tokens = makeTokens();
  s3 = await startS3(tokens);
  dataDir = tempDir("ivy-gate-data-");
  work = tempDir("ivy-gate-work-");
  svc = await makeService(dataDir, { port: 0 }, { token: undefined }); // token written to data/session.token
  await svc.ctx.keystore.initialize(PASS);
  svc.ctx.setR2Config(r2ConfigFor(s3.mock.url, tokens));
  url = await svc.listen();
  r2File = join(work, "r2.json");
  writeFileSync(r2File, JSON.stringify(r2ConfigFor(s3.mock.url, tokens)));
  pdf = new Uint8Array(Buffer.concat([Buffer.from("%PDF-1.7\n% G1 test document with a long plaintext line in it\n"), randomBytes(300_000)]));
});
afterAll(async () => {
  sim?.close();
  await svc.close();
  await s3.mock.stop();
  rm(dataDir); rm(work); rm(s3.root);
});

function operator(handlers: Record<string, (s: Step) => Promise<string> | string>, log: string[] = []): GateIO & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    log: (l) => { log.push(l); if (process.env.GATE_DEBUG) console.log(l); },
    async ask(step) {
      asked.push(step.id);
      const h = handlers[step.id];
      if (!h) throw new Error(`unexpected prompt ${step.id}: ${step.text}`);
      return h(step);
    },
  };
}

const fast = (o: Partial<GateOptions> = {}): GateOptions => ({
  url, dataDir, r2File, workDir: work, windowsPath: PATH, minBytes: 250_000, chunkBytes: 64 * 1024,
  reportIntervalMs: 3_000, graceMs: 4_000, pollEveryMs: 200, tickMs: 100, waitMs: 60_000, rebootFiles: 3, allowNonR2: true, ...o,
});

describe("gate G1 end to end (mock R2, real service, simulated PC)", () => {
  it("passes a, b, c, d, the audit and the honesty test, and writes the report", async () => {
    const { SimWindows } = await import("./sim.ts");
    let token = "";
    const io = operator({
      "network.mac": () => "home Wi-Fi",
      "network.pc": () => "phone hotspot",
      "pair.source": () => "",
      "pair.paste": async (s) => {
        sim = new SimWindows(String(s.data!.pairingString));
        sim.files.set(PATH, pdf);
        await sim.pair();
        await sim.dev.put("file_meta", { path: PATH, name: "g1-test.pdf", ext: "pdf", size: pdf.length, mtime: new Date().toISOString(), quickHash: "q" });
        await sim.dev.put("windows_notification", { app: "Microsoft.Teams", title: "Lab", text: NOTIF, sender: "Kenji", postedAt: new Date().toISOString() });
        sim.start();
        return "";
      },
      "pair.fingerprints": (s) => (s.text.includes(sim!.fingerprint) && s.text.includes(svc.ctx.keystore.macFingerprint()!) ? "y" : "n"),
      "file.sha256": () => sha(pdf).toUpperCase(), // PowerShell prints upper case
      "reboot.prepare": (s) => { token = String(s.data!.token); sim!.stallAfterParts = 2; return ""; },
      "reboot.now": (s) => { sim!.crash(); sim!.queueFiles(String(s.data!.token), Number(s.data!.count)); return ""; },
      "reboot.back": async () => { await sim!.restart(); return ""; },
      "unlock": async () => { await svc.ctx.keystore.unlock(PASS); return ""; },
      "audit.pc": () => "PASS",
      "honesty.disable": async (s) => { await sim!.setEnabled(String(s.data!.collector), false); return ""; },
      "honesty.enable": async (s) => { await sim!.setEnabled(String(s.data!.collector), true); return ""; },
    });
    const result = await new Gate(fast({ exportMarkers: true }), io).run();
    const by = Object.fromEntries(result.items.map((i) => [i.id, i]));
    const why = result.items.map((i) => `${i.id} ${i.status}\n  ${i.evidence.join("\n  ")}`).join("\n");
    expect(by.P!.status, why).toBe("PASS");
    for (const id of ["a", "b", "c", "d", "audit", "honesty"]) expect(by[id]!.status, why).toBe("PASS");
    expect(result.pass).toBe(true);
    expect(result.device).toMatchObject({ id: sim!.deviceId, fingerprint: sim!.fingerprint });

    // b: hashes on both sides, ciphertext through the ledger
    expect(by.b!.evidence.join("\n")).toContain(`Mac SHA-256 ${sha(pdf)}`);
    expect(by.b!.evidence.join("\n")).toMatch(/manifest \+ 5 part object\(s\)/);
    // d: the reboot interrupted the transfer, the queue survived it
    expect(by.d!.evidence.join("\n")).toMatch(/[12] of 5 part object\(s\) of the file in R2 -> the reboot interrupted the transfer/);
    expect(by.d!.evidence.join("\n")).toContain("3 of 3 marker files");
    // c ran while ingest was held: the PC's queue was in the buckets and was scanned
    expect(by.c!.evidence.join("\n")).toContain("running while Mac ingest is held");
    expect(by.c!.evidence.some((e) => /ivy-up-windows: ([4-9]|\d\d+) object/.test(e))).toBe(true);
    // honesty: within one report interval, and on the timeline
    expect(by.honesty!.evidence.join("\n")).toMatch(/coverage shows notifications off .* open "disabled" gap/);
    expect(by.honesty!.evidence.join("\n")).toContain("the timeline shows the missing period");

    expect(io.asked).toEqual(["network.mac", "network.pc", "pair.source", "pair.paste", "pair.fingerprints", "file.sha256",
      "reboot.prepare", "reboot.now", "reboot.back", "unlock", "audit.pc", "honesty.disable", "honesty.enable"]);
    expect(result.manual.map((m) => m.id)).toEqual(io.asked);
    // POSIX file modes only: Windows reports 0o666 for any writable file.
    if (process.platform !== "win32") expect(statSync(join(work, "markers.txt")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(work, "pairing.txt"), "utf8")).toMatch(/^IVYPAIR1\./);

    const out = join(work, "gate-g1-test.md");
    writeReport(out, result);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("Result: **PASS**");
    expect(md).toMatch(/\| G1 \(a\) \| Windows and Mac pair over R2 from different networks .* \| \*\*PASS\*\* \|/);
    expect(md).toMatch(/\| G1 \(d\) \| a PC reboot mid-queue loses nothing \| \*\*PASS\*\* \|/);
    expect(md).toContain("`reboot.now`");
    expect(md).toContain(token);
    expect(terminalTable(result)).toContain("GATE G1: PASS");
  });

  it("fails c on plaintext in a bucket without writing the marker into the report", async () => {
    const key = upKey("usage_event", newOid());
    await sim!.dev.up.put(key, utf8(JSON.stringify({ note: NOTIF })));
    const result = await new Gate(fast({ only: ["c"] }), operator({})).run();
    const c = result.items.find((i) => i.id === "c")!;
    expect(c.status).toBe("FAIL");
    expect(c.evidence.join("\n")).toContain(`ivy-up-windows/${key}`);
    expect(c.evidence.join("\n")).toMatch(/marker \(\d+ chars\)/);
    expect(markdownReport(result)).not.toContain(NOTIF);
    expect(result.pass).toBe(false);
    await svc.ingester.poll(); // the service quarantines it and removes it from the bucket
  });

  it("fails b when the PC's hash differs", async () => {
    const result = await new Gate(fast({ only: ["b"], sha256: "0".repeat(64) }), operator({})).run();
    const b = result.items.find((i) => i.id === "b")!;
    expect(b.status).toBe("FAIL");
    expect(b.evidence.join("\n")).toContain("FAIL: the hashes differ");
  });

  it("preflight refuses a non-R2 endpoint unless --allow-non-r2, and every item is then SKIP", async () => {
    const result = await new Gate(fast({ allowNonR2: false }), operator({})).run();
    expect(result.items.find((i) => i.id === "P")!.status).toBe("FAIL");
    expect(result.items.filter((i) => i.id !== "P").every((i) => i.status === "SKIP")).toBe(true);
    expect(result.pass).toBe(false);
  });

  it("preflight fails clearly without a session token", async () => {
    const result = await new Gate(fast({ dataDir: work }), operator({})).run();
    expect(result.items[0]!.evidence.join("\n")).toMatch(/no session token/);
  });
});

describe("pieces", () => {
  it("parses arguments with relative paths against the working directory", () => {
    const w = resolve("/w");
    const p = parseCli(["--data", "./d", "--r2", "r2.json", "--only", "b,c", "--no-hold", "--report-interval-min", "2", "--out", "rep.md"], {}, w);
    if ("help" in p) throw new Error("help");
    expect(p.opts).toMatchObject({ dataDir: join(w, "d"), r2File: join(w, "r2.json"), only: ["b", "c"], hold: false, reportIntervalMs: 120_000 });
    expect(p.out).toBe(join(w, "rep.md"));
    expect(() => parseCli(["--only", "z"], {}, w)).toThrow(/unknown item/);
    const d = parseCli([], {}, w);
    if ("help" in d) throw new Error("help");
    expect(d.out.replace(/\\/g, "/")).toMatch(/docs\/reports\/gate-g1-\d{4}-\d\d-\d\d\.md$/);
  });

  it("reads r2.json per bucket and cross-checks it against the service's redacted config", async () => {
    const mine = parseR2Json({ accountId: "abc123", macTokens: { up: { windows: "kup:s" }, all: "kall:s" } });
    expect(mine.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
    expect(mine.buckets.find((b) => b.name === "ivy-up-windows")!.accessKeyId).toBe("kup");
    expect(mine.buckets.find((b) => b.name === "ivy-cmd-android")!.accessKeyId).toBe("kall");
    const redacted = { endpoint: "https://abc123.r2.cloudflarestorage.com", buckets: { upWindows: "ivy-up-windows", upAndroid: "ivy-up-android", cmdWindows: "ivy-cmd-windows", cmdAndroid: "ivy-cmd-android" }, macTokens: { up: { windows: { accessKeyId: "kup" } }, cmd: {}, all: { accessKeyId: "kall" } } };
    expect(compareWithService(mine, redacted)).toEqual([]);
    expect(compareWithService(mine, { ...redacted, macTokens: { up: {}, cmd: {}, all: { accessKeyId: "other" } } })).toHaveLength(4);
    expect(() => parseR2Json({ accountId: "x", macTokens: { up: { windows: "a:b" } } })).toThrow(/no Mac token/);
  });

  it("exempts only printable runs of a pending pairing bootstrap and redacts marker text", () => {
    const rep = { generatedAt: "", pass: false, totalHits: 2, itemsScanned: 1, bytesScanned: 1, fullItems: 1, fullBytes: 1, sampledItems: 0, sampledBytes: 0,
      sampling: { sizeThreshold: 0, windowsPerSample: 0, windowSize: 0 }, errors: [],
      items: [{ source: "s3" as const, name: "ivy-cmd-windows/pair/abcd", size: 1, scannedBytes: 1, sampled: false, hits: [{ rule: "printable-run:80", offset: 0, evidence: "" }, { rule: "marker:secret text", offset: 0, evidence: "" }] }] };
    const e = exemptBootstrap(rep);
    expect(e.totalHits).toBe(1);
    expect(e.pass).toBe(false);
    expect(redactRule("marker:secret text")).toBe("marker (11 chars)");
    expect(redactRule("magic:pdf")).toBe("magic:pdf");
  });

  it("harvests markers from the vault and retrieved originals", () => {
    const m = harvestVaultMarkers(dataDir);
    expect(m).toContain(PATH);
    expect(m).toContain(NOTIF);
    expect(m.some((x) => x.startsWith("% G1 test document"))).toBe(true);
    expect(existsSync(join(dataDir, "vault.db"))).toBe(true);
  });
});
