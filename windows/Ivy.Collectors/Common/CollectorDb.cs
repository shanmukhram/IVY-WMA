using Ivy.Core.Storage;

namespace Ivy.Collectors.Common;

/// <summary>
/// Collector-owned tables in <c>vault-agent.db</c>, created additively next to Ivy.Core's schema.
/// Metadata only (paths, hashes, oids, timestamps), never captured content.
/// </summary>
internal static class CollectorDb
{
    public static void EnsureSchema(VaultDb db)
    {
        using var c = db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            -- file_meta has no "deleted" field (PROTOCOL.md §6), so deletions are recorded here and the
            -- file_cache row is removed.
            CREATE TABLE IF NOT EXISTS file_tombstones (
                path       TEXT PRIMARY KEY,
                quick_hash TEXT,
                file_id    TEXT,
                deleted_at TEXT NOT NULL,
                reason     TEXT NOT NULL                 -- deleted | excluded
            );
            -- Last thumbnail blob per file so an mtime-only change does not regenerate it.
            CREATE TABLE IF NOT EXISTS file_thumbs (
                path       TEXT PRIMARY KEY,
                quick_hash TEXT NOT NULL,
                thumb_oid  TEXT NOT NULL
            );
            -- Screenshot dedupe by sha256 (WC3): one row per uploaded original.
            CREATE TABLE IF NOT EXISTS screenshot_seen (
                sha256      TEXT PRIMARY KEY,
                blob_oid    TEXT NOT NULL,
                first_path  TEXT NOT NULL,
                captured_at TEXT NOT NULL
            );
            -- Files already examined (path + size + mtime), so sweeps do not re-hash them.
            CREATE TABLE IF NOT EXISTS screenshot_files (
                path   TEXT PRIMARY KEY,
                size   INTEGER NOT NULL,
                mtime  TEXT NOT NULL,
                sha256 TEXT NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();
    }
}
