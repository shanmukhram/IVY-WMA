using Ivy.Core.Protocol;
using Ivy.Core.Storage;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Files;

/// <summary>
/// Batched access to Ivy.Core's <c>file_cache</c> (same table and columns as <see cref="FileCacheStore"/>)
/// plus the collector-owned <c>file_tombstones</c>, <c>file_thumbs</c>, <c>file_originals</c> and
/// <c>file_original_links</c>. One connection per batch keeps a large scan from opening a connection per file.
/// </summary>
internal sealed class FileIndexStore
{
    private readonly VaultDb _db;
    public FileIndexStore(VaultDb db) => _db = db;

    public Batch BeginBatch() => new(_db.Open());

    /// <summary>
    /// Reads go straight to the database; writes are buffered and applied in one transaction by
    /// <see cref="Commit"/>. No write lock is held while the collector calls the record sink (which writes
    /// <c>pending_uploads</c> on its own connection).
    /// </summary>
    public sealed class Batch : IDisposable
    {
        private readonly SqliteConnection _c;
        private readonly SqliteCommand _get, _thumbGet, _origGet, _linkGet;
        private readonly List<(string Sql, object?[] Values)> _writes = new();
        // originals added in this batch (not yet committed), so a copy later in the same batch reuses the oid
        private readonly Dictionary<(string, long), string> _newOriginals = new();
        private const string OrigAddSql = """
            INSERT INTO file_originals(quick_hash, size, payload_kind, blob_oid, source_path, status, queued_at) VALUES ($0, $1, $2, $3, $4, 'pending', $5)
            ON CONFLICT(quick_hash, size) DO NOTHING
            """;
        private const string LinkSetSql = "INSERT OR REPLACE INTO file_original_links(path, quick_hash, blob_oid) VALUES ($0, $1, $2)";
        private const string LinkClearSql = "DELETE FROM file_original_links WHERE path = $0";

        private const string UpsertSql = """
            INSERT INTO file_cache(path, quick_hash, mtime, last_seen, file_id) VALUES ($0, $1, $2, $3, $4)
            ON CONFLICT(path) DO UPDATE SET quick_hash = excluded.quick_hash, mtime = excluded.mtime, last_seen = excluded.last_seen,
                file_id = COALESCE(excluded.file_id, file_cache.file_id);
            DELETE FROM file_tombstones WHERE path = $0;
            """;
        private const string TouchSql = "UPDATE file_cache SET last_seen = $1 WHERE path = $0";
        private const string ThumbSetSql = "INSERT OR REPLACE INTO file_thumbs(path, quick_hash, thumb_oid) VALUES ($0, $1, $2)";
        private const string TombSql = """
            INSERT OR REPLACE INTO file_tombstones(path, quick_hash, file_id, deleted_at, reason) VALUES ($0, $1, $2, $3, $4);
            DELETE FROM file_cache WHERE path = $0;
            DELETE FROM file_thumbs WHERE path = $0;
            DELETE FROM file_original_links WHERE path = $0;
            """;

        internal Batch(SqliteConnection c)
        {
            _c = c;
            _get = Cmd("SELECT quick_hash, mtime, file_id FROM file_cache WHERE path = $0", 1);
            _thumbGet = Cmd("SELECT thumb_oid FROM file_thumbs WHERE path = $0 AND quick_hash = $1", 2);
            _origGet = Cmd("SELECT blob_oid FROM file_originals WHERE quick_hash = $0 AND size = $1", 2);
            _linkGet = Cmd("SELECT quick_hash, blob_oid FROM file_original_links WHERE path = $0", 1);
        }

        private SqliteCommand Cmd(string sql, int n, SqliteTransaction? tx = null)
        {
            var cmd = _c.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = sql;
            for (var i = 0; i < n; i++) cmd.Parameters.Add(new SqliteParameter("$" + i, null));
            return cmd;
        }

        private static void Bind(SqliteCommand cmd, object?[] values)
        {
            for (var i = 0; i < values.Length; i++) cmd.Parameters[i].Value = values[i] ?? DBNull.Value;
        }

        public int PendingWrites => _writes.Count;

        public (string QuickHash, string Mtime, string? FileId)? Get(string path)
        {
            Bind(_get, new object?[] { path });
            using var r = _get.ExecuteReader();
            return r.Read() ? (r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)) : null;
        }

        public string? GetThumb(string path, string quickHash)
        {
            Bind(_thumbGet, new object?[] { path, quickHash });
            return _thumbGet.ExecuteScalar() as string;
        }

        /// <summary>
        /// The blob oid for this content: the existing original (uploaded or still queued: a move or copy is not
        /// uploaded again), or a new pending original with a fresh oid that the caller names in its file_meta.
        /// </summary>
        public string ResolveOriginal(string quickHash, long size, string payloadKind, string sourcePath, string now, Func<string> newOid)
        {
            if (_newOriginals.TryGetValue((quickHash, size), out var oid)) return oid;
            Bind(_origGet, new object?[] { quickHash, size });
            if (_origGet.ExecuteScalar() is string existing) return existing;
            oid = newOid();
            _newOriginals[(quickHash, size)] = oid;
            _writes.Add((OrigAddSql, new object?[] { quickHash, size, payloadKind, oid, sourcePath, now }));
            return oid;
        }

