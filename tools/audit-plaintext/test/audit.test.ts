import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

// async on purpose: the mock server lives in this process, so a blocking spawn would deadlock it
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
    execFile("node", args, { env }, (err, stdout, stderr) => resolve({ status: err ? (err as any).code : 0, stdout, stderr })));
import { DatabaseSync } from "node:sqlite";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { startMock, type MockServer } from "@ivy/s3-mock";
import { runAudit, scanBuffer, formatSummary } from "../src/index.ts";

let mock: MockServer;
let s3: S3Client;
const tmp = () => mkdtempSync(join(tmpdir(), "audit-"));
const cfg = () => ({ endpoint: mock.url, accessKeyId: "auditor", secretAccessKey: "s" });
const put = (bucket: string, Key: string, Body: Buffer | string) => s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body }));

beforeAll(async () => {
  mock = await startMock({ root: tmp(), buckets: ["clean", "dirty", "mixed", "big"] });
  s3 = new S3Client({ endpoint: mock.url, region: "auto", forcePathStyle: true, credentials: { accessKeyId: "auditor", secretAccessKey: "s" } });
});
afterAll(() => mock.stop());

describe("scanBuffer", () => {
  it("random bytes produce no hits", () => {
    for (let i = 0; i < 50; i++) expect(scanBuffer(randomBytes(200_000))).toEqual([]);
  });
  it("header allowance exempts a short text header only", () => {
    const hdr = Buffer.from("IVYENV1 this header is allowed ok");
    expect(scanBuffer(Buffer.concat([hdr, randomBytes(100)]))).toEqual([]);
    // Zero bytes on both sides: a random neighbour can itself be printable and lengthen the run (flaky).
    const long = Buffer.concat([randomBytes(100), Buffer.alloc(1), Buffer.from("A".repeat(24)), Buffer.alloc(1), randomBytes(100)]);
    expect(scanBuffer(long).map((h) => h.rule)).toEqual(["printable-run:24"]);
  });
  it("detects magic bytes and generic markers", () => {
    const rules = (b: Buffer) => scanBuffer(b).map((h) => h.rule);
    expect(rules(Buffer.concat([randomBytes(10), Buffer.from("%PDF-1.7"), randomBytes(10)]))).toContain("magic:pdf");
    expect(rules(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(20)]))).toContain("magic:png");
    expect(rules(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(20)]))).toContain("magic:jpeg");
    expect(rules(Buffer.concat([randomBytes(80), Buffer.from('{"kind":'), randomBytes(5)]))).toContain('generic:"kind":');
    expect(rules(Buffer.concat([randomBytes(80), Buffer.from('"path":')]))).toContain('generic:"path":');
  });
  it("detects supplied markers in utf8 and utf16le", () => {
    const m = ["Secret Fixture"];
    expect(scanBuffer(Buffer.concat([randomBytes(80), Buffer.from("Secret Fixture", "utf16le")]), { markers: m }).length).toBe(1);
    expect(scanBuffer(Buffer.concat([randomBytes(80), Buffer.from("Secret Fixture")]), { markers: m }).length).toBe(1);
  });
});

