using Ivy.Collectors.Telegram.Client;
using Ivy.Core.Storage;

namespace Ivy.Collectors.Telegram;

/// <summary>
/// Collector-owned tables for the Telegram collector, created additively in <c>vault-agent.db</c>. Metadata
/// only (conversation keys, message ids, attachment references, oids, timestamps) — never message text or
/// attachment bytes, and never any auth-key material (WX2).
/// </summary>
public sealed class TelegramStore
{
    private readonly VaultDb _db;

    public TelegramStore(VaultDb db)
    {
        _db = db;
        EnsureSchema();
    }

    private void EnsureSchema()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            -- Per-chat sync cursors (WT2). oldest_fetched_id walks the backfill from newest to oldest;
            -- newest_seen_id is the high-water mark for incremental dedupe; history_complete flips when the
            -- backfill reaches the start of the chat.
            CREATE TABLE IF NOT EXISTS tg_chat_state (
                conv_key          TEXT PRIMARY KEY,
                account           TEXT NOT NULL,
                conv_kind         TEXT NOT NULL,          -- dm | group
                is_channel        INTEGER NOT NULL DEFAULT 0,
                peer              TEXT,
                title             TEXT,
                chat_type         TEXT,
                participant_count INTEGER,
                top_message_id    INTEGER NOT NULL DEFAULT 0,
                oldest_fetched_id INTEGER,                -- null until the first page is fetched
                newest_seen_id    INTEGER NOT NULL DEFAULT 0,
                history_complete  INTEGER NOT NULL DEFAULT 0,
                messages_seen     INTEGER NOT NULL DEFAULT 0,
                updated_at        TEXT
            );
            -- Attachment references, so an on-request file_request (tg:<ref>) can resolve to the client handle,
            -- and auto-uploaded originals are not uploaded twice (dedupe by ref, and by originHash when known).
            CREATE TABLE IF NOT EXISTS tg_attachments (
                att_ref     TEXT PRIMARY KEY,             -- the client file reference
                conv_key    TEXT NOT NULL,
                msg_id      INTEGER NOT NULL,
                kind        TEXT NOT NULL,                -- image | video | audio | doc
                filename    TEXT NOT NULL,
                size        INTEGER NOT NULL,
                origin_hash TEXT,
                blob_oid    TEXT,                         -- set once uploaded (auto or on request)
                status      TEXT NOT NULL                 -- metadata | uploaded
            );
            CREATE INDEX IF NOT EXISTS ix_tg_attachments_hash ON tg_attachments(origin_hash);
            -- Secret chats seen on the session: reported as phone-only in status (WT3), never emitted as records.
            CREATE TABLE IF NOT EXISTS tg_phone_only (
                conv_key TEXT PRIMARY KEY,
                detail   TEXT
            );
            """;
        cmd.ExecuteNonQuery();

        // Added later: the chatMeta.listing (normal | archived) last sent to the Mac for this chat, so a change
        // with no new messages can be sent as a metadata-only batch. Null until a batch carried it.
        using var cols = c.CreateCommand();
        cols.CommandText = "SELECT COUNT(*) FROM pragma_table_info('tg_chat_state') WHERE name = 'listing'";
        if ((long)cols.ExecuteScalar()! == 0)
        {
            using var alter = c.CreateCommand();
            alter.CommandText = "ALTER TABLE tg_chat_state ADD COLUMN listing TEXT";
            alter.ExecuteNonQuery();
        }
    }

    /// <summary>The chatMeta.listing last sent for <paramref name="convKey"/>, or null if none was sent yet.</summary>
    public string? GetSentListing(string convKey)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT listing FROM tg_chat_state WHERE conv_key = $k";
        cmd.Parameters.AddWithValue("$k", convKey);
        return cmd.ExecuteScalar() as string;
    }

    /// <summary>Record the chatMeta.listing just sent for <paramref name="convKey"/>.</summary>
    public void SetSentListing(string convKey, string listing)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "UPDATE tg_chat_state SET listing = $l WHERE conv_key = $k";
        cmd.Parameters.AddWithValue("$l", listing);
        cmd.Parameters.AddWithValue("$k", convKey);
        cmd.ExecuteNonQuery();
    }

    public sealed record ChatState(
        string ConvKey, string Account, string ConvKind, bool IsChannel, string? Peer, string? Title, string? ChatType,
        int? ParticipantCount, long TopMessageId, long? OldestFetchedId, long NewestSeenId, bool HistoryComplete, long MessagesSeen);

    public ChatState? GetChat(string convKey)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT conv_key, account, conv_kind, is_channel, peer, title, chat_type, participant_count, top_message_id, oldest_fetched_id, newest_seen_id, history_complete, messages_seen FROM tg_chat_state WHERE conv_key = $k";
        cmd.Parameters.AddWithValue("$k", convKey);
        using var r = cmd.ExecuteReader();
        return r.Read() ? ReadChat(r) : null;
    }

    public IReadOnlyList<ChatState> AllChats()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT conv_key, account, conv_kind, is_channel, peer, title, chat_type, participant_count, top_message_id, oldest_fetched_id, newest_seen_id, history_complete, messages_seen FROM tg_chat_state ORDER BY conv_key";
        using var r = cmd.ExecuteReader();
        var list = new List<ChatState>();
        while (r.Read()) list.Add(ReadChat(r));
        return list;
    }

    private static ChatState ReadChat(Microsoft.Data.Sqlite.SqliteDataReader r) => new(
        r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3) != 0,
        r.IsDBNull(4) ? null : r.GetString(4), r.IsDBNull(5) ? null : r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6),
        r.IsDBNull(7) ? null : r.GetInt32(7), r.GetInt64(8), r.IsDBNull(9) ? null : r.GetInt64(9),
        r.GetInt64(10), r.GetInt64(11) != 0, r.GetInt64(12));

    /// <summary>Register (or refresh the metadata of) a dialog without disturbing its cursors.</summary>
    public void UpsertDialog(string account, TgDialog d)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO tg_chat_state(conv_key, account, conv_kind, is_channel, peer, title, chat_type, participant_count, top_message_id, updated_at)
            VALUES ($k, $a, $ck, $ch, $p, $t, $cty, $pc, $top, $u)
            ON CONFLICT(conv_key) DO UPDATE SET
                conv_kind = excluded.conv_kind, is_channel = excluded.is_channel, peer = excluded.peer,
                title = excluded.title, chat_type = excluded.chat_type, participant_count = excluded.participant_count,
                top_message_id = MAX(tg_chat_state.top_message_id, excluded.top_message_id), updated_at = excluded.updated_at
            """;
        cmd.Parameters.AddWithValue("$k", d.ConvKey);
        cmd.Parameters.AddWithValue("$a", account);
        cmd.Parameters.AddWithValue("$ck", d.ConvKind == TgConvKind.Group ? "group" : "dm");
        cmd.Parameters.AddWithValue("$ch", d.IsChannel ? 1 : 0);
        cmd.Parameters.AddWithValue("$p", (object?)d.Peer ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$t", (object?)d.Meta.Title ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$cty", (object?)d.Meta.ChatType ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$pc", (object?)d.Meta.ParticipantCount ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$top", d.TopMessageId);
        cmd.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToString("O"));
        cmd.ExecuteNonQuery();
    }

    public void UpdateCursors(string convKey, long? oldestFetchedId, long newestSeenId, bool historyComplete, long messagesSeenDelta)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            UPDATE tg_chat_state SET
                oldest_fetched_id = CASE WHEN $oldest IS NULL THEN oldest_fetched_id
                    WHEN oldest_fetched_id IS NULL THEN $oldest ELSE MIN(oldest_fetched_id, $oldest) END,
                newest_seen_id = MAX(newest_seen_id, $newest),
                history_complete = CASE WHEN $complete = 1 THEN 1 ELSE history_complete END,
                messages_seen = messages_seen + $delta,
                updated_at = $u
            WHERE conv_key = $k
            """;
        cmd.Parameters.AddWithValue("$oldest", (object?)oldestFetchedId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$newest", newestSeenId);
        cmd.Parameters.AddWithValue("$complete", historyComplete ? 1 : 0);
        cmd.Parameters.AddWithValue("$delta", messagesSeenDelta);
        cmd.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToString("O"));
        cmd.Parameters.AddWithValue("$k", convKey);
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Clear every chat's backfill progress so the next tick re-walks all history from the latest message.
    /// Used by the one-time re-sync: existing chats were captured before message sides, sender names and
    /// avatars existed, and those ride on freshly emitted records. The Mac merges by platform message id, so
    /// re-emitting updates each message in place rather than duplicating it. newest_seen_id is left alone so
    /// incremental dedupe is unaffected. Returns the number of chats reset.
    /// </summary>
    public int ResetHistory()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "UPDATE tg_chat_state SET history_complete = 0, oldest_fetched_id = NULL, messages_seen = 0, updated_at = $u";
        cmd.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToString("O"));
        return cmd.ExecuteNonQuery();
    }

    // ---- attachments ----

    public sealed record AttachmentRow(string AttRef, string ConvKey, long MsgId, string Kind, string Filename, long Size, string? OriginHash, string? BlobOid, string Status);

    public AttachmentRow? GetAttachment(string attRef)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT att_ref, conv_key, msg_id, kind, filename, size, origin_hash, blob_oid, status FROM tg_attachments WHERE att_ref = $r";
        cmd.Parameters.AddWithValue("$r", attRef);
        using var r = cmd.ExecuteReader();
        return r.Read()
            ? new AttachmentRow(r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetString(3), r.GetString(4), r.GetInt64(5),
                r.IsDBNull(6) ? null : r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7), r.GetString(8))
            : null;
    }

    /// <summary>Reuse the oid an identical attachment (same originHash) already got, so content is uploaded once.</summary>
    public string? OidForHash(string originHash)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT blob_oid FROM tg_attachments WHERE origin_hash = $h AND blob_oid IS NOT NULL LIMIT 1";
        cmd.Parameters.AddWithValue("$h", originHash);
        return cmd.ExecuteScalar() as string;
    }

    public void UpsertAttachment(AttachmentRow row)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO tg_attachments(att_ref, conv_key, msg_id, kind, filename, size, origin_hash, blob_oid, status)
            VALUES ($r, $k, $m, $kind, $f, $s, $h, $o, $st)
            ON CONFLICT(att_ref) DO UPDATE SET blob_oid = COALESCE(excluded.blob_oid, tg_attachments.blob_oid),
                status = excluded.status, origin_hash = COALESCE(excluded.origin_hash, tg_attachments.origin_hash)
            """;
        cmd.Parameters.AddWithValue("$r", row.AttRef);
        cmd.Parameters.AddWithValue("$k", row.ConvKey);
        cmd.Parameters.AddWithValue("$m", row.MsgId);
        cmd.Parameters.AddWithValue("$kind", row.Kind);
        cmd.Parameters.AddWithValue("$f", row.Filename);
        cmd.Parameters.AddWithValue("$s", row.Size);
        cmd.Parameters.AddWithValue("$h", (object?)row.OriginHash ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$o", (object?)row.BlobOid ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$st", row.Status);
        cmd.ExecuteNonQuery();
    }

    // ---- phone-only (secret) chats ----

    public void MarkPhoneOnly(string convKey, string? detail)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT OR REPLACE INTO tg_phone_only(conv_key, detail) VALUES ($k, $d)";
        cmd.Parameters.AddWithValue("$k", convKey);
        cmd.Parameters.AddWithValue("$d", (object?)detail ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    public int PhoneOnlyCount()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM tg_phone_only";
        return (int)(long)cmd.ExecuteScalar()!;
    }
}
