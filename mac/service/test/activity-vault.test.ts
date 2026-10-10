/** Activity Vault read-only import (PRD S7) against generated fixture archives. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeService, tempDir, rm, api, PASS } from "./helpers/harness.ts";
import type { Service } from "../src/service.ts";
import { LocalArchiveSource, normTime, runActivityVaultImport, McpActivityVaultSource, startActivityVaultSchedule, lastRuns } from "../src/imports/activity-vault.ts";

const DAY_MS = 86400_000;
const p2 = (n: number) => String(n).padStart(2, "0");
const localDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
/** local noon of the day `n` days ago */
const noon = (n: number) => { const d = new Date(Date.now() - n * DAY_MS); d.setHours(12, 0, 0, 0); return d; };
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

let svc: Service;
let dir: string;
let fx: string;
let sqlitePath: string;

/** Fixture: rows on days 1, 2, 5, 6 ago (none on 3 and 4); the source reports day 3 as a capture gap and day 4 as healthy. */
function makeSqliteArchive(path: string) {
  const db = new Database(path);
  db.exec(`CREATE TABLE activity (id TEXT PRIMARY KEY, time TEXT, product TEXT, title TEXT, subtitle TEXT, link TEXT);
           CREATE TABLE capture_status (date TEXT, status TEXT, note TEXT);
           CREATE TABLE unrelated (x INTEGER);`);
  const ins = db.prepare("INSERT INTO activity VALUES (?, ?, ?, ?, ?, ?)");
  ins.run("yt-1", noon(1).toISOString(), "YouTube", "Watched How flamingos stand on one leg", "Nature Channel", "https://www.youtube.com/watch?v=abc");
  ins.run("s-1", noon(1).toISOString(), "Search", "Searched for kyoto robotics invoice", null, "https://www.google.com/search?q=kyoto+robotics");
  ins.run("m-1", String(noon(2).getTime() * 1000), "Maps", "Viewed Kyoto Station", null, null); // epoch microseconds
  ins.run("p-1", noon(5).toISOString(), "Play Store", "Installed Flamingo Notes", null, null);
  ins.run("bad", "not a time", "Search", "row without a usable time", null, null);
  ins.run("y-2", noon(6).toISOString(), "YouTube", "Watched flamingo documentary", null, "https://www.youtube.com/watch?v=def");
  const st = db.prepare("INSERT INTO capture_status VALUES (?, ?, ?)");
  st.run(localDate(noon(3).getTime()), "gap", "extension was disabled");
  st.run(localDate(noon(4).getTime()), "healthy", null);
  db.close();
}

beforeAll(async () => {
  dir = tempDir();
  fx = tempDir("ivy-avfx-");
  sqlitePath = join(fx, "activity.sqlite");
  makeSqliteArchive(sqlitePath);
  svc = await makeService(dir);
  await svc.ctx.keystore.initialize(PASS);
});
afterAll(async () => { await svc.close(); rm(dir); rm(fx); });

describe("normalisation", () => {
  it("accepts ISO and epoch s/ms/µs and never invents a time", () => {
    expect(normTime("2026-10-01T10:00:00Z")).toBe("2026-10-01T10:00:00.000Z");
    expect(normTime(1759312800)).toBe("2025-10-01T10:00:00.000Z");
    expect(normTime(1759312800000)).toBe("2025-10-01T10:00:00.000Z");
    expect(normTime("1759312800000000")).toBe("2025-10-01T10:00:00.000Z");
    expect(normTime("yesterday-ish")).toBeNull();
    expect(normTime(null)).toBeNull();
  });
});