describe("audit against s3-mock", () => {
  it("passes on random-bytes objects", async () => {
    for (let i = 0; i < 5; i++) await put("clean", `up/${i}.bin`, randomBytes(50_000));
    const r = await runAudit({ buckets: ["clean"], s3: cfg(), markers: ["Quarterly Report"] });
    expect(r.pass).toBe(true);
    expect(r.totalHits).toBe(0);
    expect(r.itemsScanned).toBe(5);
  });

  it("fails on one deliberately plaintext object among random ones", async () => {
    await put("mixed", "ok/1.bin", randomBytes(30_000));
    await put("mixed", "ok/2.bin", randomBytes(30_000));
    await put("mixed", "leak/plain.json", Buffer.concat([randomBytes(70), Buffer.from('{"kind":"note","path":"C:\\\\Users\\\\bunny\\\\diary.txt","text":"Quarterly Report draft"}')]));
    const r = await runAudit({ buckets: ["mixed"], s3: cfg(), markers: ["Quarterly Report"] });
    expect(r.pass).toBe(false);
    const bad = r.items.filter((i) => i.hits.length > 0);
    expect(bad.map((i) => i.name)).toEqual(["mixed/leak/plain.json"]);
    const rules = bad[0]!.hits.map((h) => h.rule);
    expect(rules).toContain("marker:Quarterly Report");
    expect(rules).toContain('generic:"kind":');
    expect(formatSummary(r)).toContain("RESULT: FAIL");
  });

  it("samples large objects with ranged reads and still catches plaintext at the start", async () => {
    await put("big", "ct.bin", randomBytes(300_000));
    await put("big", "leak.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(300_000)]));
    const r = await runAudit({ buckets: ["big"], s3: cfg(), sizeThreshold: 1000, largeSample: 5, windowSize: 64 * 1024 });
    expect(r.items.every((i) => i.sampled)).toBe(true);
    expect(r.items.every((i) => i.scannedBytes < 300_000)).toBe(true);
    expect(r.items.filter((i) => i.hits.length).map((i) => i.name)).toEqual(["big/leak.pdf"]);
  });

  it("reports an unreadable bucket as failure, not a silent pass", async () => {
    const r = await runAudit({ buckets: ["no-such-bucket"], s3: cfg() });
    expect(r.pass).toBe(false);
    expect(r.errors.length).toBe(1);
  });
});

describe("local sources", () => {
  it("scans queue-part directories", async () => {
    const d = tmp();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "a.part"), randomBytes(5000));
    writeFileSync(join(d, "sub", "b.part"), randomBytes(5000));
    expect((await runAudit({ dirs: [d] })).pass).toBe(true);
    writeFileSync(join(d, "sub", "leak.part"), Buffer.concat([randomBytes(100), Buffer.from("this is a perfectly readable sentence")]));
    const r = await runAudit({ dirs: [d] });
    expect(r.pass).toBe(false);
    expect(r.items.filter((i) => i.hits.length).map((i) => i.name)).toEqual([join(d, "sub", "leak.part")]);
  });

  it("scans a SQLite queue: schema text is fine, plaintext blobs and rows are not", async () => {
    const f = join(tmp(), "vault-agent.db");
    const db = new DatabaseSync(f);
    db.exec("CREATE TABLE queue (id INTEGER PRIMARY KEY, state TEXT, object_key TEXT, payload BLOB)");
    const ins = db.prepare("INSERT INTO queue (state, object_key, payload) VALUES (?, ?, ?)");
    for (let i = 0; i < 20; i++) ins.run("pending", `up/windows/2026/10/${i}.bin`, randomBytes(2000));
    db.close();
    const ok = await runAudit({ sqliteFiles: [f], markers: ["diary"] });
    expect(ok.pass).toBe(true);
    expect(ok.itemsScanned).toBeGreaterThanOrEqual(2);

    const db2 = new DatabaseSync(f);
    db2.prepare("INSERT INTO queue (state, object_key, payload) VALUES (?, ?, ?)").run("pending", "k", Buffer.from('{"kind":"file","path":"C:/x"}'));
    db2.close();
    const bad = await runAudit({ sqliteFiles: [f], markers: ["diary"] });
    expect(bad.pass).toBe(false);
    expect(bad.items.some((i) => i.name.includes("#queue") && i.hits.length > 0)).toBe(true);
  });
});

describe("CLI", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = () => ({ ...process.env, S3_ENDPOINT: mock.url, S3_ACCESS_KEY_ID: "auditor", S3_SECRET_ACCESS_KEY: "s" });

  it("exits 0 on clean bucket and writes JSON report", async () => {
    const out = join(tmp(), "report.json");
    expect((await run([cli, "--bucket", "clean", "--out", out], env())).status).toBe(0);
    const rep = JSON.parse(readFileSync(out, "utf8"));
    expect(rep.pass).toBe(true);
  });

  it("exits 1 on a bucket with a plaintext object and honors --markers file", async () => {
    const markers = join(tmp(), "markers.txt");
    writeFileSync(markers, "# fixtures\nQuarterly Report\n");
    const r = await run([cli, "--bucket", "mixed", "--markers", markers], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("RESULT: FAIL");
    expect(JSON.parse(r.stdout).pass).toBe(false);
  });

  it("exits 2 without credentials", async () => {
    const e = env(); delete (e as any).S3_ENDPOINT;
    expect((await run([cli, "--bucket", "clean"], e)).status).toBe(2);
  });
});