        /// <summary>The original the newest file_meta of this path named, if any.</summary>
        public (string QuickHash, string BlobOid)? GetLink(string path)
        {
            Bind(_linkGet, new object?[] { path });
            using var r = _linkGet.ExecuteReader();
            return r.Read() ? (r.GetString(0), r.GetString(1)) : null;
        }

        public void SetLink(string path, string quickHash, string? blobOid) =>
            _writes.Add(blobOid is null ? (LinkClearSql, new object?[] { path }) : (LinkSetSql, new object?[] { path, quickHash, blobOid }));

        public void Upsert(string path, string quickHash, string mtime, string lastSeen, string? fileId) =>
            _writes.Add((UpsertSql, new object?[] { path, quickHash, mtime, lastSeen, fileId }));

        public void Touch(string path, string lastSeen) => _writes.Add((TouchSql, new object?[] { path, lastSeen }));

        public void SetThumb(string path, string quickHash, string oid) => _writes.Add((ThumbSetSql, new object?[] { path, quickHash, oid }));

        /// <summary>Record the deletion in <c>file_tombstones</c> and drop the cache row (the collector also emits a <c>file_meta</c> with <c>deleted: true</c>).</summary>
        public void Tombstone(string path, string? quickHash, string? fileId, string at, string reason) =>
            _writes.Add((TombSql, new object?[] { path, quickHash, fileId, at, reason }));

        public void Commit()
        {
            if (_writes.Count == 0) return;
            using var tx = _c.BeginTransaction();
            var cache = new Dictionary<string, SqliteCommand>(StringComparer.Ordinal);
            try
            {
                foreach (var (sql, values) in _writes)
                {
                    if (!cache.TryGetValue(sql, out var cmd)) cache[sql] = cmd = Cmd(sql, values.Length, tx);
                    Bind(cmd, values);
                    cmd.ExecuteNonQuery();
                }
                tx.Commit();
            }
            finally
            {
                foreach (var c in cache.Values) c.Dispose();
            }
            _writes.Clear();
            _newOriginals.Clear();
        }

