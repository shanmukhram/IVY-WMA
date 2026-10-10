/**
 * Gate G1 (PRD Part 4): the Mac side of each check, automated against the running
 * Mac service (its HTTP API and read-only views of its data directory). The bucket
 * audit and the in-flight checks run in the service with its own tokens
 * (POST /api/r2/audit, GET /api/r2/objects); `--r2 r2.json` is the fallback that
 * reads the buckets directly with the Mac's tokens. Steps only a person can do
 * (pairing on the PC, the phone hotspot, the reboot, the collector switch) are
 * prompts; their answers and times are recorded as manual steps in the report.
 * Typing `skip` at any prompt records that item as SKIP and moves on. If the run
 * is interrupted (signal or error) the report still gets everything gathered so far.
 *
 *   P        preflight: service, token, vault unlocked, R2 configured, 4 buckets reachable
 *   a        Windows and Mac pair over R2 from different networks
 *   b        a 50 MB PDF requested on the Mac arrives encrypted and intact (SHA-256 both sides)
 *   c        the bucket dump shows zero plaintext (@ivy/audit over all four buckets)
 *   d        a PC reboot mid-queue loses nothing
 *   audit    continuous check: zero-plaintext audit (buckets + the PC's queue)
 *   honesty  continuous check: a disabled collector shows on coverage within one report interval
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { runAudit, scanBuffer } from "@ivy/audit";
import type { AuditReport, ScannedItem } from "@ivy/audit";
import { ApiError, ServiceApi, health } from "./api.ts";
import type { GateIO, Step } from "./io.ts";
import { harvestVaultMarkers } from "./markers.ts";
import { compareWithService, head, host, isRealR2, listKeys, loadR2File, s3For, type BucketRef, type MacR2 } from "./r2.ts";

export type ItemId = "P" | "a" | "b" | "c" | "d" | "audit" | "honesty";
export type Status = "PASS" | "FAIL" | "SKIP" | "NOT RUN" | "INTERRUPTED";
export const G1_ITEMS: ItemId[] = ["a", "b", "c", "d"];
export const ALL_ITEMS: ItemId[] = ["a", "b", "c", "d", "audit", "honesty"];

export interface ManualStep { at: string; item: ItemId; id: string; prompt: string; answer: string }

export interface ItemResult {
  id: ItemId;
  title: string;
  criterion: string;
  status: Status;
  startedAt: string;
  finishedAt: string;
  evidence: string[];
}

export interface GateResult {
  startedAt: string;
  finishedAt: string;
  serviceUrl: string;
  serviceVersion: string | null;
  r2Endpoint: string | null;
  realR2: boolean;
  macFingerprint: string | null;
  device: { id: string; fingerprint: string } | null;
  items: ItemResult[];
  manual: ManualStep[];
  /** every G1 item (a-d) passed */
  pass: boolean;
  /** set when the run stopped early (a signal or an error): why */
  interrupted: string | null;
}

/** The operator typed `skip` at a prompt. */
export class SkipSignal extends Error {
  readonly promptId: string;
  constructor(promptId: string, message = `skipped by the operator at prompt ${promptId}`) { super(message); this.promptId = promptId; }
}

/** Every prompt says how to skip it. */
export const SKIP_HINT = "type skip";

export interface GateOptions {
  /** Mac service base URL */
  url: string;
  /** the service's data directory (session.token, vault.db, files/) */
  dataDir: string;
  /**
   * r2.json with the Mac tokens (same file as PUT /api/r2): fallback that reads the buckets
   * directly; by default the service audits them with its own tokens
   */
  r2File?: string;
  /** where pairing.txt / markers.txt go */
  workDir: string;
  /** which items to run (default all) */
  only?: ItemId[];
  /** Windows path of the test PDF (asked if missing) */
  windowsPath?: string;
  /** SHA-256 of the PDF as computed on the PC (asked if missing) */
  sha256?: string;
  /** b: the file must be at least this big (G1: 50 MB) */
  minBytes?: number;
  /** device chunk size, to tell whether the reboot interrupted a transfer (Windows default 32 MiB) */
  chunkBytes?: number;
  /** honesty: collector to switch off on the PC */
  collector?: string;
  /** the device's report interval (Windows default 5 min) */
  reportIntervalMs?: number;
  /** slack on top of the report interval for upload + ingest */
  graceMs?: number;
  /** ask the service to ingest this often while waiting (default 15 s) */
  pollEveryMs?: number;
  /** status / progress check interval (default 2 s) */
  tickMs?: number;
  /** give up waiting for a transfer or the PC after this long (default 45 min) */
  waitMs?: number;
  /** d: pause Mac ingest (POST /api/ingest/pause, the vault stays unlocked) during the reboot so the queue sits in R2 for the audit (default true) */
  hold?: boolean;
  /** d: how many marker files to create on the PC right before the reboot */
  rebootFiles?: number;
  /** d: an indexed folder on the PC (default: the folder of the test file) */
  rebootDir?: string;
  /** a: "new" pairs again; "existing" reuses the paired device; default: ask when one exists */
  pairing?: "new" | "existing";
  /** allow a non-R2 endpoint (tests against the mock) */
  allowNonR2?: boolean;
  /** write the audit markers to <workDir>/markers.txt for the PC-side queue audit */
  exportMarkers?: boolean;
}

