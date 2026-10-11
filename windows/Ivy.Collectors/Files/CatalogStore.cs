using Ivy.Core.Storage;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Files;

/// <summary>
/// The <c>catalog_entry</c> table: one row per catalogued file (path, size, mtime, and the scan generation
/// that last saw it). Metadata only. A file is re-emitted only when its size or mtime changes; a row left at
/// an older generation after a full scan is a file that has gone, so a deletion is emitted. One connection
/// per batch keeps a large scan from opening a connection per file.
/// </summary>
internal sealed class CatalogStore
{
    private readonly VaultDb _db;
    public CatalogStore(VaultDb db) => _db = db;

    public Batch BeginBatch() => new(_db.Open());

    /// <summary>Forget every catalogued file, so the next scan re-emits all of them (e.g. to re-emit as batches).</summary>
    public void Clear()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "DELETE FROM catalog_entry";
        cmd.ExecuteNonQuery();
    }

    /// <summary>The highest scan generation stored, or 0 when the catalogue is empty. The next pass uses this + 1,
    /// so generations strictly increase regardless of the clock.</summary>
    public long MaxGeneration()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COALESCE(MAX(scan_gen), 0) FROM catalog_entry";
        return Convert.ToInt64(cmd.ExecuteScalar());
    }

    /// <summary>Paths whose row is older than <paramref name="gen"/> — files not seen by the latest scan (deletions).</summary>
    public IReadOnlyList<string> Stale(long gen)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT path FROM catalog_entry WHERE scan_gen < $g";
        cmd.Parameters.AddWithValue("$g", gen);
        var paths = new List<string>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) paths.Add(r.GetString(0));
        return paths;
    }

    public sealed class Batch : IDisposable
    {
        private readonly SqliteConnection _c;
        private readonly SqliteCommand _get;
        private readonly List<(string Sql, object?[] Values)> _writes = new();

        public Batch(SqliteConnection c)
        {
            _c = c;
            _get = _c.CreateCommand();
            _get.CommandText = "SELECT size, mtime FROM catalog_entry WHERE path = $p";
            _get.Parameters.Add("$p", SqliteType.Text);
        }

        /// <summary>The stored (size, mtime) for a path, or null when it is not catalogued yet.</summary>
        public (long Size, string Mtime)? Get(string path)
        {
            _get.Parameters["$p"].Value = path;
            using var r = _get.ExecuteReader();
            return r.Read() ? (r.GetInt64(0), r.GetString(1)) : null;
        }

        /// <summary>Record a file as seen in this scan generation (inserts or updates size/mtime/gen).</summary>
        public void Upsert(string path, long size, string mtime, long gen) => _writes.Add((
            """
            INSERT INTO catalog_entry(path, size, mtime, scan_gen) VALUES ($0, $1, $2, $3)
            ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, scan_gen = excluded.scan_gen
            """,
            new object?[] { path, size, mtime, gen }));

        /// <summary>Only bump the generation for an unchanged file, so it is not swept as a deletion.</summary>
        public void Touch(string path, long gen) => _writes.Add((
            "UPDATE catalog_entry SET scan_gen = $1 WHERE path = $0", new object?[] { path, gen }));

        public void Remove(string path) => _writes.Add(("DELETE FROM catalog_entry WHERE path = $0", new object?[] { path }));

        /// <summary>Apply this batch's writes in one transaction.</summary>
        public void Commit()
        {
            if (_writes.Count == 0) return;
            using var tx = _c.BeginTransaction();
            foreach (var (sql, values) in _writes)
            {
                using var cmd = _c.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = sql;
                for (var i = 0; i < values.Length; i++) cmd.Parameters.AddWithValue("$" + i, values[i] ?? DBNull.Value);
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            _writes.Clear();
        }

        public void Dispose() { _get.Dispose(); _c.Dispose(); }
    }
}
