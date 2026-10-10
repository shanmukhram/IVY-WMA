using Ivy.Core.Records;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;
using Microsoft.Data.Sqlite;

namespace Ivy.Core.Tests;

public class StateMigrationTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void A_v1_database_gains_the_import_progress_columns_and_keeps_its_rows()
    {
        var path = _dir.Sub("old.db");
        using (var c = new SqliteConnection($"Data Source={path}"))
        {
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = """
                CREATE TABLE schema_info (version INTEGER NOT NULL);
                INSERT INTO schema_info(version) VALUES (1);
                CREATE TABLE collector_state (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, cursor TEXT);
                INSERT INTO collector_state(name, enabled, last_run_at, cursor) VALUES ('files', 1, '2026-10-01T00:00:00.000Z', 'scan:x');
                """;
            cmd.ExecuteNonQuery();
        }
        SqliteConnection.ClearAllPools();
        using var db = new VaultDb(path);
        var states = new CollectorStateStore(db);
        var row = states.Get("files")!;
        Assert.Equal("scan:x", row.Cursor);
        Assert.Null(row.Import);
        states.SetImport("files", new ImportProgress(100, 40, ImportPhases.Initial));
        Assert.Equal(new ImportProgress(100, 40, ImportPhases.Initial), states.Get("files")!.Import);
        states.RecordRun("files", DateTimeOffset.UtcNow, null, new ImportProgress(null, 7, ImportPhases.Rescan));
        Assert.Equal(new ImportProgress(null, 7, ImportPhases.Rescan), states.Get("files")!.Import);
        states.SetImport("files", null);
        Assert.Null(states.Get("files")!.Import);
        using var again = new VaultDb(path); // idempotent
        using var c2 = again.Open();
        using var v = c2.CreateCommand();
        v.CommandText = "SELECT version FROM schema_info";
        Assert.Equal(3L, (long)v.ExecuteScalar()!);
        v.CommandText = "SELECT COUNT(*) FROM pragma_table_info('pending_uploads') WHERE name = 'lane'";
        Assert.Equal(1L, (long)v.ExecuteScalar()!);
    }
}