const MB = 1_000_000;
const MIN = 60_000;
const TERMINAL = new Set(["done", "not_found", "access_denied", "too_large", "error", "expired", "cancelled"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const hhmmss = (iso = nowIso()) => iso.slice(11, 19);
const fmtBytes = (n: number | null | undefined) => (n === null || n === undefined ? "?" : n >= MB ? `${(n / MB).toFixed(1)} MB` : `${(n / 1000).toFixed(1)} kB`);
const fmtDur = (ms: number) => (ms < MIN ? `${Math.round(ms / 1000)} s` : `${(ms / MIN).toFixed(1)} min`);
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface FileInfo { id: string; path: string; name: string; size: number | null; pcSha: string }

export class Gate {
  readonly o: Required<Omit<GateOptions, "r2File" | "only" | "windowsPath" | "sha256" | "pairing" | "rebootDir">> & GateOptions;
  readonly io: GateIO;
  api!: ServiceApi;
  r2: MacR2 | null = null;
  private readonly s3 = new Map<string, S3Client>();
  private lastNudge = 0;
  private held = false;
  readonly items: ItemResult[] = [];
  readonly manual: ManualStep[] = [];
  private current: ItemResult | null = null;
  device: { id: string; fingerprint: string; pairedAt: string | null } | null = null;
  macFingerprint: string | null = null;
  serviceVersion: string | null = null;
  r2Endpoint: string | null = null;
  file: FileInfo | null = null;
  private markersCache: string[] | null = null;
  private startedAt = nowIso();
  private preflightOk = false;
  private lastLine = "";
  private pendingPrompt: string | null = null;
  private fileSkipped: string | null = null;
  private aSkipped = false;
  private finalResult: GateResult | null = null;

  constructor(o: GateOptions, io: GateIO) {
    this.o = {
      minBytes: 50 * MB, chunkBytes: 32 * 1024 * 1024, collector: "notifications", reportIntervalMs: 5 * MIN, graceMs: MIN,
      pollEveryMs: 15_000, tickMs: 2_000, waitMs: 45 * MIN, hold: true, rebootFiles: 10,
      allowNonR2: false, exportMarkers: false,
      ...stripUndefined(o),
    } as Gate["o"];
    this.io = io;
  }

  private wants(id: ItemId) { return !this.o.only || this.o.only.includes(id); }

  // ------------------------------------------------------------------ recording

  private log(line: string) {
    if (line.trim()) this.lastLine = line.trim();
    this.io.log(line);
  }

  private begin(id: ItemId, title: string, criterion: string): ItemResult {
    const r: ItemResult = { id, title, criterion, status: "FAIL", startedAt: nowIso(), finishedAt: "", evidence: [] };
    this.items.push(r);
    this.current = r;
    this.log("");
    this.log(id === "P" ? "=== Preflight" : `=== ${id.length === 1 ? `G1 (${id})` : id}: ${title}`);
    return r;
  }

  private end(r: ItemResult, status: Status): ItemResult {
    r.status = status;
    r.finishedAt = nowIso();
    this.log(`--- ${r.id}: ${status}`);
    this.current = null;
    return r;
  }

  private note(line: string) {
    this.current?.evidence.push(line);
    this.log(`  [${hhmmss()}] ${line}`);
  }

  private say(line: string) { this.log(`  [${hhmmss()}] ${line}`); }

  /**
   * A manual step. Typing `skip` throws SkipSignal (the item becomes SKIP) unless the
   * caller handles it (`skipHandled`: the answer "skip" is returned as is).
   */
  private async ask(step: Step, opts: { skipHandled?: boolean } = {}): Promise<string> {
    const text = step.text.includes(SKIP_HINT) ? step.text : `${step.text}\n(or type skip to skip this item)`;
    this.pendingPrompt = step.id;
    const answer = await this.io.ask({ ...step, text }); // on an error pendingPrompt stays set for the report
    this.pendingPrompt = null;
    this.manual.push({ at: nowIso(), item: this.current?.id ?? "P", id: step.id, prompt: text.split("\n")[0]!, answer: redactAnswer(step.id, answer) });
    if (!opts.skipHandled && isSkip(answer)) throw new SkipSignal(step.id);
    return answer;
  }

  // ------------------------------------------------------------------ helpers

  /** Ask the service to ingest now (at most every pollEveryMs); skipped while the gate holds ingest. */
  private async nudge(force = false) {
    if (this.held) return;
    if (!force && Date.now() - this.lastNudge < this.o.pollEveryMs) return;
    this.lastNudge = Date.now();
    try { await this.api.post("/api/ingest/poll", {}); } catch { /* next time */ }
  }

  private async waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, opts: { nudge?: boolean } = {}): Promise<T | null> {
    const until = Date.now() + timeoutMs;
    let lastSay = 0;
    for (;;) {
      if (opts.nudge !== false) await this.nudge();
      const v = await fn().catch((e) => { this.say(`(${what}: ${(e as Error).message})`); return null; });
      if (v) return v as T;
      if (Date.now() >= until) return null;
      if (Date.now() - lastSay > 60_000) { this.say(`waiting: ${what} (${fmtDur(until - Date.now())} left)`); lastSay = Date.now(); }
      await sleep(this.o.tickMs);
    }
  }

  private vault<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(this.o.dataDir, "vault.db"), { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  }

  private s3Of(b: BucketRef): S3Client {
    let c = this.s3.get(b.name);
    if (!c) { c = s3For(this.r2!.endpoint, b.token); this.s3.set(b.name, c); }
    return c;
  }

  private bucket(dir: "up" | "cmd", role: "windows" | "android" = "windows"): BucketRef | null {
    return this.r2?.buckets.find((b) => b.dir === dir && b.role === role) ?? null;
  }

  private markers(extra: string[] = []): string[] {
    this.markersCache ??= harvestVaultMarkers(this.o.dataDir);
    return [...new Set([...this.markersCache, ...extra.filter((m) => m && m.length >= 6)])];
  }

  /** Keys in ivy-up-windows under a prefix: directly with --r2, else through the service. */
  private async listUp(prefix: string): Promise<Array<{ key: string; size: number }>> {
    const up = this.bucket("up");
    if (up) return listKeys(this.s3Of(up), up.name, prefix);
    return (await this.api.get(`/api/r2/objects?bucket=up-windows&prefix=${encodeURIComponent(prefix)}`)).objects;
  }

  /** Scan one object in ivy-up-windows; null when it is gone (ingested meanwhile). Rules only, never plaintext. */
  private async scanUp(key: string, markers: string[]): Promise<string[] | null> {
    const up = this.bucket("up");
    if (up) {
      const buf = await head(this.s3Of(up), up.name, key);
      return buf ? scanBuffer(buf, { markers }).map((h) => redactRule(h.rule)) : null;
    }
    const r = await this.api.post("/api/r2/audit", { buckets: ["up-windows"], prefix: key, harvest: false, markers });
    if (!r.totals.objects) return null;
    return (r.hits as Array<{ key: string; rules: string[] }>).filter((h) => h.key === key).flatMap((h) => h.rules);
  }

  /** Hold the PC's queue in R2: pause Mac ingest (the vault stays unlocked). */
  private async holdIngest(): Promise<string> {
    const minutes = Math.min(24 * 60, Math.max(60, Math.ceil((2 * this.o.waitMs) / MIN)));
    const r = await this.api.post("/api/ingest/pause", { minutes });
    this.held = true;
    return r.until as string;
  }

  /** Undo the hold (also on skip, error and interruption). Never throws. */
  async release(): Promise<boolean> {
    if (!this.held || !this.api) return false;
    try {
      await Promise.race([this.api.post("/api/ingest/resume", {}), sleep(10_000).then(() => { throw new Error("timeout"); })]);
      this.held = false;
      this.say("Mac ingest resumed");
      return true;
    } catch (e) {
      this.say(`could not resume Mac ingest (${(e as Error).message}): resume it with POST /api/ingest/resume or restart the service`);
      return false;
    }
  }

  // ------------------------------------------------------------------ run

  /** Runs one item; an operator skip ends it as SKIP (and resumes ingest if it was held). */
  private async guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof SkipSignal)) throw e;
      const r = this.current;
      if (r) { this.note(`SKIP: ${e.message}`); this.end(r, "SKIP"); if (r.id === "a") this.aSkipped = true; }
      await this.release();
      return undefined;
    }
  }

  async run(): Promise<GateResult> {
    this.startedAt = nowIso();
    try {
      this.preflightOk = (await this.guarded(() => this.preflight())) ?? false;
      if (this.preflightOk) {
        if (this.wants("a")) await this.guarded(() => this.pairing());
        if (this.wants("b")) await this.guarded(() => this.retrieval());
        if (this.wants("d")) await this.guarded(() => this.reboot());
        if (this.wants("c") && !this.items.some((i) => i.id === "c")) await this.guarded(() => this.bucketAudit());
        if (this.wants("audit")) await this.guarded(() => this.continuousAudit());
        if (this.wants("honesty")) await this.guarded(() => this.honesty());
      }
    } catch (e) {
      await this.release();
      return this.result(`error: ${(e as Error).message}`);
    }
    await this.release();
    return this.result();
  }

  /**
   * The result so far. With `interrupted`, the item in progress becomes INTERRUPTED
   * (with the prompt it waited at and the last log line) and every wanted item not
   * reached is NOT RUN. Safe to call while run() is still pending (signal handler).
   */
  result(interrupted: string | null = null): GateResult {
    if (this.finalResult) return this.finalResult;
    const now = nowIso();
    if (interrupted && this.current) {
      const r = this.current;
      r.evidence.push(`INTERRUPTED (${interrupted})${this.pendingPrompt ? ` while waiting at prompt \`${this.pendingPrompt}\`` : ""}; last log line: ${this.lastLine || "(none)"}`);
      r.status = "INTERRUPTED";
      r.finishedAt = now;
      this.current = null;
    }
    for (const id of ALL_ITEMS) {
      if (this.wants(id) && !this.items.some((i) => i.id === id)) {
        const why = interrupted ? `not reached: the run was interrupted (${interrupted})` : this.preflightOk ? "not run" : "not run: preflight did not pass";
        this.items.push({ id, title: TITLES[id][0], criterion: TITLES[id][1], status: "NOT RUN", startedAt: now, finishedAt: now, evidence: [why] });
      }
    }
    for (const c of this.s3.values()) c.destroy();
    this.s3.clear();
    this.finalResult = {
      startedAt: this.startedAt, finishedAt: now, serviceUrl: this.o.url, serviceVersion: this.serviceVersion,
      r2Endpoint: this.r2Endpoint, realR2: this.r2Endpoint ? isRealR2(this.r2Endpoint) : false,
      macFingerprint: this.macFingerprint, device: this.device ? { id: this.device.id, fingerprint: this.device.fingerprint } : null,
      items: [...this.items].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)), manual: this.manual,
      pass: !interrupted && G1_ITEMS.every((id) => this.items.find((i) => i.id === id)?.status === "PASS"),
      interrupted,
    };
    return this.finalResult;
  }

  // ------------------------------------------------------------------ P

  async preflight(): Promise<boolean> {
    const r = this.begin("P", ...TITLES.P);
    const fail = (why: string) => { this.note(`FAIL: ${why}`); this.end(r, "FAIL"); return false; };
    const tokenPath = join(this.o.dataDir, "session.token");
    if (!existsSync(tokenPath)) return fail(`no session token at ${tokenPath} (is --data the service's data directory?)`);
    this.api = new ServiceApi(this.o.url, readFileSync(tokenPath, "utf8").trim());
    this.note(`data directory ${this.o.dataDir}; session token read`);
    let h;
    try { h = await health(this.o.url); } catch (e) { return fail(`service not reachable at ${this.o.url}: ${(e as Error).message}`); }
    this.serviceVersion = h.version;
    this.note(`service ${this.o.url} answers (version ${h.version}, keystore ${h.keystore})`);
    try { await this.api.get("/api/keystore"); } catch (e) { return fail(`the session token was refused: ${(e as Error).message}`); }

    let ks = await this.api.get("/api/keystore");
    if (ks.state === "uninitialized") return fail("the vault is not initialized");
    if (ks.locked) {
      await this.ask({ id: "preflight.unlock", text: "The vault is locked. Unlock it in the dashboard, then press Enter when done, or type skip (nothing else runs then)." });
      ks = (await this.waitFor("vault unlocked", async () => { const k = await this.api.get("/api/keystore"); return !k.locked && k; }, 10 * MIN, { nudge: false })) ?? ks;
      if (ks.locked) return fail("the vault stayed locked");
    }
    this.note("vault unlocked; ingest " + (ks.ingestRunning ? "running" : "not running"));

    const r2 = await this.api.get("/api/r2");
    if (!r2.configured) return fail("R2 is not configured in the service (PUT /api/r2)");
    const endpoint: string = r2.config.endpoint;
    this.r2Endpoint = endpoint;
    this.note(`R2 endpoint ${host(endpoint)}${isRealR2(endpoint) ? " (Cloudflare R2)" : " (not Cloudflare R2)"}`);
    if (!isRealR2(endpoint) && !this.o.allowNonR2) return fail("G1 runs against real R2; the service is configured for another endpoint");

    const check = await this.api.post("/api/r2/check", {});
    for (const b of check.buckets as Array<{ bucket: string; ok: boolean; status?: number; error?: string; ms: number }>) {
      this.note(`bucket ${b.bucket}: ${b.ok ? `reachable (${b.ms} ms)` : `NOT reachable: ${b.status ?? ""} ${b.error ?? ""}`}`);
    }
    if (check.buckets.length !== 4 || !check.ok) return fail("not all four buckets are reachable with the Mac's tokens");

    if (this.o.r2File) {
      try {
        this.r2 = loadR2File(this.o.r2File);
        const diff = compareWithService(this.r2, r2.config);
        if (diff.length) return fail(`${this.o.r2File} does not match the service's R2 config: ${diff.join("; ")}`);
        this.note(`${this.o.r2File}: Mac tokens match the service's config for all four buckets`);
      } catch (e) { return fail(`cannot read ${this.o.r2File}: ${(e as Error).message}`); }
    } else {
      try {
        await this.api.get("/api/r2/objects?bucket=up-windows&prefix=up%2Fblob%2F");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return fail("this service has no POST /api/r2/audit (update it, or pass --r2 r2.json)");
        return fail(`the service cannot list ivy-up-windows: ${(e as Error).message}`);
      }
      this.note("the bucket audit (c) and the in-flight checks run in the service with its own tokens (POST /api/r2/audit, GET /api/r2/objects); no r2.json needed");
    }

    const devs = await this.api.get("/api/devices");
    this.macFingerprint = devs.macFingerprint;
    this.note(`Mac fingerprint ${devs.macFingerprint}`);
    for (const d of devs.devices) this.note(`paired: ${d.role} ${d.id} fingerprint ${d.fingerprint}, paired ${d.pairedAt}, last report ${d.lastReportAt ?? "never"}`);
    if (!devs.devices.length) this.note("no paired devices yet");
    const win = (devs.devices as Array<{ id: string; role: string; fingerprint: string; pairedAt: string }>).filter((d) => d.role === "windows")
      .sort((a, b) => b.pairedAt.localeCompare(a.pairedAt))[0];
    if (win) this.device = { id: win.id, fingerprint: win.fingerprint, pairedAt: win.pairedAt };
    this.end(r, "PASS");
    return true;
  }

  // ------------------------------------------------------------------ a

  async pairing(): Promise<void> {
    const r = this.begin("a", ...TITLES.a);
    const t0 = nowIso();
    const mac = await this.ask({ id: "network.mac", text: "Which network is the Mac on right now? (for example: home Wi-Fi)\nType the answer, or type skip." });
    const pc = await this.ask({ id: "network.pc", text: "Put the PC on a DIFFERENT network, for example your phone's hotspot (Wi-Fi off on the home network).\nWhich network is the PC on now? Type the answer, or type skip." });
    const distinct = !!mac && !!pc && mac.trim().toLowerCase() !== pc.trim().toLowerCase();
    this.note(`networks (stated): Mac "${mac}", PC "${pc}"${distinct ? "" : " -- NOT different"}`);

    let mode = this.o.pairing;
    if (!mode) {
      mode = "new";
      if (this.device) {
        const a = await this.ask({ id: "pair.mode", text: `A Windows device is already paired (${this.device.id}, ${this.device.pairedAt}).\nG1 needs a pairing done across the two networks. Type "new" to pair again (unpair on the PC first), press Enter to keep the existing pairing (a is then recorded as SKIP), or type skip.` });
        mode = a.toLowerCase() === "new" ? "new" : "existing";
      }
    }

    if (mode === "existing") {
      if (!this.device) { this.note("no Windows device is paired"); this.end(r, "FAIL"); return; }
      const before = (await this.api.get(`/api/devices/${this.device.id}`)).lastReportAt as string | null;
      await this.ask({ id: "network.ready", text: "With the PC on that other network, press Enter when done, or type skip. The gate then waits for a fresh device report over R2." });
      const fresh = await this.waitFor("a device report from the PC", async () => {
        const d = await this.api.get(`/api/devices/${this.device!.id}`);
        return d.lastReportAt && d.lastReportAt !== before ? d.lastReportAt as string : null;
      }, this.o.reportIntervalMs + this.o.graceMs);
      this.note(fresh ? `device report received over R2 at ${fresh} while the PC is on "${pc}"` : "no device report arrived within one report interval");
      this.note("pairing not repeated: rerun with a new pairing for a full G1 (a)");
      this.end(r, fresh && distinct ? "SKIP" : "FAIL");
      return;
    }

    const src = await this.ask({ id: "pair.source", text: `Start a Windows pairing. Press Enter to create the pairing string here,\ntype "dashboard" if you start it in the dashboard (Devices > Pair Windows device), or type skip.` });
    let pairingId: string | null = null;
    if (src.toLowerCase() !== "dashboard") {
      const p = await this.api.post("/api/pairings", { role: "windows" });
      pairingId = p.pairingId;
      mkdirSync(this.o.workDir, { recursive: true });
      const file = join(this.o.workDir, "pairing.txt");
      writeFileSync(file, p.pairingString + "\n", { mode: 0o600 });
      this.note(`pairing ${p.pairingId} created, expires ${p.expiresAt}; string saved to ${file}`);
      this.io.log("");
      this.io.log(p.pairingString);
      await this.ask({
        id: "pair.paste", data: { pairingString: p.pairingString, pairingId: p.pairingId },
        text: `On the PC (on "${pc}"): open IVY, paste the pairing string above (also in ${file}) and press Pair.\nOnce the PC shows the two fingerprints, press Enter when done, or type skip.`,
      });
    } else {
      await this.ask({ id: "pair.paste", text: "Pair from the dashboard now and paste its string on the PC.\nOnce the PC shows the two fingerprints, press Enter when done, or type skip." });
    }
    const consumed = await this.waitFor("the device's pairing record", async () => {
      const ps = (await this.api.get("/api/pairings")).pairings as Array<{ id: string; status: string; device_id: string | null; consumed_at: string | null; created_at: string }>;
      return ps.find((p) => p.status === "consumed" && (pairingId ? p.id === pairingId : p.created_at >= t0)) ?? null;
    }, 15 * MIN);
    if (!consumed) { this.note("the Mac did not receive the device's pairing record within 15 minutes"); this.end(r, "FAIL"); return; }
    const d = await this.api.get(`/api/devices/${consumed.device_id}`);
    this.device = { id: d.id, fingerprint: d.fingerprint, pairedAt: d.pairedAt };
    this.note(`paired over R2 at ${consumed.consumed_at}: device ${d.id}`);
    this.note(`fingerprints: Mac ${this.macFingerprint}, device ${d.fingerprint}`);
    const fp = await this.ask({ id: "pair.fingerprints", text: `Does the PC show  This device = ${d.fingerprint}  and  Mac = ${this.macFingerprint} ? [y/N, or type skip]` });
    const fpOk = /^y(es)?$/i.test(fp);
    this.note(fpOk ? "fingerprints confirmed on the PC" : "fingerprints NOT confirmed on the PC");
    const report = await this.waitFor("the first device report", async () => {
      const x = await this.api.get(`/api/devices/${d.id}`);
      return x.lastReportAt as string | null;
    }, this.o.reportIntervalMs + this.o.graceMs);
    this.note(report ? `first device report over R2 at ${report}` : "no device report within one report interval after pairing");
    this.end(r, distinct && fpOk && report ? "PASS" : "FAIL");
  }

  // ------------------------------------------------------------------ b

  private async findFile(path: string): Promise<{ id: string; name: string; size: number | null } | null> {
    if (!this.device) return null;
    const want = path.toLowerCase();
    for (let page = 1; page < 1000; page++) {
      const r = await this.api.get(`/api/files?device=${encodeURIComponent(this.device.id)}&pageSize=500&page=${page}`);
      const hit = (r.items as Array<{ id: string; title: string; body: string }>).find((i) => i.body?.toLowerCase() === want);
      if (hit) {
        const size = this.vault((db) => (db.prepare("SELECT size FROM files WHERE id = ?").get(hit.id) as { size: number | null } | undefined)?.size ?? null);
        return { id: hit.id, name: hit.title, size };
      }
      if (page * 500 >= r.total) return null;
    }
    return null;
  }

  /** The test file: path and PC-side hash, located in the vault index. */
  private async ensureFile(): Promise<FileInfo | null> {
    if (this.file) return this.file;
    if (this.fileSkipped) throw new SkipSignal(this.fileSkipped, `the test file was skipped at prompt ${this.fileSkipped}`);
    if (!this.device) {
      if (this.aSkipped) throw new SkipSignal("a", "(a) was skipped and no Windows device is paired");
      this.note("no Windows device is paired");
      return null;
    }
    try { return await this.locateFile(); }
    catch (e) { if (e instanceof SkipSignal) this.fileSkipped = e.promptId; throw e; }
  }

  private async locateFile(): Promise<FileInfo | null> {
    const path = this.o.windowsPath ?? await this.ask({ id: "file.path", text: "Windows path of the ~50 MB test PDF on the PC (in an indexed folder), e.g. C:\\Users\\admin\\Desktop\\IVY-G1\\g1-50mb.pdf\nType the path, or type skip." });
    let f = await this.findFile(path);
    for (let i = 0; !f && i < 3; i++) {
      await this.ask({ id: "file.index", text: `${path} is not in the vault index yet. On the PC, add ${winDir(path)} in IVY (Indexed folders > Add folder...)\nand wait until IVY shows the scan; then press Enter when done, or type skip.` });
      f = await this.waitFor("the file in the index", () => this.findFile(path), 5 * MIN);
    }
    if (!f) { this.note(`${path} never appeared in the vault index`); return null; }
    let sha = this.o.sha256 ?? "";
    while (!/^[0-9a-f]{64}$/i.test(sha.trim())) {
      sha = await this.ask({
        id: "file.sha256", data: { path },
        text: `On the PC, in PowerShell:\n  (Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(path)}).Hash\nPaste the 64-character hash here, or type skip.`,
      });
    }
    this.file = { id: f.id, path, name: f.name, size: f.size, pcSha: sha.trim().toLowerCase() };
    this.note(`file ${f.id}: ${path} (${fmtBytes(f.size)} indexed); PC SHA-256 ${this.file.pcSha}`);
    return this.file;
  }

  /** Follow a command to a terminal status, printing progress; optionally scan blob parts caught in flight. */
  private async follow(cmdId: string, opts: { scan?: boolean; label: string }) {
    const t0 = Date.now();
    const seen = new Set<string>();
    const flight = { intercepted: 0, hits: [] as Array<{ key: string; rule: string }> };
    const scanMarkers = this.file ? [this.file.name, this.file.path] : [];
    let last = "";
    let transferringAt: number | null = null;
    const view = await this.waitFor<any>(`${opts.label} to finish`, async () => {
      const v = await this.api.get(`/api/commands/${cmdId}`);
      const p = v.progress;
      const line = `${v.status}${p ? ` parts ${p.committedParts}/${p.totalChunks ?? "?"}, ${fmtBytes(p.committedBytes)} of ${fmtBytes(p.totalSize)}` : ""}`;
      if (line !== last) { this.say(`${opts.label}: ${line}`); last = line; }
      if (transferringAt === null && (v.status === "transferring" || v.status === "uploaded")) transferringAt = Date.now();
      if (opts.scan) {
        const prefix = v.resultOid ? `up/blob/${v.resultOid}/` : "up/blob/";
        for (const o of await this.listUp(prefix).catch(() => [])) {
          if (seen.has(o.key) || !/\/p\/\d{8}$/.test(o.key)) continue;
          seen.add(o.key);
          const rules = await this.scanUp(o.key, scanMarkers).catch(() => null);
          if (!rules) continue;
          flight.intercepted++;
          for (const rule of rules) flight.hits.push({ key: o.key, rule });
        }
      }
      return TERMINAL.has(v.status) ? v : null;
    }, this.o.waitMs);
    return { view, elapsedMs: Date.now() - t0, transferringAt, flight };
  }

  /** Ledger rows of a blob: every part went through R2 as an encrypted object the Mac authenticated. */
  private blobLedger(oid: string) {
    return this.vault((db) => {
      const rows = db.prepare("SELECT kind, status, size FROM sync_objects WHERE object_key LIKE ?").all(`up/blob/${oid}/%`) as Array<{ kind: string; status: string; size: number | null }>;
      const blob = db.prepare("SELECT total_chunks, total_size, sha256, status, local_path FROM blobs WHERE oid = ? ORDER BY rid DESC").get(oid) as { total_chunks: number; total_size: number; sha256: string; status: string; local_path: string | null } | undefined;
      return {
        manifest: rows.filter((x) => x.kind === "manifest" && x.status === "committed").length,
        parts: rows.filter((x) => x.kind === "blob_chunk" && x.status === "committed").length,
        ciphertextBytes: rows.reduce((n, x) => n + (x.size ?? 0), 0),
        blob,
      };
    });
  }

  async retrieval(): Promise<void> {
    const r = this.begin("b", ...TITLES.b);
    const f = await this.ensureFile();
    if (!f) { this.end(r, "FAIL"); return; }
    const res = await this.transferAndVerify(f, "file request", { scan: true });
    this.end(r, res ? "PASS" : "FAIL");
  }

  /** Request the original (force), wait, verify hash + ledger; returns pass. */
  private async transferAndVerify(f: FileInfo, label: string, opts: { scan: boolean; cmdId?: string }): Promise<boolean> {
    let cmdId = opts.cmdId;
    if (!cmdId) {
      this.noteCached(f);
      const req = await this.api.post(`/api/files/${f.id}/request`, { force: true });
      if (!req.command) { this.note("FAIL: the service did not issue a new request"); return false; }
      cmdId = req.command.id as string;
      this.note(`requested ${f.path}: command ${cmdId} (${req.command.status}), forced (a fresh transfer from the PC, never a cached copy)`);
    }
    const t = await this.follow(cmdId, { scan: opts.scan, label });
    if (!t.view) { this.note(`${label}: no result within ${fmtDur(this.o.waitMs)}`); return false; }
    const v = t.view;
    this.note(`${label}: ${v.status}${v.detail ? ` (${v.detail})` : ""}; issued ${v.issuedAt}, sent ${v.sentAt ?? "-"}, completed ${v.completedAt ?? "-"}; ${fmtDur(t.elapsedMs)} after the gate started waiting`);
    if (v.status !== "done") return false;
    let ok = true;
    const got = await this.api.sha256Of(`/api/files/${f.id}/content`);
    const led = this.blobLedger(v.resultOid);
    this.note(`Mac SHA-256 ${got.sha256} (${fmtBytes(got.size)}, ${got.size} bytes)`);
    this.note(`PC  SHA-256 ${f.pcSha}`);
    if (led.blob) this.note(`manifest SHA-256 ${led.blob.sha256} (${led.blob.total_chunks} part(s), ${led.blob.total_size} bytes)`);
    if (got.sha256 !== f.pcSha) { this.note("FAIL: the hashes differ"); ok = false; } else this.note("hashes match: the file arrived intact");
    const servedPath = this.vault((db) => (db.prepare("SELECT local_path FROM files WHERE id = ?").get(f.id) as { local_path: string | null } | undefined)?.local_path ?? null);
    if (led.blob?.local_path && servedPath === led.blob.local_path) this.note(`the copy checked is this request's transfer (blob ${v.resultOid})`);
    else { this.note(`FAIL: the vault's copy of the file is not this request's transfer (blob ${v.resultOid})`); ok = false; }
    if (got.size < this.o.minBytes) { this.note(`FAIL: ${got.size} bytes is smaller than the ${fmtBytes(this.o.minBytes)} G1 asks for`); ok = false; }
    if (!/\.pdf$/i.test(f.path)) this.note("note: the test file is not a .pdf");
    const allParts = led.blob && led.parts === led.blob.total_chunks && led.manifest === 1;
    this.note(`encrypted in transit: manifest + ${led.parts} part object(s), ${fmtBytes(led.ciphertextBytes)} of ciphertext, each authenticated (AES-GCM) and committed through the ingest ledger`);
    if (!allParts) { this.note("FAIL: the ledger does not hold every part of the blob"); ok = false; }
    if (opts.scan) {
      this.note(`in-flight check: ${t.flight.intercepted} part object(s) caught in R2 before the Mac ingested them, ${t.flight.hits.length} plaintext hit(s)`);
      for (const h of t.flight.hits.slice(0, 10)) this.note(`  hit in ${h.key}: ${h.rule}`);
      if (t.flight.hits.length) ok = false;
    }
    if (t.transferringAt !== null) this.note(`retrieval metric (PRD: 50 MB within 5 min on broadband): ${fmtDur(t.elapsedMs)} total`);
    return ok;
  }

  /** Item 6 of the first real run: say when the vault already holds a copy from an earlier run. */
  private noteCached(f: FileInfo) {
    const row = this.vault((db) => db.prepare("SELECT status, local_path, original_blob_oid FROM files WHERE id = ?").get(f.id) as { status: string; local_path: string | null; original_blob_oid: string | null } | undefined);
    if (row?.status === "cached" && row.local_path) {
      this.note(`the vault already holds a copy of ${f.name} from an earlier retrieval: the request is forced, so the PC sends the file again and every check below uses this run's transfer`);
    }
  }

  // ------------------------------------------------------------------ d (+ c while held)

  /** d, with c inside it while Mac ingest is paused (the PC's queue then sits in R2). */
  async reboot(): Promise<void> {
    const r = this.begin("d", ...TITLES.d);
    const t0 = nowIso();
    const f = await this.ensureFile();
    if (!f) { this.end(r, "FAIL"); return; }
    const token = `ivyg1${randomBytes(4).toString("hex")}`;
    const n = this.o.rebootFiles;
    const dir = this.o.rebootDir ?? winDir(f.path);
    const ps = markerCommand(dir, token, n);
    await this.ask({
      id: "reboot.prepare", data: { token, count: n, dir },
      text: `Reboot test. On the PC, make sure ${dir} is an indexed folder in IVY (Indexed folders > Add folder...).\nKeep the PC on its network. Press Enter when done, or type skip. The gate then requests ${f.name} again and the PC starts uploading it.`,
    });
    this.noteCached(f);
    const req = await this.api.post(`/api/files/${f.id}/request`, { force: true });
    const cmdId = req.command.id as string;
    this.note(`requested ${f.path} again (forced): command ${cmdId}; marker token ${token} (${n} files in ${dir})`);
    const hold = this.o.hold;
    const expectedParts = f.size ? Math.max(1, Math.ceil(f.size / this.o.chunkBytes)) : null;
    const partsInR2 = async () => (await this.listUp("up/blob/")).filter((o) => /\/p\/\d{8}$/.test(o.key)).map((o) => o.key);
    let baseline = new Set<string>();
    if (hold) {
      baseline = new Set(await partsInR2());
      const until = await this.holdIngest();
      this.note(`Mac ingest paused until ${until} (POST /api/ingest/pause; the vault stays unlocked): the PC's uploads stay in R2 until the gate resumes it`);
    }
    const started = await this.waitFor("the PC to start uploading the file", async () => {
      if (hold) { const now = (await partsInR2()).filter((k) => !baseline.has(k)); return now.length ? now : null; }
      const v = await this.api.get(`/api/commands/${cmdId}`);
      return v.status === "transferring" ? [v.status] : null;
    }, 15 * MIN);
    this.note(started ? (hold ? `the PC is uploading: ${started.length} new part object(s) in R2` : "the PC is uploading (command transferring)") : "no upload seen yet; continuing");

    await this.ask({
      id: "reboot.now", data: { token, count: n, dir, commandId: cmdId, command: ps },
      text: `Now, on the PC:\n  1. In PowerShell run (creates ${n} small files in ${dir}):\n     ${ps}\n  2. Within a few seconds, restart the PC: Start > Power > Restart. Do not wait for IVY's upload to finish.\nRight after you click Restart, press Enter when done, or type skip.`,
    });
    const rebootAt = nowIso();
    let midQueue: boolean | null = null;
    if (hold && expectedParts !== null) {
      const present = (await partsInR2()).filter((k) => !baseline.has(k)).length;
      midQueue = present < expectedParts;
      this.note(`at the reboot (${rebootAt}): ${present} of ${expectedParts} part object(s) of the file in R2 -> ${midQueue ? "the reboot interrupted the transfer" : "the upload had already finished"}`);
    } else if (!hold) {
      const v = await this.api.get(`/api/commands/${cmdId}`);
      midQueue = v.status !== "done";
      this.note(`at the reboot (${rebootAt}): command ${v.status}${v.progress ? `, parts ${v.progress.committedParts}/${v.progress.totalChunks ?? "?"}` : ""}`);
    }
    await this.ask({ id: "reboot.back", text: "Wait for the PC to restart and sign in. IVY starts in the tray by itself (run at login).\nOpen it and wait until the Queue shows 0 pending objects; then press Enter when done, or type skip." });
    this.note(`PC back (stated) at ${nowIso()}`);

    if (hold) {
      if (this.wants("c")) {
        await this.holdIngest(); // refresh the pause: the reboot may have taken a while
        await this.bucketAudit(r, [token, `IVY G1 reboot test ${token}`]);
        this.current = r;
      }
      await this.release();
      this.note("Mac ingest resumed; ingesting what the PC queued");
      await this.api.post("/api/ingest/poll", { full: true }).catch(() => undefined);
    }

    const fileOk = await this.transferAndVerify(f, "file request (after reboot)", { scan: false, cmdId });
    const names = await this.waitFor(`${n} marker files in the vault`, async () => {
      const rows = this.vault((db) => db.prepare("SELECT DISTINCT name FROM files WHERE name LIKE ? AND deleted_at IS NULL").all(`${token}-%`) as Array<{ name: string }>);
      return rows.length >= n ? rows : null;
    }, this.o.reportIntervalMs + this.o.graceMs + 5 * MIN);
    const got = names?.length ?? this.vault((db) => (db.prepare("SELECT COUNT(DISTINCT name) AS n FROM files WHERE name LIKE ?").get(`${token}-%`) as { n: number }).n);
    this.note(`${got} of ${n} marker files created right before the reboot are in the vault`);
    const quarantined = this.vault((db) => (db.prepare("SELECT COUNT(*) AS n FROM quarantine WHERE created_at >= ?").get(t0) as { n: number }).n);
    this.note(`${quarantined} object(s) quarantined during the test`);
    if (midQueue === false) this.note("FAIL: the reboot did not interrupt the transfer; repeat with a slower link or a bigger file, and reboot sooner");
    if (midQueue === null) this.note("whether the reboot interrupted the transfer could not be measured");
    this.end(r, fileOk && got >= n && quarantined === 0 && midQueue !== false ? "PASS" : "FAIL");
  }

  // ------------------------------------------------------------------ c

  private auditResult: { objects: number; hits: number; at: string } | null = null;

  /** c. When `parent` is given it runs inside d (while ingest is paused) and is recorded as its own item. */
  async bucketAudit(parent?: ItemResult, extraMarkers: string[] = []): Promise<void> {
    const r = this.begin("c", ...TITLES.c);
    const extra = [this.file?.path ?? "", this.file?.name ?? "", ...extraMarkers].filter((m) => m.length >= 6);
    if (parent) this.note("running while Mac ingest is held, so the PC's queue is in the buckets");
    if (this.o.exportMarkers) {
      const markers = this.markers(extra);
      mkdirSync(this.o.workDir, { recursive: true });
      const p = join(this.o.workDir, "markers.txt");
      writeFileSync(p, "# IVY audit markers: plaintext from your vault. Delete after use.\n" + markers.join("\n") + "\n", { mode: 0o600 });
      this.note(`${markers.length} marker(s) written to ${p} (0600) for the PC-side queue audit; delete it afterwards`);
    }
    let summary: { pass: boolean; objects: number; bytes: number; hits: number };
    if (this.r2) summary = await this.auditDirect(extra);
    else summary = await this.auditInService(extra);
    this.auditResult = { objects: summary.objects, hits: summary.hits, at: nowIso() };
    if (summary.objects === 0) { this.note("the buckets were empty: nothing to audit (run d with the hold so the PC's queue is in R2)"); this.end(r, "SKIP"); return; }
    this.note(`RESULT: ${summary.pass ? "PASS" : "FAIL"} (${summary.hits} hit(s) in ${summary.objects} object(s), ${fmtBytes(summary.bytes)})`);
    this.end(r, summary.pass ? "PASS" : "FAIL");
  }

  /** The default: the service audits the four buckets with its own in-memory tokens. */
  private async auditInService(extra: string[]) {
    const rep = await this.api.post("/api/r2/audit", { markers: extra });
    this.note(`audited by the service (POST /api/r2/audit) with its own tokens; ${rep.markers.total} plaintext marker(s): ${rep.markers.harvested} harvested from the vault (paths, names, document text, titles, notification, message and OCR text, retrieved originals) + ${rep.markers.fromRequest} from the gate`);
    for (const b of rep.buckets as Array<{ bucket: string; objects: number; bytesScanned: number; sampled: number; hits: number; unreadable: number; vanished: number; error?: string }>) {
      this.note(`${b.bucket}: ${b.objects} object(s), ${fmtBytes(b.bytesScanned)} read (${b.sampled} large object(s) sampled), ${b.hits} hit(s)${b.unreadable ? `, ${b.unreadable} unreadable` : ""}${b.vanished ? `, ${b.vanished} gone before they were read` : ""}${b.error ? `, error: ${b.error}` : ""}`);
    }
    for (const h of (rep.hits as Array<{ bucket: string; key: string; rules: string[] }>).slice(0, 20)) this.note(`  ${h.bucket}/${h.key}: ${h.rules.join(", ")}`);
    for (const u of (rep.unreadable as Array<{ bucket: string; key: string; error: string }>).slice(0, 20)) this.note(`  ${u.bucket}/${u.key}: unreadable: ${u.error}`);
    if (rep.totals.exemptedBootstrapRuns) this.note(`${rep.totals.exemptedBootstrapRuns} printable-run hit(s) in a pending pairing bootstrap pair/<id> exempted (sealed JSON by spec)`);
    return { pass: !!rep.pass, objects: rep.totals.objects as number, bytes: rep.totals.bytesScanned as number, hits: rep.totals.hits as number };
  }

  /** The --r2 fallback: read the buckets directly with the Mac's tokens from r2.json. */
  private async auditDirect(extra: string[]) {
    const markers = this.markers(extra);
    this.note(`audited by the gate with the Mac's tokens from ${this.o.r2File}; ${markers.length} plaintext marker(s) harvested from the vault (paths, names, document text, titles, notification and OCR text, retrieved originals)`);
    const reports: AuditReport[] = [];
    for (const b of this.r2!.buckets) {
      const i = b.token.indexOf(":");
      const rep = exemptBootstrap(await runAudit({ buckets: [b.name], s3: { endpoint: this.r2!.endpoint, accessKeyId: b.token.slice(0, i), secretAccessKey: b.token.slice(i + 1) }, markers, skipVanished: true }));
      reports.push(rep);
      this.note(`${b.name}: ${rep.itemsScanned} object(s), ${fmtBytes(rep.bytesScanned)} read (${rep.sampledItems} large object(s) sampled), ${rep.totalHits} hit(s)`);
    }
    const merged = mergeReports(reports);
    for (const it of merged.items.filter((x) => x.hits.length || x.error).slice(0, 20)) {
      this.note(`  ${it.name}: ${it.error ? `unreadable: ${it.error}` : it.hits.map((h) => redactRule(h.rule)).join(", ")}`);
    }
    for (const e of merged.errors) this.note(`  error: ${e}`);
    return { pass: merged.pass, objects: merged.itemsScanned, bytes: merged.bytesScanned, hits: merged.totalHits };
  }

  // ------------------------------------------------------------------ continuous: audit

  async continuousAudit(): Promise<void> {
    const r = this.begin("audit", ...TITLES.audit);
    const c = this.items.find((i) => i.id === "c");
    if (!this.auditResult && !c) {
      // the bucket half of the audit, standalone
      await this.bucketAudit();
      this.current = r;
    }
    const cStatus = this.items.find((i) => i.id === "c")?.status;
    const bucketStatus = cStatus === "PASS" || cStatus === "FAIL" ? cStatus : "SKIP";
    this.note(`buckets: ${bucketStatus}${this.auditResult ? ` (${this.auditResult.objects} object(s), ${this.auditResult.hits} hit(s), at ${this.auditResult.at})` : ""}`);
    const ans = await this.ask({
      id: "audit.pc",
      text: "Device queue, on the PC (PRD: dump both device queues). Run the gate with --export-markers, copy markers.txt to the PC, then in PowerShell at the repo:\n" +
        "  pnpm --filter @ivy/audit audit --sqlite \"$env:LOCALAPPDATA\\IVY\\vault-agent.db\" --dir \"$env:LOCALAPPDATA\\IVY\\queue\" --markers markers.txt\n" +
        "Type PASS or FAIL as the audit printed it; press Enter or type skip if you did not run it.",
    }, { skipHandled: true });
    const pc = /^pass$/i.test(ans) ? "PASS" : /^fail$/i.test(ans) ? "FAIL" : "SKIP";
    this.note(`PC queue (vault-agent.db + queue/): ${pc === "SKIP" ? "not audited" : pc} (manual)`);
    const status: Status = bucketStatus === "FAIL" || pc === "FAIL" ? "FAIL" : bucketStatus === "PASS" && pc === "PASS" ? "PASS" : bucketStatus === "PASS" ? "PASS" : "SKIP";
    if (status === "PASS" && pc === "SKIP") this.note("buckets only: the PC queue was not audited in this run");
    this.end(r, status);
  }

  // ------------------------------------------------------------------ continuous: honesty

  async honesty(): Promise<void> {
    const r = this.begin("honesty", ...TITLES.honesty);
    if (!this.device) {
      if (this.aSkipped) throw new SkipSignal("a", "(a) was skipped and no Windows device is paired");
      this.note("no Windows device is paired"); this.end(r, "FAIL"); return;
    }
    const name = this.o.collector;
    const col = async () => {
      const cov = await this.api.get("/api/coverage");
      const d = (cov.devices as Array<any>).find((x) => x.deviceId === this.device!.id);
      return { c: d?.collectors?.find((x: any) => x.name === name) as any, gaps: (d?.gaps ?? []) as Array<any> };
    };
    const first = await col();
    if (!first.c) { this.note(`the device reports no "${name}" collector`); this.end(r, "FAIL"); return; }
    this.note(`${name} before: enabled=${first.c.enabled}, status ${first.c.status} (${first.c.statusReason})`);
    if (!first.c.enabled) { this.note(`${name} is already off: turn it on first`); this.end(r, "FAIL"); return; }
    const deadline = this.o.reportIntervalMs + this.o.graceMs;
    await this.ask({ id: "honesty.disable", data: { collector: name }, text: `In the IVY window on the PC, switch the "${name}" collector row OFF.\nPress Enter at the moment you switch it off, or type skip.` });
    const off0 = Date.now();
    const offAt = nowIso();
    const seen = await this.waitFor(`coverage to show ${name} off`, async () => {
      const x = await col();
      const gap = x.gaps.find((g) => g.collector === name && g.reason === "disabled" && g.open);
      return x.c && !x.c.enabled && x.c.status === "off" && gap ? { c: x.c, gap } : null;
    }, 2 * deadline);
    const latency = Date.now() - off0;
    let ok = false;
    if (!seen) this.note(`coverage did not show ${name} as off within ${fmtDur(2 * deadline)}`);
    else {
      ok = latency <= deadline;
      this.note(`coverage shows ${name} off ("${seen.c.statusReason}") with an open "disabled" gap from ${seen.gap.from}, ${fmtDur(latency)} after the switch (limit: one report interval ${fmtDur(this.o.reportIntervalMs)} + ${fmtDur(this.o.graceMs)})`);
      const tl = await this.api.get(`/api/timeline?from=${encodeURIComponent(new Date(off0 - 3600_000).toISOString())}&to=${encodeURIComponent(nowIso())}&device=${encodeURIComponent(this.device.id)}`).catch(() => null);
      const tgap = (tl?.gaps as Array<any> | undefined)?.find((g) => g.collector === name && g.reason === "disabled");
      this.note(tgap ? `the timeline shows the missing period (${tgap.from} -> ${tgap.to})` : "FAIL: the timeline does not show the missing period");
      if (!tgap) ok = false;
    }
    await this.ask({ id: "honesty.enable", data: { collector: name }, text: `Switch "${name}" back ON in IVY on the PC, then press Enter when done, or type skip.` });
    const on0 = Date.now();
    const back = await this.waitFor(`coverage to show ${name} on again`, async () => { const x = await col(); return x.c?.enabled ? x.c : null; }, 2 * deadline);
    this.note(back ? `coverage shows ${name} enabled again after ${fmtDur(Date.now() - on0)} (gap closed: off since ${offAt})` : `FAIL: coverage still shows ${name} off`);
    if (!back) ok = false;
    this.end(r, ok ? "PASS" : "FAIL");
  }
}

// ------------------------------------------------------------------ helpers

const ORDER: ItemId[] = ["P", "a", "b", "c", "d", "audit", "honesty"];

export const TITLES: Record<ItemId, [string, string]> = {
  P: ["Preflight", "service reachable with the session token, vault unlocked, R2 configured, all four buckets reachable"],
  a: ["Pairing over R2 from different networks", "Windows and Mac pair over R2 from different networks (phone hotspot on one side)"],
  b: ["50 MB PDF retrieval", "a 50 MB PDF requested on the Mac arrives encrypted and intact (SHA-256 equal on both sides)"],
  c: ["Bucket dump: zero plaintext", "the bucket dump shows zero plaintext (all four buckets)"],
  d: ["PC reboot mid-queue", "a PC reboot mid-queue loses nothing"],
  audit: ["Zero-plaintext audit (continuous)", "nothing readable in any bucket or device queue"],
  honesty: ["Honesty test (continuous)", "a disabled Windows collector shows on the coverage page within one report interval"],
};

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Marker hits name the marker; keep only its length in reports. */
export function redactRule(rule: string): string {
  const m = /^(marker(?:-utf16)?):(.*)$/.exec(rule);
  return m ? `${m[1]} (${m[2]!.length} chars)` : rule;
}

const isSkip = (a: string) => a.trim().toLowerCase() === "skip";

/** The folder of a Windows path (C:\\Users\\admin\\Desktop\\IVY-G1\\g1-50mb.pdf -> C:\\Users\\admin\\Desktop\\IVY-G1). */
export function winDir(path: string): string {
  return win32.dirname(path);
}

/**
 * The PowerShell line for d: n small files in `dir`, which already exists (it holds the
 * test file). Only Set-Content writes into the folder (no New-Item), which Controlled
 * Folder Access allows for PowerShell on the Desktop and in Documents.
 */
export function markerCommand(dir: string, token: string, n: number): string {
  const d = /%[^%]+%/.test(dir) ? `[Environment]::ExpandEnvironmentVariables(${psQuote(dir)})` : psQuote(dir);
  return `$d = ${d}; 1..${n} | ForEach-Object { Set-Content -LiteralPath (Join-Path $d "${token}-$_.txt") -Value "IVY G1 reboot test ${token} $_" }`;
}

function redactAnswer(id: string, a: string): string {
  return id === "file.sha256" ? a.trim().toLowerCase() : a.slice(0, 200);
}

/**
 * A pending pairing bootstrap `pair/<id>` in a cmd-bucket is a sealed JSON
 * container `{v, nonce, ct}` by spec (PROTOCOL §7), printable by nature: its
 * printable-run hits are dropped; marker and magic hits still count.
 */
export function exemptBootstrap(r: AuditReport): AuditReport {
  const items = r.items.map((i) =>
    /^[^/]+\/pair\/[0-9a-f]+$/.test(i.name) && !/^[^/]+\/pair\/[0-9a-f]+\/device$/.test(i.name)
      ? { ...i, hits: i.hits.filter((h) => !h.rule.startsWith("printable-run")) } : i);
  const totalHits = items.reduce((n, i) => n + i.hits.length, 0);
  return { ...r, items, totalHits, pass: totalHits === 0 && r.errors.length === 0 && items.every((i) => !i.error) };
}

export function mergeReports(rs: AuditReport[]): AuditReport {
  const items: ScannedItem[] = rs.flatMap((r) => r.items);
  const sum = (f: (r: AuditReport) => number) => rs.reduce((n, r) => n + f(r), 0);
  return {
    generatedAt: nowIso(),
    pass: rs.every((r) => r.pass),
    totalHits: sum((r) => r.totalHits),
    itemsScanned: sum((r) => r.itemsScanned),
    bytesScanned: sum((r) => r.bytesScanned),
    fullItems: sum((r) => r.fullItems),
    fullBytes: sum((r) => r.fullBytes),
    sampledItems: sum((r) => r.sampledItems),
    sampledBytes: sum((r) => r.sampledBytes),
    sampling: rs[0]?.sampling ?? { sizeThreshold: 0, windowsPerSample: 0, windowSize: 0 },
    items,
    errors: rs.flatMap((r) => r.errors),
  };
}

export { ApiError };
