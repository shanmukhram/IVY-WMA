using Ivy.Core.Protocol;

namespace Ivy.Core.Storage;

public sealed record ActivityEntry(long Id, string Timestamp, string? Collector, string Event, string? Detail);

/// <summary>Well-known activity event names.</summary>
public static class ActivityEvents
{
    public const string Encrypted = "encrypted";
    public const string Queued = "queued";
    public const string UploadStarted = "upload_started";
    public const string Uploaded = "uploaded";
    public const string UploadFailed = "upload_failed";
    public const string Reconciled = "reconciled";
    public const string Lost = "lost";
    public const string CommandReceived = "command_received";
    public const string CommandCompleted = "command_completed";
    public const string CommandRejected = "command_rejected";
    public const string Paired = "paired";
    public const string DeviceReport = "device_report";
    public const string Paused = "paused";
    public const string Resumed = "resumed";
}

/// <summary>
/// The UI's live capture-activity feed, persisted in <c>activity_log</c>. Callers must only pass
/// object keys, sizes and outcomes as detail, never captured content.
/// </summary>
public sealed class ActivityLog
{
    private readonly VaultDb _db;
    private readonly TimeProvider _time;
    private readonly int _retain;

    public ActivityLog(VaultDb db, TimeProvider? time = null, int retainEntries = 20_000)
    {
        _db = db;
        _time = time ?? TimeProvider.System;
        _retain = retainEntries;
    }

    /// <summary>Raised after every append (for the live feed).</summary>
    public event EventHandler<ActivityEntry>? Appended;

    public ActivityEntry Append(string? collector, string evt, string? detail = null)
    {
        var ts = IvyTime.Now(_time);
        long id;
        using (var c = _db.Open())
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "INSERT INTO activity_log(timestamp, collector, event, detail) VALUES ($t, $c, $e, $d); SELECT last_insert_rowid();";
            cmd.Parameters.AddWithValue("$t", ts);
            cmd.Parameters.AddWithValue("$c", (object?)collector ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$e", evt);
            cmd.Parameters.AddWithValue("$d", (object?)detail ?? DBNull.Value);
            id = (long)cmd.ExecuteScalar()!;
            if (id % 1000 == 0)
            {
                cmd.Parameters.Clear();
                cmd.CommandText = "DELETE FROM activity_log WHERE id <= $cut";
                cmd.Parameters.AddWithValue("$cut", id - _retain);
                cmd.ExecuteNonQuery();
            }
        }
        var entry = new ActivityEntry(id, ts, collector, evt, detail);
        Appended?.Invoke(this, entry);
        return entry;
    }

    /// <summary>Most recent entries, newest first; pass <paramref name="afterId"/> to page the feed forward.</summary>
    public IReadOnlyList<ActivityEntry> Recent(int limit = 200, long afterId = 0)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, timestamp, collector, event, detail FROM activity_log WHERE id > $a ORDER BY id DESC LIMIT $l";
        cmd.Parameters.AddWithValue("$a", afterId);
        cmd.Parameters.AddWithValue("$l", limit);
        using var r = cmd.ExecuteReader();
        var list = new List<ActivityEntry>();
        while (r.Read())
            list.Add(new ActivityEntry(r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4)));
        return list;
    }
}
