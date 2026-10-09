using System.Text;
using Ivy.Collectors.Abstractions;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Notifications;

/// <summary>
/// Reads <c>wpndatabase.db</c>. The live file is held open by the Windows notification platform, so each
/// read first snapshots <c>wpndatabase.db</c>, <c>-wal</c> and <c>-shm</c> into a private temp directory
/// (shared-read streams; the copy is retried until the three files' sizes and mtimes are identical before
/// and after copying, so it is a consistent point-in-time set) and queries the copy. The temp copy is
/// deleted after every read. Nothing here is Windows-specific, so the tests run it against a fixture.
/// </summary>
public sealed class WpnDatabaseReader : INotificationDbReader
{
    private static readonly string[] Suffixes = { "", "-wal", "-shm" };
    private readonly string _tempRoot;

    public WpnDatabaseReader(string databasePath, string? tempRoot = null)
    {
        DatabasePath = databasePath;
        _tempRoot = tempRoot ?? Path.Combine(Path.GetTempPath(), "ivy-wpn");
    }

    public string DatabasePath { get; }

    public IReadOnlyList<RawNotification> ReadAfter(long afterId, int limit)
    {
        if (!File.Exists(DatabasePath))
            throw new NotificationDbUnavailableException($"notification database not found at {DatabasePath}");
        var dir = Path.Combine(_tempRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var copy = Snapshot(dir);
            return Query(copy, afterId, limit);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(dir, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private string Snapshot(string dir)
    {
        var target = Path.Combine(dir, "wpndatabase.db");
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var before = Stamp();
            try
            {
                foreach (var s in Suffixes)
                {
                    var src = DatabasePath + s;
                    var dst = target + s;
                    if (File.Exists(dst)) File.Delete(dst);
                    if (!File.Exists(src)) continue;
                    using var input = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
                    using var output = new FileStream(dst, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16);
                    input.CopyTo(output);
                }
            }
            catch (UnauthorizedAccessException e)
            {
                throw new NotificationDbUnavailableException($"access denied reading {DatabasePath} (run elevated?)", e);
            }
            catch (IOException e) when (e is not FileNotFoundException)
            {
                if (attempt == 4) throw new NotificationDbUnavailableException($"could not copy {DatabasePath}: {e.Message}", e);
                Thread.Sleep(100 * (attempt + 1));
                continue;
            }
            if (before == Stamp()) return target;
            Thread.Sleep(100 * (attempt + 1));
        }
        throw new NotificationDbUnavailableException($"{DatabasePath} kept changing while copying; will retry next poll");
    }

    private string Stamp()
    {
        var sb = new StringBuilder();
        foreach (var s in Suffixes)
        {
            var fi = new FileInfo(DatabasePath + s);
            sb.Append(fi.Exists ? $"{fi.Length}:{fi.LastWriteTimeUtc.Ticks};" : "-;");
        }
        return sb.ToString();
    }

    private static IReadOnlyList<RawNotification> Query(string path, long afterId, int limit)
    {
        var cs = new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString();
        try
        {
            using var c = new SqliteConnection(cs);
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = """
                SELECT n.Id, h.PrimaryId, n.Type, n.Payload, n.ArrivalTime
                FROM Notification n LEFT JOIN NotificationHandler h ON h.RecordId = n.HandlerId
                WHERE n.Id > $after
                ORDER BY n.Id
                LIMIT $limit
                """;
            cmd.Parameters.AddWithValue("$after", afterId);
            cmd.Parameters.AddWithValue("$limit", limit);
            using var r = cmd.ExecuteReader();
            var list = new List<RawNotification>();
            while (r.Read())
            {
                list.Add(new RawNotification(
                    r.GetInt64(0),
                    r.IsDBNull(1) ? null : r.GetString(1),
                    r.IsDBNull(2) ? null : r.GetString(2),
                    r.IsDBNull(3) ? null : PayloadText(r.GetValue(3)),
                    r.IsDBNull(4) ? 0 : r.GetInt64(4)));
            }
            return list;
        }
        catch (SqliteException e)
        {
            throw new NotificationDbUnavailableException($"notification database could not be queried: {e.Message}", e);
        }
    }

    /// <summary>Payload is a BLOB of UTF-8 XML on current builds (TEXT on some older ones).</summary>
    private static string PayloadText(object v) => v switch
    {
        byte[] b when b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE => Encoding.Unicode.GetString(b, 2, b.Length - 2),
        byte[] b => Encoding.UTF8.GetString(b),
        string s => s,
        _ => v.ToString() ?? "",
    };
}
