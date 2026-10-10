using System.Globalization;
using System.Text;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Line;

/// <summary>Outcome of verifying a <see cref="LineStoreMap"/> against a real snapshot (WL3).</summary>
public sealed class LineVerifyResult
{
    private LineVerifyResult(bool ok, string? reason) { Ok = ok; Reason = reason; }
    public bool Ok { get; }
    /// <summary>Why verification failed (shown red); null when <see cref="Ok"/>.</summary>
    public string? Reason { get; }
    public static LineVerifyResult Pass() => new(true, null);
    public static LineVerifyResult Fail(string reason) => new(false, reason);
}

/// <summary>A chat row with its resolved display name and kind.</summary>
public sealed record LineChat(string ChatId, string? Title, string ConvKind, string ChatType, long RowId);

/// <summary>A page of a chat's messages plus the cursor to resume from.</summary>
public sealed record LineMessagePage(IReadOnlyList<ChatMessage> Messages, long MaxRowId, bool HasMore);

/// <summary>
/// An opened, verified, read-only view of a LINE store snapshot. Plain SQLite is opened directly; an
/// encrypted store is opened through the <see cref="ILineStoreUnlocker"/> (the default reports red rather
/// than guessing a key). Verification checks the map's tables/columns are present, a sample row parses, and
/// its timestamp is plausible before any capture (WL3). The connection is read-only and disposed by the caller.
/// </summary>
public sealed class LineStore : IDisposable
{
    private static readonly byte[] SqliteMagic = Encoding.ASCII.GetBytes("SQLite format 3\0");

    private readonly SqliteConnection _c;
    private readonly LineStoreMap _map;
    private Dictionary<string, (string? Title, string ChatType)>? _names;

    private LineStore(SqliteConnection c, LineStoreMap map) { _c = c; _map = map; }

    /// <summary>The db file pattern was matched to this path inside the snapshot.</summary>
    public string DbPath { get; private init; } = "";

    /// <summary>
    /// Locate the db file in <paramref name="snapshotDir"/>, open it (plain or via <paramref name="unlocker"/>),
    /// and verify the map. On any failure returns null and sets <paramref name="reason"/> (the red reason).
    /// </summary>
    public static LineStore? Open(string snapshotDir, LineStoreMap map, ILineStoreUnlocker unlocker, out string? reason)
    {
        reason = null;
        var dbPath = FindDb(snapshotDir, map.DbFilePattern);
        if (dbPath is null)
        {
            reason = $"no file matching '{map.DbFilePattern}' found in the LINE data folder";
            return null;
        }
        var plain = HasSqliteMagic(dbPath);
        SqliteConnection conn;
        if (plain)
        {
            try
            {
                var cs = new SqliteConnectionStringBuilder { DataSource = dbPath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString();
                conn = new SqliteConnection(cs);
                conn.Open();
            }
            catch (SqliteException e) { reason = $"could not open the LINE database: {e.Message}"; return null; }
        }
        else
        {
            var result = unlocker.TryOpen(dbPath, map);
            if (!result.Ok) { reason = result.Reason; return null; }
            conn = result.Connection!;
        }

        var store = new LineStore(conn, map) { DbPath = dbPath };
        var verify = store.Verify();
        if (!verify.Ok)
        {
            reason = verify.Reason;
            conn.Dispose();
            return null;
        }
        return store;
    }

    /// <summary>Check the map against the opened store: tables/columns present, a sample row parses, time plausible.</summary>
    public LineVerifyResult Verify()
    {
        var tables = TableNames();
        if (!tables.Contains(_map.Messages.Table)) return LineVerifyResult.Fail($"message table '{_map.Messages.Table}' is missing");
        if (!tables.Contains(_map.Chats.Table)) return LineVerifyResult.Fail($"chat table '{_map.Chats.Table}' is missing");

        var msgCols = Columns(_map.Messages.Table);
        foreach (var col in _map.Messages.Required())
            if (!msgCols.Contains(col)) return LineVerifyResult.Fail($"column '{_map.Messages.Table}.{col}' is missing (schema drift?)");
        var chatCols = Columns(_map.Chats.Table);
        foreach (var col in _map.Chats.Required())
            if (!chatCols.Contains(col)) return LineVerifyResult.Fail($"column '{_map.Chats.Table}.{col}' is missing (schema drift?)");

        // Sample one message row and check its timestamp is plausible. Zero rows is fine (empty store).
        try
        {
            using var cmd = _c.CreateCommand();
            cmd.CommandText = $"SELECT {Q(_map.Messages.SentAt)}, {Q(_map.Messages.MsgId)} FROM {Q(_map.Messages.Table)} LIMIT 1";
            using var r = cmd.ExecuteReader();
            if (r.Read())
            {
                if (r.IsDBNull(1) || string.IsNullOrEmpty(Convert.ToString(r.GetValue(1), CultureInfo.InvariantCulture)))
                    return LineVerifyResult.Fail($"sample row has an empty '{_map.Messages.MsgId}' (message id)");
                if (!r.IsDBNull(0))
                {
                    var t = ToTimestamp(r.GetValue(0));
                    if (t is null) return LineVerifyResult.Fail($"sample row '{_map.Messages.SentAt}' is not a number");
                    var year = t.Value.Year;
                    if (year is < 2005 or > 2100) return LineVerifyResult.Fail($"sample timestamp year {year} is implausible (wrong column or unit?)");
                }
            }
        }
        catch (SqliteException e) { return LineVerifyResult.Fail($"sample read failed: {e.Message}"); }
        return LineVerifyResult.Pass();
    }

    /// <summary>All chats, with resolved titles and kind.</summary>
    public IReadOnlyList<LineChat> Chats()
    {
        EnsureNames();
        var chats = new List<LineChat>();
        using var cmd = _c.CreateCommand();
        cmd.CommandText = $"SELECT rowid, {Q(_map.Chats.ChatId)} FROM {Q(_map.Chats.Table)} ORDER BY rowid";
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            if (r.IsDBNull(1)) continue;
            var rowid = r.GetInt64(0);
            var chatId = Convert.ToString(r.GetValue(1), CultureInfo.InvariantCulture) ?? "";
            if (chatId.Length == 0) continue;
            var (title, chatType) = Resolve(chatId);
            var kind = chatType == "private" ? "dm" : "group";
            chats.Add(new LineChat(chatId, title, kind, chatType, rowid));
        }
        return chats;
    }

