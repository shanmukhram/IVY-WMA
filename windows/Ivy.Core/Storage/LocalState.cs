using Ivy.Core.Protocol;
using Ivy.Core.Records;

namespace Ivy.Core.Storage;

public sealed record CollectorStateRow(string Name, bool Enabled, string? LastRunAt, string? Cursor, ImportProgress? Import = null);

/// <summary><c>collector_state</c>: per-collector enabled flag, last run and cursor (feeds device_report).</summary>
public sealed class CollectorStateStore
{
    private readonly VaultDb _db;
    public CollectorStateStore(VaultDb db) => _db = db;

    public IReadOnlyList<CollectorStateRow> All()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT name, enabled, last_run_at, cursor, import_total, import_done, import_phase FROM collector_state ORDER BY name";
        using var r = cmd.ExecuteReader();
        var list = new List<CollectorStateRow>();
        while (r.Read())
        {
            ImportProgress? import = r.IsDBNull(6) ? null
                : new ImportProgress(r.IsDBNull(4) ? null : r.GetInt64(4), r.IsDBNull(5) ? 0 : r.GetInt64(5), r.GetString(6));
            list.Add(new CollectorStateRow(r.GetString(0), r.GetInt64(1) != 0, r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), import));
        }
        return list;
    }

    public CollectorStateRow? Get(string name) => All().FirstOrDefault(r => r.Name == name);

    /// <summary>Ensure a row exists (default enabled).</summary>
    public void Register(string name, bool enabled = true)
    {
        using var guard = IvyUiThread.Write("CollectorStateStore.Register");
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT OR IGNORE INTO collector_state(name, enabled) VALUES ($n, $e)";
        cmd.Parameters.AddWithValue("$n", name);
        cmd.Parameters.AddWithValue("$e", enabled ? 1 : 0);
        cmd.ExecuteNonQuery();
    }

    public void SetEnabled(string name, bool enabled)
    {
        using var guard = IvyUiThread.Write("CollectorStateStore.SetEnabled");
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT INTO collector_state(name, enabled) VALUES ($n, $e) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled";
        cmd.Parameters.AddWithValue("$n", name);
        cmd.Parameters.AddWithValue("$e", enabled ? 1 : 0);
        cmd.ExecuteNonQuery();
    }

    /// <summary>Record a successful run and (optionally) advance the cursor.</summary>
    public void RecordRun(string name, DateTimeOffset at, string? cursor = null)
    {
        using var guard = IvyUiThread.Write("CollectorStateStore.RecordRun");
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO collector_state(name, enabled, last_run_at, cursor) VALUES ($n, 1, $t, $c)
            ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, cursor = COALESCE(excluded.cursor, collector_state.cursor)
            """;
        cmd.Parameters.AddWithValue("$n", name);
        cmd.Parameters.AddWithValue("$t", IvyTime.Format(at));
        cmd.Parameters.AddWithValue("$c", (object?)cursor ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    /// <summary>Record a run together with the collector's import progress (null clears it): what the device report sends (§6).</summary>
    public void RecordRun(string name, DateTimeOffset at, string? cursor, ImportProgress? import)
    {
        RecordRun(name, at, cursor);
        SetImport(name, import);
    }

    /// <summary>Set (or clear, with null) the import progress reported for <paramref name="name"/>.</summary>
    public void SetImport(string name, ImportProgress? import)
    {
        using var guard = IvyUiThread.Write("CollectorStateStore.SetImport");
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO collector_state(name, enabled, import_total, import_done, import_phase) VALUES ($n, 1, $t, $d, $p)
            ON CONFLICT(name) DO UPDATE SET import_total = excluded.import_total, import_done = excluded.import_done, import_phase = excluded.import_phase
            """;
        cmd.Parameters.AddWithValue("$n", name);
        cmd.Parameters.AddWithValue("$t", (object?)import?.Total ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$d", import is null ? DBNull.Value : import.Done);
        cmd.Parameters.AddWithValue("$p", (object?)import?.Phase ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }
}

public sealed record FileCacheRow(string Path, string QuickHash, string Mtime, string LastSeen, string? FileId);

/// <summary><c>file_cache</c>: metadata the files collector uses for change detection and to resolve <c>fileId</c>.</summary>
public sealed class FileCacheStore
{
    private readonly VaultDb _db;
    public FileCacheStore(VaultDb db) => _db = db;

    public void Upsert(FileCacheRow row)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO file_cache(path, quick_hash, mtime, last_seen, file_id) VALUES ($p, $h, $m, $s, $f)
            ON CONFLICT(path) DO UPDATE SET quick_hash = excluded.quick_hash, mtime = excluded.mtime, last_seen = excluded.last_seen,
                file_id = COALESCE(excluded.file_id, file_cache.file_id)
            """;
        cmd.Parameters.AddWithValue("$p", row.Path);
        cmd.Parameters.AddWithValue("$h", row.QuickHash);
        cmd.Parameters.AddWithValue("$m", row.Mtime);
        cmd.Parameters.AddWithValue("$s", row.LastSeen);
        cmd.Parameters.AddWithValue("$f", (object?)row.FileId ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    public FileCacheRow? Get(string path) => Query("SELECT path, quick_hash, mtime, last_seen, file_id FROM file_cache WHERE path = $v", path);

    public FileCacheRow? GetByFileId(string fileId) => Query("SELECT path, quick_hash, mtime, last_seen, file_id FROM file_cache WHERE file_id = $v", fileId);

    public void Remove(string path)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "DELETE FROM file_cache WHERE path = $p";
        cmd.Parameters.AddWithValue("$p", path);
        cmd.ExecuteNonQuery();
    }

    private FileCacheRow? Query(string sql, string v)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$v", v);
        using var r = cmd.ExecuteReader();
        return r.Read() ? new FileCacheRow(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4)) : null;
    }
}

/// <summary><c>executed_commands</c> (PLAN decision 4).</summary>
public sealed class ExecutedCommandStore
{
    private readonly VaultDb _db;
    private readonly TimeProvider _time;
    public ExecutedCommandStore(VaultDb db, TimeProvider? time = null)
    {
        _db = db;
        _time = time ?? TimeProvider.System;
    }

    public bool IsExecutedKey(string objectKey) => Scalar("SELECT 1 FROM executed_commands WHERE object_key = $v", objectKey);

    public bool IsExecutedCommandId(string commandId) => Scalar("SELECT 1 FROM executed_commands WHERE command_id = $v", commandId);

    public void Record(string objectKey, string? commandId, string outcome)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT OR REPLACE INTO executed_commands(object_key, command_id, executed_at, outcome) VALUES ($k, $i, $t, $o)";
        cmd.Parameters.AddWithValue("$k", objectKey);
        cmd.Parameters.AddWithValue("$i", (object?)commandId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$t", IvyTime.Now(_time));
        cmd.Parameters.AddWithValue("$o", outcome);
        cmd.ExecuteNonQuery();
    }

    public int Count()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM executed_commands";
        return (int)(long)cmd.ExecuteScalar()!;
    }

    private bool Scalar(string sql, string v)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$v", v);
        return cmd.ExecuteScalar() is not null;
    }
}
