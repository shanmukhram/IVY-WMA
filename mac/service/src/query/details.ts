/**
 * Per-item detail used by search results, the timeline and record views
 * (Q4: direct access to the record; F4: reference / preview / local copy).
 */
import type { Ctx } from "../context.ts";
import type { ItemType } from "./types.ts";

export interface BaseItem {
  type: ItemType; rid: number; id: string; device_id: string | null; app: string | null; event_time: string | null;
  time_field: string; captured_at: string | null; title: string | null; body: string | null; person: string | null;
}

function fileAvailability(f: { status: string; local_path: string | null; thumb_path: string | null }) {
  if (f.status === "cached" && f.local_path) return "local";
  if (f.local_path) return "stale_local"; // an older version is local; the current one is not
  if (f.thumb_path) return "preview";
  return "reference";
}

function inClause(n: number) { return Array.from({ length: n }, () => "?").join(","); }

export function enrich(ctx: Ctx, items: BaseItem[]): Array<BaseItem & { detail: Record<string, unknown> }> {
  const byType = new Map<ItemType, string[]>();
  for (const it of items) byType.set(it.type, [...(byType.get(it.type) ?? []), it.id]);
  const details = new Map<string, Record<string, unknown>>();
  const db = ctx.db;
  for (const [type, ids] of byType) {
    if (!ids.length) continue;
    const q = inClause(ids.length);
    if (type === "message") {
      for (const r of db.prepare(`SELECT x.id, x.conversation_id, c.platform, c.account, c.peer, c.kind AS conv_kind, c.coverage, x.sent_at,
                                         x.edited_at, x.reply_to, x.source_status, x.msg_key,
                                         (SELECT COUNT(*) FROM attachments a WHERE a.message_id = x.id AND a.deleted_at IS NULL) AS attachments
                                  FROM messages x JOIN conversations c ON c.id = x.conversation_id WHERE x.id IN (${q})`).all(...ids) as Array<Record<string, unknown>>) {
        details.set(String(r.id), {
          conversationId: r.conversation_id, platform: r.platform, account: r.account, peer: r.peer, conversationKind: r.conv_kind,
          coverage: r.coverage, sentAt: r.sent_at, editedAt: r.edited_at, replyTo: r.reply_to, sourceStatus: r.source_status,
          attachments: r.attachments, open: { conversationId: r.conversation_id, messageId: r.id },
        });
      }
    } else if (type === "notification") {
      for (const r of db.prepare(`SELECT id, source, app, title, sender, preview, posted_at, notif_key, linked_message_id, link_confidence FROM notifications WHERE id IN (${q})`).all(...ids) as Array<Record<string, unknown>>) {
        details.set(String(r.id), {
          source: r.source, sender: r.sender, postedAt: r.posted_at, partial: true, linkedMessageId: r.linked_message_id, linkConfidence: r.link_confidence,
        });
      }
    } else if (type === "screenshot" || type === "photo") {
      for (const r of db.prepare(`SELECT id, kind, source_path, width, height, taken_at, saved_at, captured_at, imported_at, local_path, thumb_path, ocr_status, sha256 FROM media WHERE id IN (${q})`).all(...ids) as Array<Record<string, unknown>>) {
        details.set(String(r.id), {
          sourcePath: r.source_path, width: r.width, height: r.height, takenAt: r.taken_at, savedAt: r.saved_at, importedAt: r.imported_at,
          ocrStatus: r.ocr_status, original: !!r.local_path, thumbnail: !!r.thumb_path, sha256: r.sha256,
          contentUrl: r.local_path ? `/api/media/${r.id}/content` : null,
          thumbUrl: r.thumb_path ? `/api/media/${r.id}/thumb` : r.local_path ? `/api/media/${r.id}/content` : null,
        });
      }
    } else if (type === "file") {
      for (const r of db.prepare(`SELECT id, device_id, path, name, ext, size, mtime, quick_hash, status, source_status, source_deleted_at, local_path, thumb_path FROM files WHERE id IN (${q})`).all(...ids) as Array<Record<string, unknown>>) {
        const open = db.prepare("SELECT id, status FROM commands WHERE file_id = ? ORDER BY issued_at DESC LIMIT 1").get(r.id) as { id: string; status: string } | undefined;
        details.set(String(r.id), {
          path: r.path, name: r.name, ext: r.ext, size: r.size, mtime: r.mtime, quickHash: r.quick_hash, status: r.status,
          sourceStatus: r.source_status, sourceDeletedAt: r.source_deleted_at,
          availability: fileAvailability(r as { status: string; local_path: string | null; thumb_path: string | null }),
          contentUrl: r.local_path ? `/api/files/${r.id}/content` : null,
          thumbUrl: r.thumb_path ? `/api/files/${r.id}/thumb` : null,
          lastRequest: open ? { commandId: open.id, status: open.status } : null,
        });
      }
    } else if (type === "usage") {
      for (const r of db.prepare(`SELECT id, app, exe, title, title_state, started_at, ended_at FROM usage_events WHERE id IN (${q})`).all(...ids) as Array<Record<string, unknown>>) {
        details.set(String(r.id), { exe: r.exe, titleState: r.title_state, startedAt: r.started_at, endedAt: r.ended_at });
      }
    } else if (type === "call") {
      for (const r of db.prepare(`SELECT id, direction, contact, number, started_at, duration_s FROM calls WHERE id IN (${q})`).all(...ids) as Array<Record<string, unknown>>) {
        details.set(String(r.id), { direction: r.direction, contact: r.contact, number: r.number, startedAt: r.started_at, durationS: r.duration_s });
      }
    }
  }
  return items.map((it) => ({ ...it, detail: details.get(it.id) ?? {} }));
}

/** API shape of an item. */
export function itemView(it: BaseItem & { detail: Record<string, unknown> }) {
  return {
    type: it.type, id: it.id, deviceId: it.device_id, app: it.app,
    eventTime: it.event_time, timeField: it.time_field, capturedAt: it.captured_at,
    title: it.title, body: it.body, person: it.person, detail: it.detail,
  };
}
