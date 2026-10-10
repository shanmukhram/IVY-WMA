/**
 * The Windows app as the gate sees it, on the wire only: a SimDevice (from the Mac
 * service's tests, built on @ivy/protocol and the pairing string's tokens) that
 * reports its collectors, answers file requests with an encrypted chunked upload,
 * and can "reboot" in the middle of one (the rest of its queue goes up after restart).
 */
import { decryptEnvelope, fromUtf8, validateRecordKind } from "@ivy/protocol";
import type { CommandRecordT } from "@ivy/protocol";
import { SimDevice, iso } from "../../../mac/service/test/helpers/device.ts";

type Put = () => Promise<unknown>;

export class SimWindows {
  readonly dev: SimDevice;
  readonly files = new Map<string, Uint8Array>();
  readonly collectors = new Map<string, boolean>([["files", true], ["screenshots", true], ["usage", true], ["notifications", true]]);
  chunk = 64 * 1024;
  /** stop uploading a transfer after this many parts (a reboot mid-queue) */
  stallAfterParts: number | null = null;
  private handled = new Set<string>();
  private queue: Put[] = [];
  private down = false;
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(pairingString: string) { this.dev = new SimDevice(pairingString); }

  get deviceId() { return this.dev.deviceId; }
  get fingerprint() { return this.dev.fingerprint; }

  async pair() { await this.dev.pair(); }

  start(reportMs = 500) {
    this.down = false;
    this.timers.push(setInterval(() => { void this.report(); }, reportMs));
    this.timers.push(setInterval(() => { void this.tick(); }, 100));
  }

  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  report() {
    if (this.down) return Promise.resolve();
    const at = iso();
    return this.dev.report([...this.collectors].map(([name, enabled]) => ({ name, enabled, lastRunAt: enabled ? at : undefined }))).catch(() => undefined);
  }

  async setEnabled(name: string, enabled: boolean) { this.collectors.set(name, enabled); await this.report(); }

  /** reboot: nothing leaves the PC until restart() */
  crash() { this.down = true; this.stop(); }

  /** after the reboot: the queue drains (resumed transfer, files captured before the reboot), then normal work */
  async restart() {
    while (this.busy) await new Promise((r) => setTimeout(r, 20)); // the process that went down is finished
    this.down = false;
    const q = this.queue; this.queue = [];
    for (const p of q) await p();
    this.start();
  }

  /** files created right before the reboot: captured, but still in the queue when the PC goes down */
  queueFiles(token: string, n: number, dir = "C:\\Users\\bunny\\Documents\\IVY-G1") {
    for (let i = 1; i <= n; i++) {
      const name = `${token}-${i}.txt`;
      this.queue.push(() => this.dev.put("file_meta", { path: `${dir}\\${name}`, name, ext: "txt", size: 30, mtime: iso(), quickHash: `q${i}` }));
    }
  }

  private async tick() {
    if (this.down || this.busy) return;
    this.busy = true;
    try {
      for (const { key } of await this.dev.cmd.list("cmd/")) {
        if (this.handled.has(key) || this.down) continue;
        this.handled.add(key);
        const env = (await this.dev.cmd.get(key))!;
        const { plaintext } = decryptEnvelope({ recipientSecretKey: this.dev.keys.secretKey, objectKey: key, envelope: env, expectedKind: "command" });
        const rec = validateRecordKind("command", JSON.parse(fromUtf8(plaintext))) as CommandRecordT;
        if (rec.params.type === "file_request") await this.serve(rec);
        else await this.dev.put("command_status", { commandId: rec.commandId, status: "done", reportedAt: iso() });
      }
    } catch { /* next tick */ } finally { this.busy = false; }
  }

  private async serve(rec: CommandRecordT) {
    const p = rec.params as { path: string };
    const bytes = this.files.get(p.path);
    if (!bytes) { await this.dev.put("command_status", { commandId: rec.commandId, status: "not_found", reportedAt: iso() }); return; }
    const b = this.dev.blob(bytes, "file_original", this.chunk, { commandId: rec.commandId });
    const puts: Put[] = [() => this.dev.up.put(b.manifest.key, b.manifest.bytes)];
    for (const part of b.parts) puts.push(() => this.dev.up.put(part.key, part.bytes));
    puts.push(() => this.dev.put("command_status", { commandId: rec.commandId, status: "uploaded", resultOid: b.oid, reportedAt: iso() }));
    const stall = this.stallAfterParts;
    this.stallAfterParts = null;
    for (let i = 0; i < puts.length; i++) {
      // a reboot (or the stall: manifest + `stall` parts made it out): the rest stays in the queue
      if (this.down || (stall !== null && i > stall)) { this.queue.push(...puts.slice(i)); return; }
      await puts[i]!();
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  close() { this.stop(); this.dev.close(); }
}