    /// <summary>A page of messages for <paramref name="chatId"/> with <c>rowid &gt; afterRowId</c> (the per-chat cursor).</summary>
    public LineMessagePage ReadMessages(string chatId, long afterRowId, int limit)
    {
        EnsureNames();
        var m = _map.Messages;
        var sb = new StringBuilder();
        sb.Append($"SELECT rowid, {Q(m.MsgId)}, {Q(m.Sender)}, {Q(m.SentAt)}, {Q(m.Text)}");
        if (m.ContentType is not null) sb.Append($", {Q(m.ContentType)}");
        if (m.ContentMetadata is not null) sb.Append($", {Q(m.ContentMetadata)}");
        sb.Append($" FROM {Q(m.Table)} WHERE {Q(m.ChatId)} = $chat AND rowid > $after ORDER BY rowid LIMIT $limit");
        using var cmd = _c.CreateCommand();
        cmd.CommandText = sb.ToString();
        cmd.Parameters.AddWithValue("$chat", chatId);
        cmd.Parameters.AddWithValue("$after", afterRowId);
        cmd.Parameters.AddWithValue("$limit", limit);
        var messages = new List<ChatMessage>();
        var maxRowId = afterRowId;
        var count = 0;
        using (var r = cmd.ExecuteReader())
        {
            var typeOrdinal = m.ContentType is null ? -1 : 5;
            var metaOrdinal = m.ContentMetadata is null ? -1 : (m.ContentType is null ? 5 : 6);
            while (r.Read())
            {
                count++;
                maxRowId = Math.Max(maxRowId, r.GetInt64(0));
                var msgId = Convert.ToString(r.GetValue(1), CultureInfo.InvariantCulture) ?? "";
                if (msgId.Length == 0) continue; // never emit a message without the platform's own id (WX1)
                var senderMid = r.IsDBNull(2) ? "" : Convert.ToString(r.GetValue(2), CultureInfo.InvariantCulture) ?? "";
                var sentAt = r.IsDBNull(3) ? (DateTimeOffset?)null : ToTimestamp(r.GetValue(3));
                var text = r.IsDBNull(4) ? "" : Convert.ToString(r.GetValue(4), CultureInfo.InvariantCulture) ?? "";
                long? contentType = typeOrdinal >= 0 && !r.IsDBNull(typeOrdinal) ? Convert.ToInt64(r.GetValue(typeOrdinal), CultureInfo.InvariantCulture) : null;
                var meta = metaOrdinal >= 0 && !r.IsDBNull(metaOrdinal) ? Convert.ToString(r.GetValue(metaOrdinal), CultureInfo.InvariantCulture) : null;
                messages.Add(new ChatMessage
                {
                    MsgId = msgId,
                    Sender = ResolveSender(senderMid),
                    SentAt = IvyTime.Format(sentAt ?? DateTimeOffset.UnixEpoch),
                    Text = text,
                    SourceStatus = MessageSourceStatus.Live,
                    MediaKind = LineStoreMap.MediaKindFor(contentType),
                    Attachments = LineAttachments.FromContentMetadata(msgId, contentType, meta),
                });
            }
        }
        return new LineMessagePage(messages, maxRowId, HasMore: count == limit);
    }

