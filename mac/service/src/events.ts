/**
 * Event bus for the UI stream (WebSocket /events) and the persisted activity
 * log (/api/activity). Events carry ids, keys, kinds and counts; content text
 * stays in the vault tables.
 */
import { EventEmitter } from "node:events";
import type { DB } from "./db/index.ts";
import { nowIso } from "./util/time.ts";

export type EventType =
  | "ingest.poll" | "ingest.committed" | "ingest.quarantined" | "ingest.replayed" | "ingest.error" | "ingest.paused" | "ingest.resumed" | "ingest.archived" | "ingest.ignored"
  | "blob.progress" | "blob.complete"
  | "command.issued" | "command.sent" | "command.transferring" | "command.progress" | "command.status" | "command.completed" | "command.cancelled"
  | "file.cached" | "file.extracted"
  | "pairing.started" | "pairing.completed" | "pairing.rejected" | "pairing.expired" | "pairing.cancelled"
  | "device.revoked" | "device.forgotten" | "device.renamed" | "device.unpair_confirmed"
  | "keystore.initialized" | "keystore.unlocked" | "keystore.locked" | "keystore.passphrase_changed"
  | "r2.configured"
  | "coverage.changed"
  | "media.ocr"
  | "bin.deleted" | "bin.restored" | "bin.purged"
  | "ai.answered" | "ai.embedded"
  | "import.completed" | "import.failed";

export interface ServiceEvent {
  id: number;
  at: string;
  type: EventType;
  data: Record<string, unknown>;
}

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly db: DB;
  private readonly keep: number;
  private writes = 0;

  constructor(db: DB, keep: number) {
    this.db = db;
    this.keep = keep;
    this.emitter.setMaxListeners(100);
  }

  emit(type: EventType, data: Record<string, unknown> = {}): ServiceEvent {
    const at = nowIso();
    const r = this.db.prepare("INSERT INTO activity(at, type, data) VALUES (?, ?, ?)").run(at, type, JSON.stringify(data));
    const ev: ServiceEvent = { id: Number(r.lastInsertRowid), at, type, data };
    if (++this.writes % 200 === 0) this.trim();
    this.emitter.emit("event", ev);
    return ev;
  }

  on(fn: (ev: ServiceEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }

  recent(opts: { limit?: number; before?: number; types?: string[] } = {}): ServiceEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.before) { where.push("rid < ?"); args.push(opts.before); }
    if (opts.types?.length) { where.push(`type IN (${opts.types.map(() => "?").join(",")})`); args.push(...opts.types); }
    const rows = this.db.prepare(
      `SELECT rid, at, type, data FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY rid DESC LIMIT ?`,
    ).all(...args, limit) as Array<{ rid: number; at: string; type: EventType; data: string }>;
    return rows.map((r) => ({ id: r.rid, at: r.at, type: r.type, data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  trim(): void {
    this.db.prepare("DELETE FROM activity WHERE rid <= (SELECT MAX(rid) FROM activity) - ?").run(this.keep);
  }
}
