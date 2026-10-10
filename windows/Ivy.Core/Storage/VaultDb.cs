using Microsoft.Data.Sqlite;

namespace Ivy.Core.Storage;

/// <summary>
/// <c>vault-agent.db</c> (PRD Part 1 "Data model"): <c>pending_uploads</c> (+ multipart part ETags),
/// <c>file_cache</c>, <c>collector_state</c>, <c>executed_commands</c> (PLAN decision 4),
/// <c>activity_log</c> and <c>agent_settings</c>. Holds ciphertext-queue bookkeeping and metadata only,
/// never record plaintext.
/// </summary>
public sealed class VaultDb : IDisposable
{
    public const string FileName = "vault-agent.db";
    private const int SchemaVersion = 3;
    private readonly string _connectionString;

    public string Path { get; }

    public VaultDb(string path)
    {
        Path = path;
        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = true,
            ForeignKeys = true,
            DefaultTimeout = 30,
        }.ToString();
        Migrate();
    }

    public SqliteConnection Open()
    {
        var c = new SqliteConnection(_connectionString);
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;";
        cmd.ExecuteNonQuery();
        return c;
    }

    private void Migrate()
    {
        using var c = Open();
        using (var wal = c.CreateCommand())
        {
            wal.CommandText = "PRAGMA journal_mode=WAL;";
            wal.ExecuteNonQuery();
        }
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS schema_info (version INTEGER NOT NULL);

            -- Ciphertext awaiting upload. The part file is written BEFORE the row; the row is removed
            -- only after the upload is confirmed (WU2/WU3).
            CREATE TABLE IF NOT EXISTS pending_uploads (
                id               TEXT PRIMARY KEY,               -- uuid
                seq              INTEGER NOT NULL UNIQUE,        -- drain order
                object_key       TEXT NOT NULL UNIQUE,           -- destination key in the up-bucket
                part_path        TEXT NOT NULL,                  -- encrypted object file, relative to the queue dir
                size             INTEGER NOT NULL,
                attempts         INTEGER NOT NULL DEFAULT 0,     -- retry counter
                status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','uploading','done')),
                kind             TEXT NOT NULL,
                group_key        TEXT,                           -- same group => strictly in seq order (blob: manifest first)
                collector        TEXT,
                created_at       TEXT NOT NULL,
                next_attempt_ms  INTEGER NOT NULL DEFAULT 0,     -- exponential backoff gate (unix ms)
                last_error       TEXT,
                upload_id        TEXT,                           -- S3 multipart upload id, once started
                part_size        INTEGER                         -- multipart part size fixed at start
            );
            CREATE INDEX IF NOT EXISTS ix_pending_due ON pending_uploads(status, next_attempt_ms, seq);
            CREATE INDEX IF NOT EXISTS ix_pending_group ON pending_uploads(group_key, seq);

            -- Completed multipart parts (resume after restart from the last completed part).
            CREATE TABLE IF NOT EXISTS pending_upload_parts (
                upload_row_id TEXT NOT NULL REFERENCES pending_uploads(id) ON DELETE CASCADE,
                part_number   INTEGER NOT NULL,
                etag          TEXT NOT NULL,
                size          INTEGER NOT NULL,
                PRIMARY KEY (upload_row_id, part_number)
            );

            CREATE TABLE IF NOT EXISTS file_cache (
                path       TEXT PRIMARY KEY,
                quick_hash TEXT NOT NULL,
                mtime      TEXT NOT NULL,
                last_seen  TEXT NOT NULL,
                file_id    TEXT                                  -- id the Mac may use in file_request.fileId
            );
            CREATE INDEX IF NOT EXISTS ix_file_cache_id ON file_cache(file_id);

            CREATE TABLE IF NOT EXISTS collector_state (
                name        TEXT PRIMARY KEY,                    -- files, screenshots, usage, notifications
                enabled     INTEGER NOT NULL DEFAULT 1,
                last_run_at TEXT,
                cursor      TEXT
            );

            -- PLAN decision 4: the cmd token is read-only, so executed commands are remembered here.
            CREATE TABLE IF NOT EXISTS executed_commands (
                object_key  TEXT PRIMARY KEY,                    -- cmd/<oid>
                command_id  TEXT,
                executed_at TEXT NOT NULL,
                outcome     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_executed_command_id ON executed_commands(command_id);

            -- Live activity feed for the UI. Object keys, sizes, statuses only; never content.
            CREATE TABLE IF NOT EXISTS activity_log (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                collector TEXT,
                event     TEXT NOT NULL,
                detail    TEXT
            );

            CREATE TABLE IF NOT EXISTS agent_settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();

        // v2: import progress for device_report (PROTOCOL.md §6 importTotal/importDone/phase).
        var have = new HashSet<string>(StringComparer.Ordinal);
        cmd.CommandText = "PRAGMA table_info(collector_state)";
        using (var r = cmd.ExecuteReader()) while (r.Read()) have.Add(r.GetString(1));
        foreach (var (col, type) in new[] { ("import_total", "INTEGER"), ("import_done", "INTEGER"), ("import_phase", "TEXT") })
        {
            if (have.Contains(col)) continue;
            cmd.CommandText = $"ALTER TABLE collector_state ADD COLUMN {col} {type}";
            cmd.ExecuteNonQuery();
        }

        // v3: upload lanes (normal before bulk; PLAN decision 8 media-policy originals go in the bulk lane).
        have.Clear();
        cmd.CommandText = "PRAGMA table_info(pending_uploads)";
        using (var r = cmd.ExecuteReader()) while (r.Read()) have.Add(r.GetString(1));
        if (!have.Contains("lane"))
        {
            cmd.CommandText = "ALTER TABLE pending_uploads ADD COLUMN lane INTEGER NOT NULL DEFAULT 0";
            cmd.ExecuteNonQuery();
        }
        cmd.CommandText = "CREATE INDEX IF NOT EXISTS ix_pending_lane ON pending_uploads(status, lane, seq)";
        cmd.ExecuteNonQuery();

        cmd.CommandText = "SELECT COUNT(*) FROM schema_info";
        if ((long)cmd.ExecuteScalar()! == 0)
        {
            cmd.CommandText = $"INSERT INTO schema_info(version) VALUES ({SchemaVersion})";
            cmd.ExecuteNonQuery();
        }
        else
        {
            cmd.CommandText = $"UPDATE schema_info SET version = {SchemaVersion} WHERE version < {SchemaVersion}";
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }

    public string? GetSetting(string key)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT value FROM agent_settings WHERE key = $k";
        cmd.Parameters.AddWithValue("$k", key);
        return cmd.ExecuteScalar() as string;
    }

    public void SetSetting(string key, string value)
    {
        using var guard = IvyUiThread.Write("VaultDb.SetSetting");
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT INTO agent_settings(key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
        cmd.Parameters.AddWithValue("$k", key);
        cmd.Parameters.AddWithValue("$v", value);
        cmd.ExecuteNonQuery();
    }

    /// <summary>Checkpoint the WAL so the main file is self-contained (used by audits and shutdown).</summary>
    public void Checkpoint()
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA wal_checkpoint(TRUNCATE);";
        cmd.ExecuteNonQuery();
    }

    public void Dispose()
    {
        using (var c = new SqliteConnection(_connectionString)) SqliteConnection.ClearPool(c);
    }
}
