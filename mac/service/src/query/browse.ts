/**
 * Device file browser (catalog browse-and-fetch-on-demand, PROTOCOL file_meta.catalogOnly).
 *
 * The Windows catalog collector records a metadata-only row per file (name, size, ext, mtime, no
 * blob) so the Mac can browse the whole PC and fetch any file's bytes on demand. These routes derive
 * a folder tree from the stored file paths in the `files` table — both catalog rows and ordinary
 * indexed rows for the device — without any explicit folder rows. Paths are Windows-style
 * (backslash); they are compared case-insensitively and the original case is kept for display.
 *
 *   cached = a full local copy exists (status 'cached' with a local_path)
 *   inR2   = an archived original exists in media_archive (re-fetchable without the device)
 */
import type { Ctx } from "../context.ts";

const BACKSLASH = "char(92)"; // SQLite literal for "\"; Windows path separator

/** A live, browsable file: not in the recovery bin and not deleted at the source. */
const LIVE = "deleted_at IS NULL AND source_status = 'live'";

export interface BrowseFolder { name: string; path: string; fileCount: number; totalBytes: number }
export interface BrowseFile { id: string; name: string; path: string; ext: string | null; size: number | null; mtime: string | null; cached: boolean; inR2: boolean }

interface FileRow {
  id: string; name: string; path: string; ext: string | null; size: number | null; mtime: string | null;
  status: string; local_path: string | null; in_r2: number;
}

/** Strip trailing separators (keep the drive colon) so a directory compares and joins cleanly. */
export function normalizeDir(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function fileView(r: FileRow): BrowseFile {
  return {
    id: r.id, name: r.name, path: r.path, ext: r.ext, size: r.size, mtime: r.mtime,
    cached: r.status === "cached" && !!r.local_path,
    inR2: !!r.in_r2,
  };
}

const FILE_COLS = `id, name, path, ext, size, mtime, status, local_path,
  (original_blob_oid IS NOT NULL AND EXISTS (SELECT 1 FROM media_archive ma WHERE ma.oid = files.original_blob_oid)) AS in_r2`;

export interface BrowseResult {
  deviceId: string;
  path: string | null;
  folders: BrowseFolder[];
  files: BrowseFile[];
  nextCursor: string | null;
}

/**
 * Immediate children of a directory for a device. With no `path` (or empty), the top-level
 * roots/drives present. Folders are sorted then files, each by name. `limit` caps the files returned;
 * `cursor` (an opaque file offset) continues a large folder.
 */
export function browse(ctx: Ctx, deviceId: string, dir: string | undefined, opts: { limit?: number; cursor?: string } = {}): BrowseResult {
  const db = ctx.db;
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const offset = Math.max(Number.parseInt(opts.cursor ?? "0", 10) || 0, 0);
  const path = dir && dir.trim() ? normalizeDir(dir.trim()) : null;

  let folders: BrowseFolder[];
  let files: BrowseFile[];

  if (path === null) {
    // top-level: group every file by its first path segment (the drive, e.g. "C:")
    folders = (db.prepare(
      `SELECT seg AS name, COUNT(*) AS fileCount, COALESCE(SUM(size), 0) AS totalBytes
       FROM (SELECT substr(path, 1, instr(path, ${BACKSLASH}) - 1) AS seg, size
             FROM files WHERE device_id = ? AND ${LIVE} AND instr(path, ${BACKSLASH}) > 0)
       GROUP BY lower(seg) ORDER BY lower(seg)`,
    ).all(deviceId) as Array<{ name: string; fileCount: number; totalBytes: number }>).map((f) => ({ ...f, path: f.name }));
    // a bare file with no separator (unusual for Windows) sits at the root
    files = (db.prepare(
      `SELECT ${FILE_COLS} FROM files WHERE device_id = ? AND ${LIVE} AND instr(path, ${BACKSLASH}) = 0
       ORDER BY lower(name) LIMIT ? OFFSET ?`,
    ).all(deviceId, limit + 1, offset) as FileRow[]).map(fileView);
  } else {
    const prefix = path + "\\";
    const plen = [...prefix].length;
    const pfx = prefix.toLowerCase();
    const common = `device_id = @dev AND ${LIVE} AND length(path) > @plen AND lower(substr(path, 1, @plen)) = @pfx`;
    folders = (db.prepare(
      `SELECT seg AS name, COUNT(*) AS fileCount, COALESCE(SUM(size), 0) AS totalBytes FROM (
         SELECT substr(rest, 1, instr(rest, ${BACKSLASH}) - 1) AS seg, size FROM (
           SELECT substr(path, @plen + 1) AS rest, size FROM files WHERE ${common}
         ) WHERE instr(rest, ${BACKSLASH}) > 0
       ) GROUP BY lower(seg) ORDER BY lower(seg)`,
    ).all({ dev: deviceId, plen, pfx }) as Array<{ name: string; fileCount: number; totalBytes: number }>)
      .map((f) => ({ ...f, path: path + "\\" + f.name }));
    files = (db.prepare(
      `SELECT ${FILE_COLS} FROM files WHERE ${common} AND instr(substr(path, @plen + 1), ${BACKSLASH}) = 0
       ORDER BY lower(name) LIMIT @lim OFFSET @off`,
    ).all({ dev: deviceId, plen, pfx, lim: limit + 1, off: offset }) as FileRow[]).map(fileView);
  }

  const more = files.length > limit;
  if (more) files = files.slice(0, limit);
  return { deviceId, path, folders, files, nextCursor: more ? String(offset + limit) : null };
}

export interface BrowseSearchResult { deviceId: string; q: string; files: BrowseFile[]; truncated: boolean }

/** Filename substring search across the device's catalog + indexed files (capped). */
export function browseSearch(ctx: Ctx, deviceId: string, q: string, opts: { limit?: number } = {}): BrowseSearchResult {
  const text = q.trim();
  const cap = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  if (!text) return { deviceId, q: text, files: [], truncated: false };
  const rows = ctx.db.prepare(
    `SELECT ${FILE_COLS} FROM files WHERE device_id = ? AND ${LIVE} AND instr(lower(name), lower(?)) > 0
     ORDER BY lower(name), lower(path) LIMIT ?`,
  ).all(deviceId, text, cap + 1) as FileRow[];
  const truncated = rows.length > cap;
  return { deviceId, q: text, files: rows.slice(0, cap).map(fileView), truncated };
}

/** Per-device catalog size (browse-only entries not yet fetched), for the status view. */
export function catalogStats(ctx: Ctx): { count: number; bytes: number; byDevice: Array<{ deviceId: string; count: number; bytes: number }> } {
  const byDevice = ctx.db.prepare(
    `SELECT device_id AS deviceId, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
     FROM files WHERE catalog = 1 AND local_path IS NULL AND deleted_at IS NULL
     GROUP BY device_id ORDER BY device_id`,
  ).all() as Array<{ deviceId: string; count: number; bytes: number }>;
  return {
    count: byDevice.reduce((n, d) => n + d.count, 0),
    bytes: byDevice.reduce((n, d) => n + d.bytes, 0),
    byDevice,
  };
}
