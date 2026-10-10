using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Line;

/// <summary>One LINE Keep item (the user's own saved notes/media), from the keep_*.edb _keep_content table.</summary>
public sealed record LineKeepItem(string ContentId, DateTimeOffset? CreatedAt, string? Name, string? MainType, long? Size, string? MessageId);

/// <summary>
/// Reads LINE Keep items from a decrypted keep store (<c>keep_&lt;hex&gt;.edb</c>, same wxSQLite3 scheme as the
/// chat store). Reads item metadata only (name, type, time, the message it was saved from), never other content.
/// </summary>
public static class LineKeep
{
    /// <summary>The keep store file in the LINE data folder, if present.</summary>
    public static string? FindKeepDb(string dataFolder)
    {
        if (!Directory.Exists(dataFolder)) return null;
        foreach (var f in Directory.EnumerateFiles(dataFolder, "keep_*.edb", SearchOption.AllDirectories))
            if (!f.EndsWith("-wal", StringComparison.OrdinalIgnoreCase) && !f.EndsWith("-shm", StringComparison.OrdinalIgnoreCase))
                return f;
        return null;
    }

    /// <summary>Read the Keep items from a plaintext keep database path.</summary>
    public static IReadOnlyList<LineKeepItem> Read(string plainDbPath)
    {
        var cs = new SqliteConnectionStringBuilder { DataSource = plainDbPath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString();
        using var c = new SqliteConnection(cs);
        c.Open();
        var cols = new HashSet<string>(StringComparer.Ordinal);
        using (var pr = c.CreateCommand()) { pr.CommandText = "PRAGMA table_info(_keep_content)"; using var r = pr.ExecuteReader(); while (r.Read()) cols.Add(r.GetString(1)); }
        if (!cols.Contains("_contentId")) return Array.Empty<LineKeepItem>();

        var pick = new[] { "_contentId", "_createdTime", "_name", "_mainType", "_size", "_messageId" }.Where(cols.Contains).ToArray();
        var items = new List<LineKeepItem>();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT {string.Join(",", pick.Select(p => "\"" + p + "\""))} FROM _keep_content WHERE _contentId IS NOT NULL ORDER BY _createdTime";
        using var rr = cmd.ExecuteReader();
        while (rr.Read())
        {
            string? G(string col) { var i = Array.IndexOf(pick, col); return i < 0 || rr.IsDBNull(i) ? null : Convert.ToString(rr.GetValue(i), CultureInfo.InvariantCulture); }
            long? GL(string col) { var i = Array.IndexOf(pick, col); return i < 0 || rr.IsDBNull(i) ? (long?)null : Convert.ToInt64(rr.GetValue(i)); }
            var createdMs = GL("_createdTime");
            items.Add(new LineKeepItem(G("_contentId") ?? "", createdMs is { } ms ? DateTimeOffset.FromUnixTimeMilliseconds(ms) : null,
                G("_name"), G("_mainType"), GL("_size"), G("_messageId")));
        }
        return items;
    }
}
