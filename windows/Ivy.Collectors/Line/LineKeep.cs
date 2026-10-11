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
    /// <summary>
    /// The keep store file that belongs to the open chat store. LINE names an account's stores after the same
    /// id: chat store <c>qw&lt;hex&gt;.edb</c>, Keep store <c>keep_qw&lt;hex&gt;.edb</c>. With
    /// <paramref name="chatDbPath"/> given, the Keep store named after it wins. If no file has that name and there
    /// is exactly one Keep store, that one is used (a single account whose naming differs); with several Keep
    /// stores and none matching, null, so another account's Keep is never read under this account.
    /// Without <paramref name="chatDbPath"/>, the only Keep store, or null when there are several.
    /// </summary>
    public static string? FindKeepDb(string dataFolder, string? chatDbPath = null)
    {
        if (!Directory.Exists(dataFolder)) return null;
        var candidates = Directory.EnumerateFiles(dataFolder, "keep_*.edb", SearchOption.AllDirectories)
            .Where(f => f.EndsWith(".edb", StringComparison.OrdinalIgnoreCase))
            .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (chatDbPath is not null)
        {
            var wanted = "keep_" + Path.GetFileNameWithoutExtension(chatDbPath) + ".edb";
            var chatDir = Path.GetDirectoryName(Path.GetFullPath(chatDbPath));
            var named = candidates.Where(f => string.Equals(Path.GetFileName(f), wanted, StringComparison.OrdinalIgnoreCase)).ToList();
            // Prefer the one beside the chat store if the same name appears in more than one folder.
            var match = named.FirstOrDefault(f => string.Equals(Path.GetDirectoryName(Path.GetFullPath(f)), chatDir, StringComparison.OrdinalIgnoreCase))
                        ?? named.FirstOrDefault();
            if (match is not null) return match;
        }
        return candidates.Count == 1 ? candidates[0] : null;
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