describe("local archive import", () => {
  it("is off until configured; the coverage row says so", async () => {
    const c = await api(svc, "GET", "/api/coverage");
    expect(c.json.imports[0]).toMatchObject({ name: "Activity Vault import", enabled: false, status: "off" });
    const r = await api(svc, "POST", "/api/imports/activity-vault/run");
    expect(r.json).toMatchObject({ status: "error" });
    expect(r.json.error).toMatch(/path/);
  });

  it("detects the archive, imports rows read-only, and is idempotent", async () => {
    const before = { sha: sha(sqlitePath), mtime: statSync(sqlitePath).mtimeMs, files: readdirSync(fx).sort() };
    expect((await api(svc, "PUT", "/api/imports/activity-vault/settings", { enabled: true, path: fx })).json.settings).toMatchObject({ enabled: true, path: fx, adapter: "local" });
    const st = await api(svc, "GET", "/api/imports/activity-vault");
    expect(st.json.detected).toMatchObject({ format: "sqlite", table: "activity", columns: { time: "time", product: "product", title: "title", link: "link", id: "id" } });

    const r = await api(svc, "POST", "/api/imports/activity-vault/run");
    expect(r.json).toMatchObject({ status: "ok", trigger: "manual", rowsSeen: 6, rowsAdded: 5, rowsSkipped: 1 });
    expect(r.json.captureStatus.days).toHaveLength(2);
    const again = await api(svc, "POST", "/api/imports/activity-vault/run");
    expect(again.json).toMatchObject({ status: "ok", rowsAdded: 0 });
    // the source was never written
    expect({ sha: sha(sqlitePath), mtime: statSync(sqlitePath).mtimeMs, files: readdirSync(fx).sort() }).toEqual(before);
  });

  it("imported rows are type browsing in search and on the timeline", async () => {
    const s = await api(svc, "GET", "/api/search?q=flamingo");
    expect(s.json.counts.browsing.exact).toBe(3);
    const yt = s.json.items.find((i: { title: string }) => i.title === "Watched How flamingos stand on one leg");
    expect(yt).toMatchObject({ type: "browsing", app: "YouTube", timeField: "time", deviceId: null, detail: { product: "YouTube", link: "https://www.youtube.com/watch?v=abc", source: "activity_vault" } });
    expect((await api(svc, "GET", "/api/search?q=flamingo&app=youtube")).json.exactTotal).toBe(2);
    expect((await api(svc, "GET", "/api/search?q=flamingo&type=browsing")).json.exactTotal).toBe(3);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const t = await api(svc, "GET", `/api/timeline?date=${localDate(noon(2).getTime())}&tz=${encodeURIComponent(tz)}`);
    expect(t.json.items.map((i: { type: string; title: string }) => `${i.type}:${i.title}`)).toEqual(["browsing:Viewed Kyoto Station"]);
    expect((await api(svc, "GET", `/api/items/browsing/${yt.id}`)).json.title).toBe("Watched How flamingos stand on one leg");
  });

  it("coverage: a day without rows is a gap only when the source said so, otherwise unknown", async () => {
    const c = (await api(svc, "GET", "/api/coverage")).json;
    const row = c.imports[0];
    expect(row).toMatchObject({ enabled: true, status: "green", rowsTotal: 5, lastRunStatus: "ok", lastRowsAdded: 0 });
    const byDate = Object.fromEntries(row.gaps.map((g: { date: string }) => [g.date, g]));
    expect(byDate[localDate(noon(3).getTime())]).toMatchObject({ state: "gap", rows: 0 });
    expect(byDate[localDate(noon(3).getTime())].note).toMatch(/extension was disabled/);
    expect(byDate[localDate(noon(4).getTime())]).toMatchObject({ state: "unknown", rows: 0 });
    expect(byDate[localDate(noon(4).getTime())].note).toMatch(/reported capture healthy/);
    for (const n of [1, 2, 5, 6]) expect(byDate[localDate(noon(n).getTime())]).toBeUndefined();
    expect(byDate[localDate(noon(10).getTime())]).toBeUndefined(); // before the archive starts: not claimed either way
  });

  it("deleted rows are not re-imported, including after a permanent delete", async () => {
    const s = await api(svc, "GET", "/api/search?q=documentary");
    const id = s.json.items[0].id;
    await api(svc, "DELETE", `/api/items/browsing/${id}`);
    expect((await api(svc, "POST", "/api/imports/activity-vault/run")).json.rowsAdded).toBe(0);
    expect((await api(svc, "GET", "/api/bin")).json.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: "browsing", id })]));
    await api(svc, "DELETE", `/api/bin/browsing/${id}`);
    const r = await api(svc, "POST", "/api/imports/activity-vault/run");
    expect(r.json).toMatchObject({ rowsAdded: 0, rowsSkipped: 2 }); // the tombstoned row and the row without a time
    expect((await api(svc, "GET", "/api/search?q=documentary")).json.total).toBe(0);
  });

  it("a failing source is a red coverage row and a named problem", async () => {
    await api(svc, "PUT", "/api/imports/activity-vault/settings", { path: join(fx, "missing.sqlite") });
    const r = await api(svc, "POST", "/api/imports/activity-vault/run");
    expect(r.json.status).toBe("error");
    const c = (await api(svc, "GET", "/api/coverage")).json;
    expect(c.imports[0]).toMatchObject({ status: "red" });
    expect(c.problems.map((p: { message: string }) => p.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^Activity Vault import: last run failed/)]));
    await api(svc, "PUT", "/api/imports/activity-vault/settings", { path: fx });
  });
});

