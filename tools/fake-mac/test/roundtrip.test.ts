import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { newOid, upKey } from "@ivy/protocol";
import { startServe, type ServeHandle } from "../src/serve.ts";
import { runCli, type Io } from "../src/main.ts";
import { readCommands, readLedger, readState } from "../src/local.ts";
import { auditRoot } from "../src/audit.ts";
import { FakeDevice, iso } from "./device.ts";

const PASS = "fake-mac test passphrase";
const WIN_PATH = "C:\\Users\\bunny\\Documents\\x.pdf";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const capture = () => {
  const lines: string[] = [];
  const io: Io = { out: (l) => lines.push(l), err: (l) => lines.push("ERR " + l) };
  return { lines, io, text: () => lines.join("\n") };
};

let root: string;
let h: ServeHandle;
let dev: FakeDevice;
const log: string[] = [];
const upKeys = () => h.mock.listAll("ivy-up-windows").map((o) => o.key);
const cmdKeys = () => h.mock.listAll("ivy-cmd-windows").map((o) => o.key);
const ledgerFor = (key: string) => readLedger(root).filter((e) => e.key === key);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fake-mac-"));
  h = await startServe({ root, passphrase: PASS, port: 0, intervalMs: 0, log: (l) => log.push(l) });
  dev = new FakeDevice(h.pairingString);
});