        public void Dispose()
        {
            _get.Dispose();
            _thumbGet.Dispose();
            _origGet.Dispose();
            _linkGet.Dispose();
            _c.Dispose();
        }
    }

    /// <summary>Cached paths under <paramref name="root"/> (any depth) whose last_seen is at or before <paramref name="before"/>.</summary>
    public IReadOnlyList<(string Path, string QuickHash, string? FileId)> StaleUnder(string root, string before)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        var sep = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        cmd.CommandText = "SELECT path, quick_hash, file_id FROM file_cache WHERE last_seen <= $b AND (path = $r OR substr(path, 1, length($s)) = $s)";
        cmd.Parameters.AddWithValue("$b", before);
        cmd.Parameters.AddWithValue("$r", root);
        cmd.Parameters.AddWithValue("$s", sep);
        using var r = cmd.ExecuteReader();
        var list = new List<(string, string, string?)>();
        while (r.Read()) list.Add((r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)));
        return list;
    }

    /// <summary>Cached paths strictly under a directory (a deleted/renamed folder).</summary>
    public IReadOnlyList<(string Path, string QuickHash, string? FileId)> Under(string dir)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        var sep = dir.EndsWith(Path.DirectorySeparatorChar) ? dir : dir + Path.DirectorySeparatorChar;
        cmd.CommandText = "SELECT path, quick_hash, file_id FROM file_cache WHERE substr(path, 1, length($s)) = $s";
        cmd.Parameters.AddWithValue("$s", sep);
        using var r = cmd.ExecuteReader();
        var list = new List<(string, string, string?)>();
        while (r.Read()) list.Add((r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)));
        return list;
    }

    public bool IsTombstoned(string path)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM file_tombstones WHERE path = $p";
        cmd.Parameters.AddWithValue("$p", path);
        return cmd.ExecuteScalar() is not null;
    }

    public int CachedCount()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM file_cache";
        return (int)(long)cmd.ExecuteScalar()!;
    }

    public static string Format(DateTimeOffset t) => IvyTime.Format(t);

    // ---------------------------------------------------------------- media-policy originals (PLAN decision 8)

    public sealed record OriginalRow(string QuickHash, long Size, string PayloadKind, string BlobOid, string SourcePath, string Status, int Attempts);

    /// <summary>Originals still to enqueue (pending, or interrupted while enqueuing), oldest first.</summary>
    public IReadOnlyList<OriginalRow> DueOriginals(int limit)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT quick_hash, size, payload_kind, blob_oid, source_path, status, attempts FROM file_originals
            WHERE status IN ('pending', 'enqueuing') ORDER BY queued_at, quick_hash LIMIT $n
            """;
        cmd.Parameters.AddWithValue("$n", limit);
        using var r = cmd.ExecuteReader();
        var list = new List<OriginalRow>();
        while (r.Read()) list.Add(new OriginalRow(r.GetString(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), r.GetInt32(6)));
        return list;
    }

    public OriginalRow? GetOriginal(string quickHash, long size)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT quick_hash, size, payload_kind, blob_oid, source_path, status, attempts FROM file_originals WHERE quick_hash = $h AND size = $s";
        cmd.Parameters.AddWithValue("$h", quickHash);
        cmd.Parameters.AddWithValue("$s", size);
        using var r = cmd.ExecuteReader();
        return r.Read() ? new OriginalRow(r.GetString(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), r.GetInt32(6)) : null;
    }

    private void ExecOriginal(string sql, params (string, object?)[] ps)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    public void SetOriginalStatus(OriginalRow o, string status, string? error = null, string? uploadedAt = null, bool countAttempt = false) =>
        ExecOriginal("""
            UPDATE file_originals SET status = $st, last_error = $e, uploaded_at = COALESCE($u, uploaded_at), attempts = attempts + $a
            WHERE quick_hash = $h AND size = $s
            """, ("$st", status), ("$e", error), ("$u", uploadedAt), ("$a", countAttempt ? 1 : 0), ("$h", o.QuickHash), ("$s", o.Size));

    public void SetOriginalSource(OriginalRow o, string path) =>
        ExecOriginal("UPDATE file_originals SET source_path = $p WHERE quick_hash = $h AND size = $s", ("$p", path), ("$h", o.QuickHash), ("$s", o.Size));

    /// <summary>Give an original a new oid (its old one may or may not have been enqueued) and repoint its links.</summary>
    public void ReplaceOriginalOid(OriginalRow o, string newOid)
    {
        using var c = _db.Open();
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            UPDATE file_originals SET blob_oid = $n, status = 'pending' WHERE quick_hash = $h AND size = $s;
            UPDATE file_original_links SET blob_oid = $n WHERE blob_oid = $o;
            """;
        cmd.Parameters.AddWithValue("$n", newOid);
        cmd.Parameters.AddWithValue("$o", o.BlobOid);
        cmd.Parameters.AddWithValue("$h", o.QuickHash);
        cmd.Parameters.AddWithValue("$s", o.Size);
        cmd.ExecuteNonQuery();
        tx.Commit();
    }

    /// <summary>The content is gone from every known path: forget the original and the links that named it.</summary>
    public void DropOriginal(OriginalRow o)
    {
        using var c = _db.Open();
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            DELETE FROM file_originals WHERE quick_hash = $h AND size = $s;
            DELETE FROM file_original_links WHERE blob_oid = $o;
            """;
        cmd.Parameters.AddWithValue("$o", o.BlobOid);
        cmd.Parameters.AddWithValue("$h", o.QuickHash);
        cmd.Parameters.AddWithValue("$s", o.Size);
        cmd.ExecuteNonQuery();
        tx.Commit();
    }

    /// <summary>Failed originals (locked, access denied) are retried: called when a full scan starts.</summary>
    public int RetryFailedOriginals()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "UPDATE file_originals SET status = 'pending' WHERE status = 'failed'";
        return cmd.ExecuteNonQuery();
    }

    /// <summary>Indexed paths currently holding this content (by quick hash), other than <paramref name="except"/>.</summary>
    public IReadOnlyList<string> PathsWithHash(string quickHash, string except)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT path FROM file_cache WHERE quick_hash = $h AND path <> $p ORDER BY path";
        cmd.Parameters.AddWithValue("$h", quickHash);
        cmd.Parameters.AddWithValue("$p", except);
        using var r = cmd.ExecuteReader();
        var list = new List<string>();
        while (r.Read()) list.Add(r.GetString(0));
        return list;
    }

    /// <summary>Paths whose newest file_meta named this original.</summary>
    public IReadOnlyList<string> LinkedPaths(string blobOid)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT path FROM file_original_links WHERE blob_oid = $o ORDER BY path";
        cmd.Parameters.AddWithValue("$o", blobOid);
        using var r = cmd.ExecuteReader();
        var list = new List<string>();
        while (r.Read()) list.Add(r.GetString(0));
        return list;
    }

    /// <summary>Counts per status (pending, enqueuing, failed, uploaded).</summary>
    public IReadOnlyDictionary<string, int> OriginalCounts()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT status, COUNT(*) FROM file_originals GROUP BY status";
        using var r = cmd.ExecuteReader();
        var d = new Dictionary<string, int>(StringComparer.Ordinal);
        while (r.Read()) d[r.GetString(0)] = (int)r.GetInt64(1);
        return d;
    }
}