describe("schedule", () => {
  it("runs daily: not again within a day of a successful run, then once it is due", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const scheduled = () => lastRuns(svc.ctx, 50).filter((r) => r.trigger === "schedule").length;
    let stop = startActivityVaultSchedule(svc.ctx, { firstCheckMs: 5, checkEveryMs: 20 });
    await wait(120); stop();
    expect(scheduled()).toBe(0); // a manual run succeeded minutes ago
    stop = startActivityVaultSchedule(svc.ctx, { firstCheckMs: 5, checkEveryMs: 1000, everyMs: 0 });
    for (let i = 0; i < 50 && scheduled() === 0; i++) await wait(20);
    stop();
    expect(lastRuns(svc.ctx, 1)[0]).toMatchObject({ trigger: "schedule", status: "ok" });
  });
});

describe("JSON archives and the MCP stub", () => {
  it("reads JSON with capture status and JSON Lines", async () => {
    const jd = join(fx, "json"); mkdirSync(jd);
    const j = join(jd, "export.json");
    writeFileSync(j, JSON.stringify({
      items: [
        { time: "2026-10-01T08:00:00Z", product: "Search", title: "Searched for ivy vault", link: "https://google.com/search?q=ivy" },
        { time: "2026-10-01T09:00:00Z", product: "YouTube", title: "Watched ivy demo", capturedAt: "2026-10-01T09:05:00Z" },
        { product: "YouTube", title: "no time" },
      ],
      captureStatus: { healthy: true, reportedAt: "2026-10-02T00:00:00Z", days: [{ date: "2026-10-01", status: "healthy" }] },
    }));
    const src = new LocalArchiveSource(j);
    const rows = []; for await (const r of src.rows()) rows.push(r);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ invalid: "no usable time" });
    expect(await src.captureStatus()).toMatchObject({ healthy: true, days: [{ date: "2026-10-01", status: "healthy" }] });
    const run = await runActivityVaultImport(svc.ctx, { trigger: "manual", source: src });
    expect(run).toMatchObject({ status: "ok", rowsAdded: 2, rowsSkipped: 1 });
    const it = (await api(svc, "GET", "/api/search?q=ivy%20demo")).json.items[0];
    expect(it).toMatchObject({ type: "browsing", capturedAt: "2026-10-01T09:05:00.000Z" });

    const l = join(jd, "export.jsonl");
    writeFileSync(l, '{"time":1759312800,"product":"Maps","title":"Viewed Fushimi Inari"}\nnot json\n');
    const ls = new LocalArchiveSource(l);
    const lrows = []; for await (const r of ls.rows()) lrows.push(r);
    expect(lrows).toEqual([expect.objectContaining({ product: "Maps", time: "2025-10-01T10:00:00.000Z" }), { invalid: "not a JSON object" }]);
  });

  it("refuses an unrecognised SQLite file", () => {
    const p = join(fx, "other.db");
    const db = new Database(p); db.exec("CREATE TABLE t (a, b)"); db.close();
    expect(() => new LocalArchiveSource(p)).toThrow(/no table with time, product and title/);
  });

  it("the MCP adapter is a stub that fails clearly", async () => {
    const run = await runActivityVaultImport(svc.ctx, { trigger: "manual", source: new McpActivityVaultSource("http://127.0.0.1:9/mcp") });
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/stub/);
    expect((await api(svc, "PUT", "/api/imports/activity-vault/settings", { adapter: "ftp" })).status).toBe(400);
  });
});