afterAll(async () => {
  dev?.close();
  await h?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("fake-mac ingest round trip (test plays the Windows device)", () => {
  it("serves a pairing string whose bootstrap the device can open with only the cmd-read token", async () => {
    expect(h.pairingString.startsWith("IVYPAIR1.")).toBe(true);
    expect(dev.payload.macFingerprint).toBe(h.macFingerprint);
    expect(dev.payload.cmdReadToken).toMatch(/^cmd-windows:[0-9a-f]+$/);
    expect(cmdKeys()).toContain(`pair/${h.pairingId}`);
    await dev.pair();
    // the scope policy is real: the up token cannot list, the cmd token cannot write
    await expect(dev.up.list()).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    await expect(dev.cmd.put("cmd/forged", new Uint8Array(4))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  });

  it("records the paired device, prints both fingerprints, and consumes the bootstrap", async () => {
    const r = await h.ingestOnce();
    expect(r.committed).toBe(1);
    const s = readState(root)!;
    expect(s.devices).toHaveLength(1);
    expect(s.devices[0]).toMatchObject({ deviceId: dev.deviceId, role: "windows", fingerprint: dev.fingerprint });
    expect(s.pairings.find((p) => p.pairingId === h.pairingId)!.status).toBe("consumed");
    expect(cmdKeys()).not.toContain(`pair/${h.pairingId}`);
    expect(upKeys()).toEqual([]);
    const text = log.join("\n");
    expect(text).toContain(`device fingerprint ${dev.fingerprint}`);
    expect(text).toContain(`mac fingerprint    ${h.macFingerprint}`);
    expect(ledgerFor(`pair/${h.pairingId}/device`)[0]).toMatchObject({ kind: "pairing_device", status: "committed" });
  });

  it("refuses a second device object for the same pairing id (single-use)", async () => {
    const intruder = new FakeDevice(h.pairingString);
    intruder.up = dev.up; // a leaked up-write token
    const key = await intruder.putPairingRecord(h.pairingId);
    const r = await h.ingestOnce();
    expect(r.rejected).toBe(1);
    expect(readState(root)!.devices.map((d) => d.deviceId)).toEqual([dev.deviceId]);
    expect(ledgerFor(key).at(-1)).toMatchObject({ status: "rejected" });
    expect(upKeys()).toEqual([]);
    intruder.close();
  });

  it("decrypts a file_meta record, a chunked blob, and a device report; quarantines garbage without stalling", async () => {
    log.length = 0;
    const fileKey = await dev.putRecord("file_meta", {
      path: "C:\\Users\\bunny\\Documents\\taxes-2026.xlsx", name: "taxes-2026.xlsx", size: 48213, ext: "xlsx", mtime: iso(), quickHash: "ab12cd34ef56",
    });
    const shot = new Uint8Array(randomBytes(1000));
    const blob = dev.blob(shot, "screenshot", 256);
    const shotKey = await dev.putRecord("screenshot", { sourcePath: "C:\\Users\\bunny\\Pictures\\Screenshots\\s1.png", sha256: sha(shot), blobOid: blob.oid });
    // only the manifest and part 0 so far: the blob must wait, not quarantine
    await dev.up.put(blob.manifest.key, blob.manifest.bytes);
    await dev.up.put(blob.parts[0]!.key, blob.parts[0]!.bytes);
    const reportKey = await dev.putRecord("device_report", {
      role: "windows", appVersion: "0.1.0-smoke", queueDepthTotal: 3, reportedAt: iso(),
      collectors: [
        { name: "files", enabled: true, lastRunAt: "2026-10-10T08:00:00.000Z", cursor: "usn:4242", queueDepth: 2 },
        { name: "usage", enabled: false, queueDepth: 1 },
      ],
    });
    const garbageKey = upKey("file_meta", newOid());
    await dev.up.put(garbageKey, new Uint8Array(randomBytes(300)));
    await dev.up.put("up/nonsense/thing", new Uint8Array(randomBytes(40)));

    const r1 = await h.ingestOnce();
    expect(r1).toMatchObject({ committed: 3, quarantined: 2, waiting: 1 });
    expect(upKeys().sort()).toEqual([blob.manifest.key, blob.parts[0]!.key].sort());

    for (const p of blob.parts.slice(1)) await dev.up.put(p.key, p.bytes);
    const r2 = await h.ingestOnce();
    expect(r2).toMatchObject({ committed: 1, quarantined: 0, waiting: 0 });
    expect(upKeys()).toEqual([]);

    // ledger
    expect(ledgerFor(fileKey)[0]).toMatchObject({ kind: "file_meta", status: "committed", deviceId: dev.deviceId });
    expect((ledgerFor(fileKey)[0]!.record as { path: string }).path).toBe("C:\\Users\\bunny\\Documents\\taxes-2026.xlsx");
    expect(ledgerFor(shotKey)[0]).toMatchObject({ kind: "screenshot", status: "committed" });
    expect(ledgerFor(reportKey)[0]).toMatchObject({ kind: "device_report", status: "committed" });
    expect(ledgerFor(garbageKey)[0]).toMatchObject({ kind: "file_meta", status: "quarantined" });
    expect(ledgerFor(garbageKey)[0]!.detail).toMatch(/undecryptable/);
    expect(ledgerFor("up/nonsense/thing")[0]).toMatchObject({ status: "quarantined" });
    const m = ledgerFor(blob.manifest.key)[0]!;
    expect(m).toMatchObject({ kind: "manifest", status: "committed", parts: 4, sha256: sha(shot) });
    for (const e of readLedger(root)) expect(Object.keys(e)).toEqual(expect.arrayContaining(["key", "kind", "status", "ingestedAt"]));

    // received plaintext, named by the screenshot's extension
    expect(readFileSync(join(root, "received", `${blob.oid}.png`))).toEqual(Buffer.from(shot));
    // quarantine holds the raw bytes
    const q = readdirSync(join(root, "quarantine"));
    expect(q.some((f) => f.includes(garbageKey.replace(/\//g, "_")) && f.endsWith(".bin"))).toBe(true);
    expect(q.some((f) => f.includes("up_nonsense_thing"))).toBe(true);

    // console output
    const text = log.join("\n");
    expect(text).toContain(`RECORD ${fileKey} kind=file_meta`);
    expect(text).toContain("taxes-2026.xlsx");
    expect(text).toContain(`BLOB ${blob.manifest.key} payloadKind=screenshot parts=4 size=1000 sha256=${sha(shot)}`);
    expect(text).toMatch(/collector\s+enabled\s+lastRun\s+cursor\s+queueDepth/);
    expect(text).toMatch(/files\s+yes\s+2026-10-10T08:00:00.000Z\s+usn:4242\s+2/);
    expect(text).toMatch(/usage\s+no\s+never\s+-\s+1/);
    expect(text).toContain(`QUARANTINED ${garbageKey}`);
  });

  it("quarantines a tampered blob (all its objects) instead of committing it", async () => {
    const blob = dev.blob(new Uint8Array(randomBytes(600)), "screenshot", 256);
    blob.parts[1]!.bytes[40]! ^= 0xff;
    await dev.putBlob(blob);
    const r = await h.ingestOnce();
    expect(r.quarantined).toBe(1);
    expect(upKeys()).toEqual([]);
    expect(ledgerFor(blob.manifest.key)[0]).toMatchObject({ status: "quarantined" });
    expect(existsSync(join(root, "received", `${blob.oid}.bin`))).toBe(false);
  });

  it("an identical replay of a committed object is only deleted; a different object at a committed key is rejected", async () => {
    const key = upKey("usage_event", newOid());
    const env = (await import("@ivy/protocol")).encryptEnvelope({
      recipientPublicKey: h.identity.publicKey, kind: "usage_event", objectKey: key,
      plaintext: Buffer.from(JSON.stringify({ ...dev.base("usage_event"), app: "Notepad", startedAt: iso(), endedAt: iso() })),
    });
    await dev.up.put(key, env);
    expect((await h.ingestOnce()).committed).toBe(1);
    await dev.up.put(key, env);
    expect((await h.ingestOnce()).replayed).toBe(1);
    expect(ledgerFor(key)).toHaveLength(1);
    await dev.up.put(key, new Uint8Array(randomBytes(200)));
    expect((await h.ingestOnce()).rejected).toBe(1);
    expect(ledgerFor(key).map((e) => e.status)).toEqual(["committed", "rejected"]);
    expect(upKeys()).toEqual([]);
  });

  it("request-file with a Windows path: device receives it intact, uploads the original, Mac deletes the command on status", async () => {
    const c = capture();
    expect(await runCli(["request-file", "--root", root, "--path", WIN_PATH], { io: c.io })).toBe(0);
    expect(c.text()).toContain(`"path":${JSON.stringify(WIN_PATH)}`);
    const issued = readCommands(root).at(-1)!;
    expect(cmdKeys()).toContain(issued.key);

    const cmds = await dev.commands();
    expect(cmds).toHaveLength(1);
    const { key, record } = cmds[0]!;
    expect(key).toBe(issued.key);
    expect(record.deviceId).toBe(dev.deviceId);
    expect(record.params).toEqual({ type: "file_request", path: WIN_PATH });

    // the device answers: original as a file_original blob, then command_status uploaded
    const pdf = new Uint8Array(Buffer.concat([Buffer.from("%PDF-1.7 fake invoice for the smoke test\n"), randomBytes(2000)]));
    const blob = dev.blob(pdf, "file_original", 512);
    await dev.putBlob(blob);
    await dev.putRecord("command_status", { commandId: record.commandId, status: "uploaded", resultOid: blob.oid, reportedAt: iso() });
    log.length = 0;
    await h.ingestOnce();

    expect(cmdKeys()).not.toContain(issued.key); // PLAN decision 4
    expect(upKeys()).toEqual([]);
    const after = readCommands(root).find((x) => x.commandId === record.commandId)!;
    expect(after).toMatchObject({ status: "uploaded", resultOid: blob.oid, deletedFromBucket: true });
    expect(readFileSync(join(root, "received", `${blob.oid}.pdf`))).toEqual(Buffer.from(pdf));
    expect(log.join("\n")).toContain(`payloadKind=file_original parts=${blob.parts.length} size=${pdf.length} sha256=${sha(pdf)}`);
  });

  it("rescan and config commands round trip and are deleted on command_status done", async () => {
    const c = capture();
    expect(await runCli(["rescan", "--root", root, "--collector", "files"], { io: c.io })).toBe(0);
    expect(await runCli(["config", "--root", root, "--collector", "usage", "--enabled", "false"], { io: c.io })).toBe(0);
    const cmds = await dev.commands();
    expect(cmds.map((x) => x.record.params)).toEqual([
      { type: "rescan", collector: "files" },
      { type: "collector_config", collector: "usage", enabled: false },
    ]);
    for (const x of cmds) await dev.putRecord("command_status", { commandId: x.record.commandId, status: "done", reportedAt: iso() });
    await h.ingestOnce();
    expect(cmdKeys().filter((k) => k.startsWith("cmd/"))).toEqual([]);
    expect(readCommands(root).every((x) => x.status && x.deletedFromBucket)).toBe(true);
  });

  it("the plain `node src/cli.ts request-file` entry keeps a Windows path byte-for-byte while serve runs", async () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "request-file", "--root", root, "--path", WIN_PATH]);
    expect(stdout).toContain(`"path":${JSON.stringify(WIN_PATH)}`);
    const cmds = await dev.commands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.record.params).toEqual({ type: "file_request", path: WIN_PATH });
    await dev.putRecord("command_status", { commandId: cmds[0]!.record.commandId, status: "not_found", reportedAt: iso() });
    await h.ingestOnce();
    expect(cmdKeys()).not.toContain(cmds[0]!.key);
  });

  it("audit: no plaintext the Mac decrypted is in any bucket", async () => {
    // leave a live (still-encrypted) command in the bucket so there is ciphertext to scan
    await runCli(["request-file", "--root", root, "--path", WIN_PATH], { io: capture().io });
    const r = await auditRoot(root);
    expect(r.live).toBe(true);
    expect(r.markers).toBeGreaterThan(3);
    expect(r.report.itemsScanned).toBeGreaterThan(0);
    expect(r.summary).toContain("RESULT: PASS");
    expect(r.report.pass).toBe(true);
  });

  it("CLI usage errors", async () => {
    const c = capture();
    expect(await runCli(["request-file", "--root", root], { io: c.io })).toBe(1);
    expect(await runCli(["config", "--root", root, "--collector", "usage", "--enabled", "maybe"], { io: c.io })).toBe(1);
    expect(await runCli(["bogus", "--root", root], { io: c.io })).toBe(2);
    expect(c.text()).toContain("--path");
  });
});

describe("restart", () => {
  it("re-opens the sealed identity with the passphrase and keeps paired devices; wrong passphrase fails", async () => {
    const r2 = mkdtempSync(join(tmpdir(), "fake-mac-restart-"));
    try {
      const a = await startServe({ root: r2, passphrase: PASS, port: 0, intervalMs: 0, log: () => {} });
      const fp = a.macFingerprint;
      const firstPairing = a.pairingId;
      await a.stop();
      const identity = readFileSync(join(r2, "mac-identity.json"), "utf8");
      expect(identity).toContain('"blob"');
      await expect(startServe({ root: r2, passphrase: "wrong", port: 0, intervalMs: 0, log: () => {} })).rejects.toThrow(/passphrase/);
      const b = await startServe({ root: r2, passphrase: PASS, port: 0, intervalMs: 0, log: () => {} });
      expect(b.macFingerprint).toBe(fp);
      // the unused first code is invalidated and its bootstrap removed
      expect(b.state.pairings.find((p) => p.pairingId === firstPairing)!.status).toBe("invalidated");
      expect(b.mock.listAll("ivy-cmd-windows").map((o) => o.key)).toEqual([`pair/${b.pairingId}`]);
      await b.stop();
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });
});
