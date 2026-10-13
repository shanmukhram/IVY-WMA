using Ivy.Core.Protocol;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Core.Storage;

public enum QueueStatus { Queued, Uploading, Done }

/// <summary>One row of <c>pending_uploads</c>.</summary>
public sealed record QueueItem(
    string Id, long Seq, string ObjectKey, string PartPath, long Size, int Attempts, QueueStatus Status,
    string Kind, string? GroupKey, string? Collector, string CreatedAt, long NextAttemptMs, string? LastError,
    string? UploadId, long? PartSize);

public sealed record CompletedPart(int PartNumber, string ETag, long Size);

/// <summary>A ciphertext file already written by <see cref="UploadQueue.WritePartFile"/>, ready to enqueue.</summary>
public sealed record PartFile(string ObjectKey, Kind Kind, string FullPath, long Size);

public sealed record ReconcileReport(int ResetUploading, int OrphansRequeued, int OrphansDeleted, int TempFilesDeleted, int RowsMissingFile, int DoneRowsFinalized);

public sealed class BackoffPolicy
{
    public TimeSpan BaseDelay { get; init; } = TimeSpan.FromSeconds(5);
    public TimeSpan MaxDelay { get; init; } = TimeSpan.FromMinutes(30);

    /// <summary>Delay before the next try after <paramref name="attempts"/> failures (1-based): base·2^(n−1), capped.</summary>
    public TimeSpan DelayFor(int attempts)
    {
        if (attempts <= 0) return TimeSpan.Zero;
        var exp = Math.Min(attempts - 1, 30);
        var ms = BaseDelay.TotalMilliseconds * Math.Pow(2, exp);
        return TimeSpan.FromMilliseconds(Math.Min(ms, MaxDelay.TotalMilliseconds));
    }
}

/// <summary>
/// The local encrypted upload queue (WU2/WU3). Invariants:
/// <list type="bullet">
/// <item>Ciphertext is written to the queue directory (temp file, fsync, atomic rename) BEFORE its row is inserted.</item>
/// <item>A row is deleted only after the upload is confirmed (<see cref="Complete"/>): status→done, file deleted, row deleted.</item>
/// <item>Items sharing a <c>group_key</c> upload strictly in <c>seq</c> order (a blob's manifest before its parts,
/// a file_request's status after the blob).</item>
/// <item>Three lanes: <see cref="FastLane"/> (messages, account, avatars, notifications) always drains first, then
/// <see cref="MetaLane"/> (file listings, thumbnails, screenshots), then <see cref="BulkLane"/> (originals the media
/// policy uploads on its own). Two rules keep a blob from being left half-sent behind that ordering: a blob whose
/// manifest has gone out (its next due item is a <c>blob_chunk</c>) is finished before any new meta or bulk work
/// starts, and after <see cref="BulkFairShare"/> meta claims in a row one bulk item is taken, so a continuous
/// stream of file listings cannot hold the bulk lane back indefinitely.</item>
/// <item><see cref="Reconcile"/> repairs any crash window at startup.</item>
/// </list>
/// </summary>
public sealed class UploadQueue
{
    public const string PartExtension = ".ivy";
    // Upload priority lanes (lower drains first). The point is that the UI-critical records — messages,
    // the LINE account, avatars, notifications — never wait behind a big file listing. A full-PC catalogue
    // can be hundreds of thousands of tiny file records; those go in the meta lane so conversations stay fast.
    public const int FastLane = 0;   // messages, line_account, calls, notifications, status, pairing, avatars
    public const int MetaLane = 1;   // file listings (file_meta incl. catalog), thumbnails, screenshots
    public const int BulkLane = 2;   // media-policy originals (large)
    public const int NormalLane = FastLane; // back-compat alias
    private const string TempExtension = ".tmp";
    private readonly VaultDb _db;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly ActivityLog? _activity;
    private readonly object _claimLock = new();
    private int _metaStreak; // meta-lane claims since the last bulk-lane claim (bounded fairness)
    /// <summary>A reconciled blob whose parts all fit under this goes in the fast lane (avatars, tiny thumbnails).</summary>
    private const long SmallBlobBytes = 256 * 1024;

