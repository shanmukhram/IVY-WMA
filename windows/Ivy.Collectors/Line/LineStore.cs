using System.Globalization;
using System.Text;
using System.Text.Json;
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
    public LineMessagePage ReadMessages(LineChat chat, long afterRowId, int limit)
    {
        var chatId = chat.ChatId;
        var isDm = chat.ConvKind == "dm";
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
                // In a 1:1 chat the chatId is the peer's mid: a message whose sender is not that peer is mine
                // (own messages carry my own mid or an empty sender). Groups need the own mid, which we may not
                // have, so fromMe stays unknown there rather than guessed.
                // Prefer the account's own mid (works for groups too); a 1:1's non-peer sender (or an empty
                // sender, which LINE uses for some own messages) is mine; otherwise unknown.
                var ownMid = OwnMid();
                bool? fromMe;
                if (senderMid.Length > 0 && ownMid is not null) fromMe = senderMid == ownMid;
                else if (isDm) fromMe = senderMid != chatId;
                else fromMe = null;
                var resolved = senderMid.Length > 0 && _names!.TryGetValue(senderMid, out var nv) ? nv.Item1 : null;
                var senderName = fromMe == true ? "You" : resolved;
                messages.Add(new ChatMessage
                {
                    MsgId = msgId,
                    Sender = senderMid,                 // stable platform id (merge key)
                    FromMe = fromMe,
                    SenderName = string.IsNullOrEmpty(senderName) ? null : senderName,
                    SentAt = IvyTime.Format(sentAt ?? DateTimeOffset.UnixEpoch),
                    Text = text,
                    SourceStatus = MessageSourceStatus.Live,
                    MediaKind = LineStoreMap.MediaKindFor(contentType),
                    Call = LineCalls.FromContentMetadata(contentType, meta, fromMe),
                    Attachments = LineAttachments.FromContentMetadata(msgId, contentType, meta),
                });
            }
        }
        return new LineMessagePage(messages, maxRowId, HasMore: count == limit);
    }

    /// <summary>
    /// Read the account snapshot for the settings page: own profile, contacts (with their raw status/type/
    /// settings so blocked can be determined, and picture refs), chat options (hidden), and the setting table.
    /// Reads contact and chat metadata only, never message bodies. Columns are read defensively.
    /// </summary>
    public LineAccount ReadAccount()
    {
        var tables = TableNames();
        LineOwnProfile? profile = null;
        var n = _map.Names;
        if (n?.OwnProfileTable is { } pt && tables.Contains(pt))
        {
            var cols = Columns(pt);
            string? Sel(string c) => cols.Contains(c) ? Q(c) : null;
            var mid = Sel("_mid"); if (mid is not null)
            {
                var pick = new[] { "_mid", "_displayName", "_userid", "_statusMessage", "_picturePath" }.Where(cols.Contains).ToArray();
                using var cmd = _c.CreateCommand();
                cmd.CommandText = $"SELECT {string.Join(",", pick.Select(Q))} FROM {Q(pt)} WHERE {Q("_mid")} IS NOT NULL LIMIT 1";
                using var r = cmd.ExecuteReader();
                if (r.Read())
                {
                    string? G(string c) { var i = Array.IndexOf(pick, c); return i < 0 || r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i), CultureInfo.InvariantCulture); }
                    profile = new LineOwnProfile(G("_mid") ?? "", G("_displayName"), G("_userid"), G("_statusMessage"), G("_picturePath"));
                }
            }
        }

        var contacts = new List<LineContactRow>();
        if (n?.ContactTable is { } ct && tables.Contains(ct))
        {
            var cols = Columns(ct);
            // In 26.x most plain columns are NULL and the profile lives in a JSON column; read both, plain first.
            const string BlockJson = "_blockDetail";
            var pick = new[] { "_mid", "_displayName", "_status", "_type", "_settings", "_statusMessage", "_picturePath", "_thumbnailUrl",
                    n.ContactDisplayNameOverride, n.ContactProfileJson, BlockJson }
                .OfType<string>().Distinct().Where(cols.Contains).ToArray();
            if (pick.Contains("_mid"))
            {
                using var cmd = _c.CreateCommand();
                cmd.CommandText = $"SELECT {string.Join(",", pick.Select(Q))} FROM {Q(ct)} WHERE {Q("_mid")} IS NOT NULL";
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    string? G(string? c) { var i = c is null ? -1 : Array.IndexOf(pick, c); return i < 0 || r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i), CultureInfo.InvariantCulture); }
                    int? GI(string c) { var i = Array.IndexOf(pick, c); return i < 0 || r.IsDBNull(i) ? (int?)null : Convert.ToInt32(r.GetValue(i)); }
                    string? Plain(string c) => string.IsNullOrWhiteSpace(G(c)) ? null : G(c);
                    var profileJson = ParseObject(G(n.ContactProfileJson));
                    // notBlocked is used only when it is a plain JSON true/false; any other shape leaves blocked unknown.
                    var notBlocked = JsonBool(ParseObject(G(BlockJson)), "notBlocked");
                    contacts.Add(new LineContactRow(G("_mid") ?? "",
                        PickContactName(G(n.ContactDisplayNameOverride), G("_displayName"), JsonString(profileJson, n.ContactProfileNameKey)),
                        G("_status"), G("_type"), GI("_settings"),
                        Plain("_statusMessage") ?? JsonString(profileJson, "statusMessage"),
                        Plain("_picturePath") ?? JsonString(profileJson, "picturePath"),
                        G("_thumbnailUrl"),
                        notBlocked is { } nb ? !nb : null));
                }
            }
        }

        var options = new List<LineChatOptionRow>();
        if (tables.Contains("_chatOption"))
        {
            var cols = Columns("_chatOption");
            var pick = new[] { "_id", "_hidden", "_notification", "_pinnedTime" }.Where(cols.Contains).ToArray();
            if (pick.Contains("_id"))
            {
                using var cmd = _c.CreateCommand();
                cmd.CommandText = $"SELECT {string.Join(",", pick.Select(Q))} FROM {Q("_chatOption")} WHERE {Q("_id")} IS NOT NULL";
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    string? G(string c) { var i = Array.IndexOf(pick, c); return i < 0 || r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i), CultureInfo.InvariantCulture); }
                    bool? GB(string c) { var i = Array.IndexOf(pick, c); return i < 0 || r.IsDBNull(i) ? (bool?)null : Convert.ToInt64(r.GetValue(i)) != 0; }
                    long? GL(string c) { var i = Array.IndexOf(pick, c); return i < 0 || r.IsDBNull(i) ? (long?)null : Convert.ToInt64(r.GetValue(i)); }
                    options.Add(new LineChatOptionRow(G("_id") ?? "", GB("_hidden"), GB("_notification"), (GL("_pinnedTime") ?? 0) > 0));
                }
            }
        }

        var settings = new List<(string Key, string Value)>();
        if (tables.Contains("_setting") && Columns("_setting").IsSupersetOf(new[] { "_key", "_value" }))
        {
            using var cmd = _c.CreateCommand();
            cmd.CommandText = $"SELECT {Q("_key")},{Q("_value")} FROM {Q("_setting")}";
            using var r = cmd.ExecuteReader();
            while (r.Read())
                if (!r.IsDBNull(0)) settings.Add((Convert.ToString(r.GetValue(0), CultureInfo.InvariantCulture) ?? "",
                    r.IsDBNull(1) ? "" : Convert.ToString(r.GetValue(1), CultureInfo.InvariantCulture) ?? ""));
        }

        return new LineAccount(profile, contacts, options, settings);
    }

    // ---------------------------------------------------------------- name resolution

    private string? _ownMid;
    private bool _ownMidLoaded;

    /// <summary>
    /// The logged-in account's own mid (from the own-profile table), or null when it cannot be read. LINE keeps
    /// one store per account, so this tells the stores of two accounts on the same PC apart.
    /// </summary>
    public string? AccountId => OwnMid();

    /// <summary>The account's own mid from the profile table, cached; null if not readable. Marks fromMe.</summary>
    private string? OwnMid()
    {
        if (_ownMidLoaded) return _ownMid;
        _ownMidLoaded = true;
        var n = _map.Names;
        if (n?.OwnProfileTable is null || n.OwnProfileMid is null) return null;
        var tables = TableNames();
        if (!tables.Contains(n.OwnProfileTable) || !Columns(n.OwnProfileTable).Contains(n.OwnProfileMid)) return null;
        try
        {
            using var cmd = _c.CreateCommand();
            cmd.CommandText = $"SELECT {Q(n.OwnProfileMid)} FROM {Q(n.OwnProfileTable)} WHERE {Q(n.OwnProfileMid)} IS NOT NULL LIMIT 1";
            var v = cmd.ExecuteScalar();
            _ownMid = v is null or DBNull ? null : Convert.ToString(v, CultureInfo.InvariantCulture);
        }
        catch { _ownMid = null; }
        return _ownMid;
    }

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
        AddContactNames(n, tables);
    }

    /// <summary>
    /// Contact names, in order: the user's own rename (<see cref="LineNameTables.ContactDisplayNameOverride"/>),
    /// then the plain <see cref="LineNameTables.ContactDisplayName"/>, then the profile name inside the
    /// <see cref="LineNameTables.ContactProfileJson"/> column (where LINE 26.x keeps it). Only columns that
    /// exist are read. A contact with no name still registers as a private chat with a null title.
    /// </summary>
    private void AddContactNames(LineNameTables n, HashSet<string> tables)
    {
        if (n.ContactTable is not { } table || n.ContactMid is not { } idCol || !tables.Contains(table)) return;
        var cols = Columns(table);
        if (!cols.Contains(idCol)) return;
        var overrideCol = n.ContactDisplayNameOverride is { } o && cols.Contains(o) ? o : null;
        var plainCol = n.ContactDisplayName is { } d && cols.Contains(d) ? d : null;
        var jsonCol = n.ContactProfileJson is { } j && n.ContactProfileNameKey is not null && cols.Contains(j) ? j : null;
        var pick = new[] { idCol, overrideCol, plainCol, jsonCol }.OfType<string>().Distinct().ToArray();
        try
        {
            using var cmd = _c.CreateCommand();
            cmd.CommandText = $"SELECT {string.Join(", ", pick.Select(Q))} FROM {Q(table)}";
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                if (r.IsDBNull(0)) continue;
                var id = Convert.ToString(r.GetValue(0), CultureInfo.InvariantCulture) ?? "";
                if (id.Length == 0) continue;
                string? G(string? c) { if (c is null) return null; var i = Array.IndexOf(pick, c); return i < 0 || r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i), CultureInfo.InvariantCulture); }
                var title = PickContactName(G(overrideCol), G(plainCol), JsonString(ParseObject(G(jsonCol)), n.ContactProfileNameKey));
                _names![id] = (title, "private"); // added last, so a contact row overrides a chat-table row with the same id
            }
        }
        catch (SqliteException) { /* name resolution is best-effort; missing names are not fatal */ }
    }

    /// <summary>First non-empty of: the user's rename, the plain display name, the profile name from JSON.</summary>
    internal static string? PickContactName(string? overridden, string? plain, string? profileName) =>
        !string.IsNullOrWhiteSpace(overridden) ? overridden
        : !string.IsNullOrWhiteSpace(plain) ? plain
        : !string.IsNullOrWhiteSpace(profileName) ? profileName
        : null;

    /// <summary>Parse a JSON text value as an object; null for empty, malformed or non-object values.</summary>
    internal static JsonElement? ParseObject(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == JsonValueKind.Object ? doc.RootElement.Clone() : null;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>A non-empty string value at a top-level key of a JSON object; null otherwise.</summary>
    internal static string? JsonString(JsonElement? obj, string? key)
    {
        if (obj is not { } o || key is null || !o.TryGetProperty(key, out var v) || v.ValueKind != JsonValueKind.String) return null;
        var s = v.GetString();
        return string.IsNullOrWhiteSpace(s) ? null : s;
    }

    /// <summary>A boolean value at a top-level key of a JSON object; null when absent or not a JSON true/false.</summary>
    internal static bool? JsonBool(JsonElement? obj, string key)
    {
        if (obj is not { } o || !o.TryGetProperty(key, out var v)) return null;
        return v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };
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
                _names![id] = (title, chatType); // a later table overwrites an earlier one for the same id
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

    /// <summary>
    /// The chat store to read: the one with a <c>-wal</c> beside it (the logged-in account while LINE runs).
    /// With no <c>-wal</c> anywhere (LINE closed), the store named <paramref name="preferred"/> (the
    /// <c>qw&lt;hex&gt;</c> name, without extension, of the store last opened successfully) if it still
    /// exists, else the largest match. Preferring the last-opened store keeps a closed LINE on the account
    /// whose key is stored instead of falling to another account's larger store.
    /// </summary>
    internal static string? FindDb(string dir, string pattern, string? preferred = null)
    {
        if (!Directory.Exists(dir)) return null;
        string? withWal = null; long withWalSize = -1;   // the live message store has a -wal sidecar
        string? preferredMatch = null;                     // the store last opened successfully
        string? anyMatch = null; long anySize = -1;        // fallback: the largest match
        foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
        {
            var name = Path.GetFileName(f);
            if (name.EndsWith("-wal", StringComparison.OrdinalIgnoreCase) || name.EndsWith("-shm", StringComparison.OrdinalIgnoreCase)) continue;
            // These are not the chat store: Keep, albums, chat stats and auto-suggest have their own databases.
            if (name.StartsWith("keep_", StringComparison.OrdinalIgnoreCase) || name.StartsWith("album_", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("chatStats_", StringComparison.OrdinalIgnoreCase)) continue;
            if (!Common.Glob.ToRegex(pattern).IsMatch(name)) continue;
            var size = new FileInfo(f).Length;
            if (size > anySize) { anySize = size; anyMatch = f; }
            if (preferred is not null && preferredMatch is null
                && string.Equals(Path.GetFileNameWithoutExtension(name), preferred, StringComparison.OrdinalIgnoreCase))
                preferredMatch = f;
            // Among several candidates (album_, chatStats_, keep_, AutoSuggest...), the one with a -wal
            // sidecar is the active chat store, not merely the largest file.
            if (File.Exists(f + "-wal") && size > withWalSize) { withWalSize = size; withWal = f; }
        }
        return withWal ?? preferredMatch ?? anyMatch;
    }

    public void Dispose()
    {
        _c.Dispose();
        SqliteConnection.ClearAllPools();
    }
}

