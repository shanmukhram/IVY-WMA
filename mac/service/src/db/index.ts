import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { dirname } from "node:path";
import { ensureDir } from "../util/fsx.ts";
import { MIGRATIONS } from "./migrations.ts";
import { nowIso } from "../util/time.ts";

export type { DB };

export function openDb(path: string): DB {
  if (path !== ":memory:") ensureDir(dirname(path));
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL"); // commit before delete-from-R2 must survive power loss
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = ON"); // permanent delete zeroes freed pages (B3)
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version));
  const ran: number[] = [];
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, nowIso());
    })();
    ran.push(m.version);
  }
  return ran;
}

export function getSetting(db: DB, key: string): string | undefined {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, nowIso());
}

export function deleteSetting(db: DB, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function getNumberSetting(db: DB, key: string, fallback: number): number {
  const v = getSetting(db, key);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
