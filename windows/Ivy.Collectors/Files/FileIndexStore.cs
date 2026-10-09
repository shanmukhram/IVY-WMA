using Ivy.Core.Protocol;
using Ivy.Core.Storage;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Files;

/// <summary>
/// Batched access to Ivy.Core's <c>file_cache</c> (same table and columns as <see cref="FileCacheStore"/>)
/// plus the collector-owned <c>file_tombstones</c> and <c>file_thumbs</c>. One connection per batch keeps
/// a large scan from opening a connection per file.
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
        private readonly SqliteCommand _get, _thumbGet;
        private readonly List<(string Sql, object?[] Values)> _writes = new();

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
            """;

        internal Batch(SqliteConnection c)
        {
            _c = c;
            _get = Cmd("SELECT quick_hash, mtime, file_id FROM file_cache WHERE path = $0", 1);
            _thumbGet = Cmd("SELECT thumb_oid FROM file_thumbs WHERE path = $0 AND quick_hash = $1", 2);
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
        }

        public void Dispose()
        {
            _get.Dispose();
            _thumbGet.Dispose();
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
}