    public UploadQueue(VaultDb db, string queueDirectory, BackoffPolicy? backoff = null, TimeProvider? time = null,
        ActivityLog? activity = null, ILogger<UploadQueue>? logger = null)
    {
        _db = db;
        QueueDirectory = Path.GetFullPath(queueDirectory);
        Directory.CreateDirectory(QueueDirectory);
        Backoff = backoff ?? new BackoffPolicy();
        _time = time ?? TimeProvider.System;
        _activity = activity;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    public string QueueDirectory { get; }
    public BackoffPolicy Backoff { get; }

    /// <summary>
    /// Bounded fairness between the meta and bulk lanes: after this many meta-lane claims in a row, the next claim
    /// takes the oldest due bulk-lane item instead (0 turns it off). The fast lane is never displaced.
    /// </summary>
    public int BulkFairShare { get; set; } = 8;

    /// <summary>Raised after rows are inserted (the uploader listens to wake up).</summary>
    public event EventHandler? Enqueued;

    /// <summary>Queue file name for an object key ('/' is not allowed in file names; '~' never occurs in keys).</summary>
    public static string FileNameFor(string objectKey)
    {
        if (objectKey.Contains('~') || objectKey.Contains('\\') || objectKey.Contains("..")) throw new ArgumentException("invalid object key", nameof(objectKey));
        return objectKey.Replace('/', '~') + PartExtension;
    }

    public static string ObjectKeyFromFileName(string fileName) =>
        fileName.EndsWith(PartExtension, StringComparison.Ordinal)
            ? fileName[..^PartExtension.Length].Replace('~', '/')
            : throw new ArgumentException("not a queue part file", nameof(fileName));

    /// <summary>
    /// Write ciphertext for <paramref name="objectKey"/> into the queue directory durably. Does NOT enqueue;
    /// call <see cref="Enqueue"/> afterwards. Only ciphertext may be passed here.
    /// </summary>
    public PartFile WritePartFile(string objectKey, Kind kind, ReadOnlySpan<byte> ciphertext)
    {
        var final = Path.Combine(QueueDirectory, FileNameFor(objectKey));
        var tmp = final + "." + Guid.NewGuid().ToString("N") + TempExtension;
        using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16, FileOptions.WriteThrough))
        {
            fs.Write(ciphertext);
            fs.Flush(flushToDisk: true);
        }
        File.Move(tmp, final, overwrite: true);
        return new PartFile(objectKey, kind, final, ciphertext.Length);
    }

    /// <summary>Insert rows for already-written part files, in list order, in one transaction.</summary>
    public IReadOnlyList<string> Enqueue(IReadOnlyList<PartFile> files, string? groupKey = null, string? collector = null, int lane = NormalLane)
    {
        if (lane is not (FastLane or MetaLane or BulkLane)) throw new ArgumentOutOfRangeException(nameof(lane));
        var ids = new List<string>(files.Count);
        var now = IvyTime.Now(_time);
        using (IvyUiThread.Write("UploadQueue.Enqueue"))
        using (var c = _db.Open())
        using (var tx = c.BeginTransaction())
        {
            using var seqCmd = c.CreateCommand();
            seqCmd.Transaction = tx;
            seqCmd.CommandText = "SELECT COALESCE(MAX(seq), 0) FROM pending_uploads";
            var seq = (long)seqCmd.ExecuteScalar()!;
            using var ins = c.CreateCommand();
            ins.Transaction = tx;
            ins.CommandText = """
                INSERT INTO pending_uploads(id, seq, object_key, part_path, size, attempts, status, kind, group_key, collector, created_at, next_attempt_ms, lane)
                VALUES ($id, $seq, $key, $path, $size, 0, 'queued', $kind, $group, $collector, $created, 0, $lane)
                """;
            foreach (var f in files)
            {
                if (!File.Exists(f.FullPath)) throw new InvalidOperationException($"part file missing for {f.ObjectKey}");
                var id = Guid.NewGuid().ToString();
                ins.Parameters.Clear();
                ins.Parameters.AddWithValue("$id", id);
                ins.Parameters.AddWithValue("$seq", ++seq);
                ins.Parameters.AddWithValue("$key", f.ObjectKey);
                ins.Parameters.AddWithValue("$path", Path.GetFileName(f.FullPath));
                ins.Parameters.AddWithValue("$size", f.Size);
                ins.Parameters.AddWithValue("$kind", f.Kind.WireName());
                ins.Parameters.AddWithValue("$group", (object?)groupKey ?? DBNull.Value);
                ins.Parameters.AddWithValue("$collector", (object?)collector ?? DBNull.Value);
                ins.Parameters.AddWithValue("$created", now);
                ins.Parameters.AddWithValue("$lane", lane);
                ins.ExecuteNonQuery();
                ids.Add(id);
            }
            tx.Commit();
        }
        Enqueued?.Invoke(this, EventArgs.Empty);
        return ids;
    }

    /// <summary>Write and enqueue a single ciphertext object.</summary>
    public string EnqueueCiphertext(string objectKey, Kind kind, ReadOnlySpan<byte> ciphertext, string? collector = null, string? groupKey = null, int lane = NormalLane) =>
        Enqueue(new[] { WritePartFile(objectKey, kind, ciphertext) }, groupKey, collector, lane)[0];

    public string FullPathOf(QueueItem item) => Path.Combine(QueueDirectory, item.PartPath);

    /// <summary>
    /// Drop every still-queued item of a collector and kind, deleting each part file and its row. Used once
    /// when the catalog switched from one <c>file_meta</c> per file to batched <c>file_catalog</c> records: the
    /// old per-file records are superseded, so removing them lets the compact batches flow instead of the old
    /// backlog draining for hours. Items already uploading or done are left alone. Returns how many were dropped.
    /// </summary>
    public int PurgeQueued(string collector, Kind kind)
    {
        using var c = _db.Open();
        var partPaths = new List<string>();
        using (var sel = c.CreateCommand())
        {
            sel.CommandText = "SELECT part_path FROM pending_uploads WHERE collector = $c AND kind = $k AND status = 'queued'";
            sel.Parameters.AddWithValue("$c", collector);
            sel.Parameters.AddWithValue("$k", kind.WireName());
            using var r = sel.ExecuteReader();
            while (r.Read()) partPaths.Add(r.GetString(0));
        }
        using (var del = c.CreateCommand())
        {
            del.CommandText = "DELETE FROM pending_uploads WHERE collector = $c AND kind = $k AND status = 'queued'";
            del.Parameters.AddWithValue("$c", collector);
            del.Parameters.AddWithValue("$k", kind.WireName());
            var n = del.ExecuteNonQuery();
            foreach (var p in partPaths)
                try { var f = Path.Combine(QueueDirectory, p); if (File.Exists(f)) File.Delete(f); } catch { /* best effort; reconcile cleans stragglers */ }
            return n;
        }
    }

    /// <summary>
    /// Drop every item whose kind is not <paramref name="keep"/>, whatever its status, deleting the rows, their
    /// multipart progress and their part files. Used when the Mac unpairs this device: the unsent backlog is
    /// discarded and only the <c>command_status</c> records (the reply to the unpair) stay to be uploaded. An item
    /// that is mid-upload at this moment may still finish. Returns how many rows were dropped.
    /// </summary>
    public int PurgeAllExcept(Kind keep) => PurgeWhere("kind <> $k", ("$k", keep.WireName()));

    /// <summary>
    /// Empty the queue: delete every row (and multipart progress) and every file in the queue directory, including
    /// leftover temp files and part files that have no row (which <see cref="Reconcile"/> would otherwise re-enqueue).
    /// Used by the pairing reset. Returns how many rows were dropped.
    /// </summary>
    public int PurgeAll()
    {
        var n = PurgeWhere("1 = 1");
        foreach (var f in Directory.EnumerateFiles(QueueDirectory))
            try { File.Delete(f); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { _logger.LogWarning(e, "could not delete queue file {File}", Path.GetFileName(f)); }
        return n;
    }

    private int PurgeWhere(string where, params (string Name, object Value)[] ps)
    {
        var partPaths = new List<string>();
        int n;
        using (IvyUiThread.Write("UploadQueue.Purge"))
        using (var c = _db.Open())
        using (var tx = c.BeginTransaction())
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = tx;
            foreach (var (name, value) in ps) cmd.Parameters.AddWithValue(name, value);
            cmd.CommandText = $"SELECT part_path FROM pending_uploads WHERE {where}";
            using (var r = cmd.ExecuteReader())
                while (r.Read()) partPaths.Add(r.GetString(0));
            cmd.CommandText = $"DELETE FROM pending_upload_parts WHERE upload_row_id IN (SELECT id FROM pending_uploads WHERE {where})";
            cmd.ExecuteNonQuery();
            cmd.CommandText = $"DELETE FROM pending_uploads WHERE {where}";
            n = cmd.ExecuteNonQuery();
            tx.Commit();
        }
        foreach (var p in partPaths)
            try { var f = Path.Combine(QueueDirectory, p); if (File.Exists(f)) File.Delete(f); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { _logger.LogWarning(e, "could not delete queue file {File}", p); }
        return n;
    }

    private const string Columns = "id, seq,object_key, part_path, size, attempts, status, kind, group_key, collector, created_at, next_attempt_ms, last_error, upload_id, part_size";

    private static QueueItem Read(SqliteDataReader r) => new(
        r.GetString(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetInt64(4), r.GetInt32(5),
        r.GetString(6) switch { "queued" => QueueStatus.Queued, "uploading" => QueueStatus.Uploading, _ => QueueStatus.Done },
        r.GetString(7), r.IsDBNull(8) ? null : r.GetString(8), r.IsDBNull(9) ? null : r.GetString(9), r.GetString(10),
        r.GetInt64(11), r.IsDBNull(12) ? null : r.GetString(12), r.IsDBNull(13) ? null : r.GetString(13), r.IsDBNull(14) ? null : r.GetInt64(14));

    // Due: queued, past its backoff gate, and not behind an unfinished earlier item of its group.
    private const string DueWhere = """
        p.status = 'queued' AND p.next_attempt_ms <= $now
          AND (p.group_key IS NULL OR NOT EXISTS (
                SELECT 1 FROM pending_uploads q WHERE q.group_key = p.group_key AND q.seq < p.seq AND q.status <> 'done'))
        """;

    // Claim rank. 0: the fast lane (lane 0). 1: a due part of a blob whose manifest has already gone out (a
    // blob_chunk is only due once every earlier item of its group, the manifest first, is done), so a started blob
    // is finished before new meta or bulk work and its manifest is never left alone in R2 for long. 2: the meta
    // lane (lane 1). 3: the bulk lane.
    private const string Rank = """
        (CASE WHEN p.lane = 0 THEN 0
              WHEN p.kind = 'blob_chunk' AND p.group_key IS NOT NULL THEN 1
              WHEN p.lane = 1 THEN 2 ELSE 3 END)
        """;
    private const int MetaRank = 2, BulkRank = 3;

    /// <summary>
    /// The next item to upload, in claim order: the fast lane, then the remaining parts of blobs whose manifest has
    /// gone out, then the meta lane, then the bulk lane, lowest <c>seq</c> first within each, among items that are
    /// queued, past their backoff gate, and not behind an unfinished earlier item of the same group. (Does not
    /// apply <see cref="BulkFairShare"/>; <see cref="ClaimNextDue"/> does.)
    /// </summary>
    public QueueItem? NextDue()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM pending_uploads p WHERE {DueWhere} ORDER BY {Rank}, p.seq LIMIT 1";
        cmd.Parameters.AddWithValue("$now", _time.GetUtcNow().ToUnixTimeMilliseconds());
        using var r = cmd.ExecuteReader();
        return r.Read() ? Read(r) : null;
    }

    /// <summary>
    /// Atomically take the next due item and mark it <c>uploading</c>, so several uploader workers can drain
    /// the queue in parallel without two of them grabbing the same row. Same ordering as <see cref="NextDue"/>,
    /// plus bounded fairness: after <see cref="BulkFairShare"/> meta-lane claims in a row, a due bulk-lane item is
    /// taken in place of the next meta item. Returns null when nothing is due.
    /// </summary>
    public QueueItem? ClaimNextDue()
    {
        lock (_claimLock)
        {
            using var c = _db.Open();
            using var tx = c.BeginTransaction(deferred: false); // IMMEDIATE: take the write lock up front so claims serialize
            var now = _time.GetUtcNow().ToUnixTimeMilliseconds();
            var (item, rank) = SelectDue(c, tx, now, onlyRank: null);
            if (item is null) { tx.Commit(); return null; }
            if (rank == MetaRank && BulkFairShare > 0 && _metaStreak >= BulkFairShare)
            {
                var (bulk, _) = SelectDue(c, tx, now, onlyRank: BulkRank);
                if (bulk is not null) (item, rank) = (bulk, BulkRank);
            }
            using var upd = c.CreateCommand();
            upd.Transaction = tx;
            upd.CommandText = "UPDATE pending_uploads SET status = 'uploading' WHERE id = $id AND status = 'queued'";
            upd.Parameters.AddWithValue("$id", item.Id);
            var claimed = upd.ExecuteNonQuery() == 1;
            tx.Commit();
            if (!claimed) return null;
            if (rank == MetaRank) { if (_metaStreak < int.MaxValue) _metaStreak++; }
            else if (rank == BulkRank) _metaStreak = 0;
            return item;
        }
    }

    private static (QueueItem? Item, int Rank) SelectDue(SqliteConnection c, SqliteTransaction tx, long now, int? onlyRank)
    {
        using var sel = c.CreateCommand();
        sel.Transaction = tx;
        sel.CommandText = onlyRank is null
            ? $"SELECT {Columns}, {Rank} FROM pending_uploads p WHERE {DueWhere} ORDER BY {Rank}, p.seq LIMIT 1"
            : $"SELECT {Columns}, {Rank} FROM pending_uploads p WHERE {DueWhere} AND {Rank} = $rank ORDER BY p.seq LIMIT 1";
        sel.Parameters.AddWithValue("$now", now);
        if (onlyRank is { } wanted) sel.Parameters.AddWithValue("$rank", wanted);
        using var r = sel.ExecuteReader();
        return r.Read() ? (Read(r), r.GetInt32(15)) : (null, -1);
    }

    /// <summary>Earliest backoff gate among queued items (for the uploader's sleep), or null.</summary>
    public DateTimeOffset? NextAttemptTime()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT MIN(next_attempt_ms) FROM pending_uploads WHERE status = 'queued'";
        var v = cmd.ExecuteScalar();
        return v is long ms ? DateTimeOffset.FromUnixTimeMilliseconds(ms) : null;
    }

    public QueueItem? Get(string id)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM pending_uploads WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        return r.Read() ? Read(r) : null;
    }

    public IReadOnlyList<QueueItem> All()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT {Columns} FROM pending_uploads ORDER BY seq";
        using var r = cmd.ExecuteReader();
        var list = new List<QueueItem>();
        while (r.Read()) list.Add(Read(r));
        return list;
    }

    public int Depth(string? collector = null)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = collector is null
            ? "SELECT COUNT(*) FROM pending_uploads WHERE status <> 'done'"
            : "SELECT COUNT(*) FROM pending_uploads WHERE status <> 'done' AND collector = $c";
        if (collector is not null) cmd.Parameters.AddWithValue("$c", collector);
        return (int)(long)cmd.ExecuteScalar()!;
    }

    /// <summary>Ciphertext bytes still queued in the bulk lane for <paramref name="collector"/> (media-policy originals).</summary>
    public long BulkBytes(string collector)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COALESCE(SUM(size), 0) FROM pending_uploads WHERE status <> 'done' AND lane = $l AND collector = $c";
        cmd.Parameters.AddWithValue("$l", BulkLane);
        cmd.Parameters.AddWithValue("$c", collector);
        return (long)cmd.ExecuteScalar()!;
    }

    /// <summary>True when an object with this key is still in the queue (any status).</summary>
    public bool Contains(string objectKey)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM pending_uploads WHERE object_key = $k";
        cmd.Parameters.AddWithValue("$k", objectKey);
        return cmd.ExecuteScalar() is not null;
    }

    /// <summary>True when any object of blob <paramref name="oid"/> (its manifest or a part) is still in the queue.</summary>
    public bool ContainsBlob(string oid)
    {
        var prefix = BlobPrefix(oid);
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM pending_uploads WHERE group_key = $oid OR substr(object_key, 1, $n) = $p LIMIT 1";
        cmd.Parameters.AddWithValue("$oid", oid);
        cmd.Parameters.AddWithValue("$n", prefix.Length);
        cmd.Parameters.AddWithValue("$p", prefix);
        return cmd.ExecuteScalar() is not null;
    }

    private static string BlobPrefix(string oid)
    {
        var m = ObjectKeys.BlobManifest(oid);
        return m[..(m.LastIndexOf('/') + 1)]; // up/blob/<oid>/
    }

    public IReadOnlyDictionary<string, int> DepthByCollector()
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT collector, COUNT(*) FROM pending_uploads WHERE status <> 'done' AND collector IS NOT NULL GROUP BY collector";
        using var r = cmd.ExecuteReader();
        var d = new Dictionary<string, int>(StringComparer.Ordinal);
        while (r.Read()) d[r.GetString(0)] = (int)r.GetInt64(1);
        return d;
    }

    private void Exec(string sql, params (string Name, object? Value)[] ps)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    public void MarkUploading(string id) => Exec("UPDATE pending_uploads SET status = 'uploading' WHERE id = $id AND status = 'queued'", ("$id", id));

    /// <summary>Record a failed attempt: attempts+1, back to queued, gated by exponential backoff.</summary>
    public TimeSpan MarkFailed(string id, string error)
    {
        using var c = _db.Open();
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "SELECT attempts FROM pending_uploads WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        var attempts = cmd.ExecuteScalar() is long a ? (int)a + 1 : 1;
        var delay = Backoff.DelayFor(attempts);
        cmd.CommandText = "UPDATE pending_uploads SET status = 'queued', attempts = $a, next_attempt_ms = $n, last_error = $e WHERE id = $id";
        cmd.Parameters.AddWithValue("$a", attempts);
        cmd.Parameters.AddWithValue("$n", (_time.GetUtcNow() + delay).ToUnixTimeMilliseconds());
        cmd.Parameters.AddWithValue("$e", error.Length > 500 ? error[..500] : error);
        cmd.ExecuteNonQuery();
        tx.Commit();
        return delay;
    }

    /// <summary>Put an item back to queued without counting an attempt (pause / cancellation).</summary>
    public void Requeue(string id) => Exec("UPDATE pending_uploads SET status = 'queued' WHERE id = $id AND status = 'uploading'", ("$id", id));

    /// <summary>Confirmed upload: mark done, delete the part file, then delete the row (and its multipart parts).</summary>
    public void Complete(string id)
    {
        var item = Get(id);
        if (item is null) return;
        Exec("UPDATE pending_uploads SET status = 'done' WHERE id = $id", ("$id", id));
        var path = FullPathOf(item);
        if (File.Exists(path)) File.Delete(path);
        Exec("DELETE FROM pending_uploads WHERE id = $id", ("$id", id));
    }

    // ---- multipart resume state ----

    public void SetMultipartUpload(string id, string uploadId, long partSize) =>
        Exec("UPDATE pending_uploads SET upload_id = $u, part_size = $s WHERE id = $id", ("$u", uploadId), ("$s", partSize), ("$id", id));

    public void AddCompletedPart(string id, int partNumber, string etag, long size) =>
        Exec("INSERT OR REPLACE INTO pending_upload_parts(upload_row_id, part_number, etag, size) VALUES ($id, $n, $e, $s)",
            ("$id", id), ("$n", partNumber), ("$e", etag), ("$s", size));

    public IReadOnlyList<CompletedPart> GetCompletedParts(string id)
    {
        using var c = _db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT part_number, etag, size FROM pending_upload_parts WHERE upload_row_id = $id ORDER BY part_number";
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        var list = new List<CompletedPart>();
        while (r.Read()) list.Add(new CompletedPart(r.GetInt32(0), r.GetString(1), r.GetInt64(2)));
        return list;
    }

    /// <summary>Forget a multipart upload (e.g. the server no longer knows the upload id) so it restarts.</summary>
    public void ResetMultipart(string id)
    {
        using var c = _db.Open();
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "DELETE FROM pending_upload_parts WHERE upload_row_id = $id; UPDATE pending_uploads SET upload_id = NULL, part_size = NULL WHERE id = $id;";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.ExecuteNonQuery();
        tx.Commit();
    }

    // ---- lost objects ----

    /// <summary>
    /// An item's ciphertext file is gone (found by the uploader at runtime or by <see cref="Reconcile"/>). The row is
    /// removed and the loss is logged with the object key. A blob part cannot be rebuilt on this PC: its content key
    /// exists only inside the manifest, which is sealed to the Mac. So when the lost item belongs to a blob whose
    /// manifest has NOT gone out yet (or is the manifest itself), the rest of that blob is dropped too and logged, so
    /// a manifest is never uploaded for a blob that can no longer be completed. When the manifest already went out,
    /// the remaining parts still upload and the log says plainly that the Mac cannot complete that blob. Records that
    /// only share the group for ordering (a file_request's status) are left to upload. Returns the rows removed.
    /// </summary>
    public int DropLost(QueueItem item, string when)
    {
        var removed = 0;
        if (Get(item.Id) is not null) { Complete(item.Id); removed++; }
        var isBlobKind = item.Kind is "manifest" or "blob_chunk";
        if (!isBlobKind || item.GroupKey is null)
        {
            LogLost(item.Collector, item.ObjectKey, $"{item.ObjectKey} part file missing {when}");
            return removed;
        }
        var rest = All().Where(i => i.GroupKey == item.GroupKey && i.Kind is "manifest" or "blob_chunk" && i.Status != QueueStatus.Uploading).ToList();
        var manifestStillQueued = item.Kind == "manifest" || rest.Any(i => i.Kind == "manifest");
        if (manifestStillQueued)
        {
            LogLost(item.Collector, item.ObjectKey,
                $"{item.ObjectKey} part file missing {when}; blob {item.GroupKey} cannot be completed, so its manifest and remaining parts are not uploaded");
            foreach (var r in rest)
            {
                DeleteRowAndFile(r);
                removed++;
                LogLost(r.Collector, r.ObjectKey, $"{r.ObjectKey} dropped: blob {item.GroupKey} lost {item.ObjectKey}");
            }
        }
        else
        {
            LogLost(item.Collector, item.ObjectKey,
                $"{item.ObjectKey} part file missing {when}; the manifest of blob {item.GroupKey} was already uploaded, so the Mac cannot complete this blob (the part cannot be rebuilt here)");
        }
        return removed;
    }

    private void LogLost(string? collector, string objectKey, string detail)
    {
        _logger.LogWarning("upload queue: {Detail}", detail);
        _activity?.Append(collector, ActivityEvents.Lost, detail);
    }

    private void DeleteRowAndFile(QueueItem item)
    {
        var path = FullPathOf(item);
        Exec("DELETE FROM pending_uploads WHERE id = $id", ("$id", item.Id));
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException e) { _logger.LogWarning(e, "could not delete a dropped queue file for {ObjectKey}", item.ObjectKey); }
    }

    // ---- crash reconciliation ----

    /// <summary>
    /// Startup repair. 'uploading' rows go back to 'queued' (multipart progress is kept); 'done' rows are
    /// finalized; rows whose part file vanished are dropped and logged as lost (with the rest of their blob when its
    /// manifest has not gone out, see <see cref="DropLost"/>); leftover temp files are deleted; orphan part files
    /// (on disk with no row) are re-enqueued where that can still produce a complete blob on the Mac:
    /// <list type="bullet">
    /// <item>a single object: re-enqueued alone;</item>
    /// <item>a blob with its manifest and every part: re-enqueued, manifest first;</item>
    /// <item>a blob with no manifest file whose parts run without a gap up to the last one: re-enqueued. The parts
    /// are written before the manifest and uploaded after it, so a missing manifest with a tail of parts means the
    /// manifest (and any earlier parts) already went out; leaving these parts behind would leave that manifest
    /// alone in R2 forever. (If the process died between writing the last part and the manifest, the parts upload
    /// without a manifest and the Mac quarantines them as orphans.)</item>
    /// <item>anything else (an orphan manifest with parts missing, a gap, or a run of parts that stops before the
    /// last one, i.e. a write that never finished) cannot complete: it is deleted and logged as lost.</item>
    /// </list>
    /// </summary>
    public ReconcileReport Reconcile()
    {
        int reset, missing = 0, doneFinal = 0, tmpDeleted = 0, requeued = 0, orphansDeleted = 0;
        using (var c = _db.Open())
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "UPDATE pending_uploads SET status = 'queued' WHERE status = 'uploading'";
            reset = cmd.ExecuteNonQuery();
        }

        foreach (var item in All())
        {
            if (Get(item.Id) is null) continue; // already dropped with its blob
            var path = FullPathOf(item);
            if (item.Status == QueueStatus.Done)
            {
                if (File.Exists(path)) File.Delete(path);
                Exec("DELETE FROM pending_uploads WHERE id = $id", ("$id", item.Id));
                doneFinal++;
            }
            else if (!File.Exists(path))
            {
                missing += DropLost(item, "at startup");
            }
        }

        foreach (var tmp in Directory.EnumerateFiles(QueueDirectory, "*" + TempExtension))
        {
            File.Delete(tmp);
            tmpDeleted++;
        }

        var referenced = new HashSet<string>(All().Select(i => i.PartPath), StringComparer.Ordinal);
        var singles = new List<PartFile>();
        var blobs = new Dictionary<string, (PartFile? Manifest, SortedDictionary<int, PartFile> Parts)>(StringComparer.Ordinal);
        foreach (var file in Directory.EnumerateFiles(QueueDirectory, "*" + PartExtension).OrderBy(f => f, StringComparer.Ordinal))
        {
            var name = Path.GetFileName(file);
            if (referenced.Contains(name)) continue;
            ParsedKey parsed;
            string key;
            try
            {
                key = ObjectKeyFromFileName(name);
                parsed = ObjectKeys.Parse(key);
            }
            catch (Exception e) when (e is FormatException or ArgumentException)
            {
                File.Delete(file);
                orphansDeleted++;
                continue;
            }
            var size = new FileInfo(file).Length;
            if (parsed.Kind is Kind.Manifest or Kind.BlobChunk)
            {
                var oid = parsed.Oid!;
                if (!blobs.TryGetValue(oid, out var b)) b = (null, new SortedDictionary<int, PartFile>());
                if (parsed.IsManifest) b.Manifest = new PartFile(key, Kind.Manifest, file, size);
                else b.Parts[parsed.ChunkIndex!.Value] = new PartFile(key, Kind.BlobChunk, file, size);
                blobs[oid] = b;
            }
            else
            {
                Kind kind;
                try
                {
                    var header = new byte[Envelope.MinLength];
                    using (var fs = File.OpenRead(file)) fs.ReadExactly(header);
                    kind = Envelope.PeekKind(header);
                }
                catch (Exception e) when (e is IvyCryptoException or EndOfStreamException or IOException)
                {
                    File.Delete(file);
                    orphansDeleted++;
                    continue;
                }
                singles.Add(new PartFile(key, kind, file, size));
            }
        }

        foreach (var s in singles)
        {
            Enqueue(new[] { s }, null, null, s.Kind is Kind.FileMeta or Kind.FileCatalog ? MetaLane : FastLane);
            requeued++;
        }

        foreach (var (oid, b) in blobs)
        {
            // every part names the blob's total; parts that disagree (or cannot be read) make the set unusable
            var totals = b.Parts.Values.Select(TotalFromPart).Distinct().ToList();
            int? total = totals.Count == 1 ? totals[0] : null;
            var first = b.Parts.Count > 0 ? b.Parts.Keys.First() : -1;
            var contiguousToEnd = total is { } t && b.Parts.Count > 0 && b.Parts.Keys.Last() == t - 1
                                  && b.Parts.Keys.SequenceEqual(Enumerable.Range(first, t - first));
            var lane = b.Parts.Count > 0 && b.Parts.Values.Max(p => p.Size) < SmallBlobBytes && (b.Manifest?.Size ?? 0) < SmallBlobBytes ? FastLane : BulkLane;
            if (b.Manifest is not null && contiguousToEnd && first == 0)
            {
                var list = new List<PartFile> { b.Manifest };
                list.AddRange(b.Parts.Values);
                Enqueue(list, oid, null, lane);
                requeued += list.Count;
            }
            else if (b.Manifest is null && contiguousToEnd)
            {
                var list = b.Parts.Values.ToList();
                Enqueue(list, oid, null, lane);
                requeued += list.Count;
                _logger.LogWarning("upload queue: re-queued parts {First}..{Last} of blob {Oid} found without a queue row; its manifest is not in the queue (it was uploaded earlier, or the process stopped before writing it)",
                    first, total - 1, oid);
                _activity?.Append(null, ActivityEvents.Reconciled, $"blob {oid}: re-queued {list.Count} part(s) whose manifest is not in the queue");
            }
            else
            {
                var why = b.Manifest is not null
                    ? "its manifest was never uploaded and parts are missing"
                    : total is null ? "its parts are unreadable or disagree on the chunk count"
                    : $"parts {string.Join(",", b.Parts.Keys)} of {total} do not run to the last part (an interrupted write)";
                if (b.Manifest is not null) { File.Delete(b.Manifest.FullPath); orphansDeleted++; }
                foreach (var p in b.Parts.Values) { File.Delete(p.FullPath); orphansDeleted++; }
                LogLost(null, ObjectKeys.BlobManifest(oid), $"blob {oid}: orphan files deleted at startup, the blob cannot be completed ({why})");
            }
        }

        var report = new ReconcileReport(reset, requeued, orphansDeleted, tmpDeleted, missing, doneFinal);
        if (reset + requeued + orphansDeleted + tmpDeleted + missing + doneFinal > 0)
        {
            _logger.LogInformation("queue reconciled: {Report}", report);
            _activity?.Append(null, ActivityEvents.Reconciled,
                $"reset={reset} requeued={requeued} orphansDeleted={orphansDeleted} tmp={tmpDeleted} missing={missing} done={doneFinal}");
        }
        return report;
    }

    private static int? TotalFromPart(PartFile part)
    {
        try
        {
            var header = new byte[ChunkedEncryptor.ChunkHeaderLen + AesGcm256.TagLen];
            using (var fs = File.OpenRead(part.FullPath)) fs.ReadExactly(header);
            return Chunked.ParseChunkHeader(header).TotalChunks;
        }
        catch (Exception e) when (e is IvyCryptoException or EndOfStreamException or IOException)
        {
            return null;
        }
    }
}