    // ---------------------------------------------------------------- name resolution

    private void EnsureNames()
    {
        if (_names is not null) return;
        _names = new Dictionary<string, (string?, string)>(StringComparer.Ordinal);
        var n = _map.Names;
        if (n is null) return;
        var tables = TableNames();
        AddNames(n.GroupTable, n.GroupChatId, n.GroupName, "group", tables);
        AddNames(n.SquareTable, n.SquareChatId, n.SquareName, "square", tables);
        AddNames(n.RoomTable, n.RoomChatId, null, "room", tables);
        AddNames(n.ContactTable, n.ContactMid, n.ContactDisplayName, "private", tables);
    }

    private void AddNames(string? table, string? idCol, string? nameCol, string chatType, HashSet<string> tables)
    {
        if (table is null || idCol is null || !tables.Contains(table)) return;
        var cols = Columns(table);
        if (!cols.Contains(idCol)) return;
        var hasName = nameCol is not null && cols.Contains(nameCol);
        try
        {
            using var cmd = _c.CreateCommand();
            cmd.CommandText = hasName
                ? $"SELECT {Q(idCol)}, {Q(nameCol!)} FROM {Q(table)}"
                : $"SELECT {Q(idCol)} FROM {Q(table)}";
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (r.IsDBNull(0)) continue;
                var id = Convert.ToString(r.GetValue(0), CultureInfo.InvariantCulture) ?? "";
                if (id.Length == 0) continue;
                var title = hasName && !r.IsDBNull(1) ? Convert.ToString(r.GetValue(1), CultureInfo.InvariantCulture) : null;
                _names![id] = (title, chatType); // chat tables win over contact because contact is added last
            }
        }
        catch (SqliteException) { /* name resolution is best-effort; missing names are not fatal */ }
    }

    private (string? Title, string ChatType) Resolve(string chatId)
    {
        EnsureNames();
        return _names!.TryGetValue(chatId, out var v) ? v : (null, "private");
    }

    private string ResolveSender(string mid)
    {
        if (mid.Length == 0) return "";
        EnsureNames();
        return _names!.TryGetValue(mid, out var v) && !string.IsNullOrEmpty(v.Item1) ? v.Item1! : mid;
    }

    // ---------------------------------------------------------------- sqlite helpers

    private HashSet<string> TableNames()
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        using var cmd = _c.CreateCommand();
        cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table'";
        using var r = cmd.ExecuteReader();
        while (r.Read()) set.Add(r.GetString(0));
        return set;
    }

    private HashSet<string> Columns(string table)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        using var cmd = _c.CreateCommand();
        cmd.CommandText = $"PRAGMA table_info({Q(table)})";
        using var r = cmd.ExecuteReader();
        while (r.Read()) set.Add(r.GetString(1));
        return set;
    }

    private DateTimeOffset? ToTimestamp(object value)
    {
        if (!long.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
        {
            try { n = Convert.ToInt64(value, CultureInfo.InvariantCulture); }
            catch (FormatException) { return null; }
            catch (InvalidCastException) { return null; }
            catch (OverflowException) { return null; }
        }
        return _map.TimeUnit == LineTimeUnit.UnixSeconds
            ? DateTimeOffset.FromUnixTimeSeconds(n)
            : DateTimeOffset.FromUnixTimeMilliseconds(n);
    }

    /// <summary>Quote an identifier for SQL (double-quote, doubled internal quotes). Only ever used on map values.</summary>
    private static string Q(string identifier) => "\"" + identifier.Replace("\"", "\"\"") + "\"";

    internal static bool HasSqliteMagic(string path)
    {
        try
        {
            using var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var buf = new byte[SqliteMagic.Length];
            var got = 0;
            int read;
            while (got < buf.Length && (read = s.Read(buf, got, buf.Length - got)) > 0) got += read;
            return got == buf.Length && buf.AsSpan().SequenceEqual(SqliteMagic);
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    internal static string? FindDb(string dir, string pattern)
    {
        if (!Directory.Exists(dir)) return null;
        string? best = null;
        long bestSize = -1;
        foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
        {
            var name = Path.GetFileName(f);
            if (name.EndsWith("-wal", StringComparison.OrdinalIgnoreCase) || name.EndsWith("-shm", StringComparison.OrdinalIgnoreCase)) continue;
            if (!Common.Glob.ToRegex(pattern).IsMatch(name)) continue;
            var size = new FileInfo(f).Length;
            if (size > bestSize) { bestSize = size; best = f; } // the live chat store is the largest match
        }
        return best;
    }

    public void Dispose()
    {
        _c.Dispose();
        SqliteConnection.ClearAllPools();
    }
}
