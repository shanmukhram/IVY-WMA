using Ivy.Core.Storage;

namespace Ivy.Collectors.Common;

/// <summary>
/// Collector-owned tables in <c>vault-agent.db</c>, created additively next to Ivy.Core's schema.
/// Metadata only (paths, hashes, oids, timestamps), never captured content.
/// </summary>
internal static class CollectorDb
{
    /// <summary>Delete every row of the named collector-owned tables (fixed names from this file, never user input).</summary>
    public static void ClearTables(VaultDb db, params string[] tables)
    {
        using var guard = IvyUiThread.Write("CollectorDb.ClearTables");
        EnsureSchema(db);
        using var c = db.Open();
        foreach (var t in tables)
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = "DELETE FROM " + t;
            cmd.ExecuteNonQuery();
        }
    }

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
            -- Media-policy originals (PLAN decision 8), one row per content (quick hash + size), so a moved or
            -- copied file is not uploaded again. blob_oid is chosen when the first file_meta naming it is emitted
            -- (file_meta.originalBlobOid) and the blob is enqueued later in the bulk lane under that oid.
            CREATE TABLE IF NOT EXISTS file_originals (
                quick_hash   TEXT NOT NULL,
                size         INTEGER NOT NULL,
                payload_kind TEXT NOT NULL,              -- photo | document
                blob_oid     TEXT NOT NULL,
                source_path  TEXT NOT NULL,              -- the file read for the upload
                status       TEXT NOT NULL,              -- pending | enqueuing | failed | uploaded
                attempts     INTEGER NOT NULL DEFAULT 0,
                last_error   TEXT,
                queued_at    TEXT NOT NULL,
                uploaded_at  TEXT,
                PRIMARY KEY (quick_hash, size)
            );
            CREATE INDEX IF NOT EXISTS ix_file_originals_status ON file_originals(status, queued_at);
            -- The original the newest file_meta of a path named, so an unchanged file is linked exactly once.
            CREATE TABLE IF NOT EXISTS file_original_links (
                path       TEXT PRIMARY KEY,
                quick_hash TEXT NOT NULL,
                blob_oid   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_file_original_links_oid ON file_original_links(blob_oid);
            -- Files already examined (path + size + mtime), so sweeps do not re-hash them.
            CREATE TABLE IF NOT EXISTS screenshot_files (
                path   TEXT PRIMARY KEY,
                size   INTEGER NOT NULL,
                mtime  TEXT NOT NULL,
                sha256 TEXT NOT NULL
            );
            -- File catalog (browse-and-fetch-on-demand): one row per catalogued file, metadata only. A file
            -- is re-emitted only when size/mtime change; scan_gen records the latest scan that saw it, so a
            -- row left at an older generation after a full scan is a deletion. No content is ever read.
            CREATE TABLE IF NOT EXISTS catalog_entry (
                path     TEXT PRIMARY KEY,
                size     INTEGER NOT NULL,
                mtime    TEXT NOT NULL,
                scan_gen INTEGER NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();
    }
}
