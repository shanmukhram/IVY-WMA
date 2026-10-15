using Ivy.Collectors.Line;
using Microsoft.Data.Sqlite;

// DELETED-TEXT RESIDUE in FTS — when LINE wipes _text on unsend, does the full-text index still hold the words?
// READ-ONLY. Reports COUNTS and lengths only; does NOT print the recovered text (owner can ask to reveal).

string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
string lineDbDir = Path.Combine(localAppData, "LINE", "Data", "db");
string keysDir = Path.Combine(localAppData, "IVY", "keys");
string tempRoot = Path.Combine(Path.GetTempPath(), "linediag_" + Guid.NewGuid().ToString("N"));

// No hardcoded account id: an optional first argument wins, else auto-detect the logged-in account's
// chat store (the qw*.edb with a -wal sidecar), else the largest qw*.edb.
string? ChatStore = args.Length > 0 ? args[0] : FindChatStore(lineDbDir);
if (ChatStore is null) { Console.WriteLine("no LINE chat store (qw*.edb) found; pass the filename as an argument"); return; }
Console.WriteLine($"store: {ChatStore}\n");

Directory.CreateDirectory(tempRoot);
try
{
    var dir = Path.Combine(tempRoot, "B"); Directory.CreateDirectory(dir);
    foreach (var s in new[] { "", "-wal", "-shm" }) { var src = Path.Combine(lineDbDir, ChatStore + s); if (File.Exists(src)) Copy(src, Path.Combine(dir, ChatStore + s)); }
    var edb = File.ReadAllBytes(Path.Combine(dir, ChatStore));
    bool Fits(byte[] p) { try { return LineWxCipher.Decrypt(edb, LineWxCipher.DeriveKey(p)) is not null; } catch { return false; } }
    byte[]? pass = null;
    try { var d = new DpapiLineKeyStore(keysDir); if (d.HasKey) { var k = d.LoadKey(); if (Fits(k)) pass = k; } } catch { }
    if (pass is null && LineKeyFinder.IsLineRunning()) pass = LineKeyFinder.FromRunningLine(Fits);
    if (pass is null) { Console.WriteLine("no key"); return; }
    var unlocker = new KeyedLineUnlocker(new InMemoryLineKeyStore(pass));
    var res = unlocker.TryOpen(Path.Combine(dir, ChatStore), LineStoreMap.ShippedDefault);
    if (!res.Ok || res.Connection is null) { Console.WriteLine(res.Reason); return; }
    using var c = res.Connection;

    // 1) rows that are unsent (UNSENT=1) or have empty text while being a text message
    Console.WriteLine("=== rows: unsent / empty-text (the tombstones) ===");
    using (var cmd = c.CreateCommand())
    {
        cmd.CommandText = @"SELECT rowid, _contentType,
            CASE WHEN json_valid(_contentMetadata) THEN json_extract(_contentMetadata,'$.UNSENT') END AS unsent,
            length(COALESCE(_text,'')) AS textlen
            FROM _message
            WHERE (json_valid(_contentMetadata) AND json_extract(_contentMetadata,'$.UNSENT')=1)
               OR (_contentType=0 AND (_text IS NULL OR _text=''))
            ORDER BY rowid";
        using var r = cmd.ExecuteReader();
        while (r.Read())
            Console.WriteLine($"   rowid={r.GetInt64(0)} ct={r.GetValue(1)} unsent={(r.IsDBNull(2)?"-":r.GetValue(2))} _text_len={r.GetValue(3)}");
    }
    Console.WriteLine();

    // 2) FTS residue: does _message_fts_content still hold text for those rowids?
    Console.WriteLine("=== FTS residue check (_message_fts_content.c0_text by docid) ===");
    long ftsRows = Scalar(c, "SELECT COUNT(*) FROM _message_fts_content");
    long msgRows = Scalar(c, "SELECT COUNT(*) FROM _message");
    Console.WriteLine($"_message rows={msgRows}, _message_fts_content rows={ftsRows}");
    using (var cmd = c.CreateCommand())
    {
        cmd.CommandText = @"SELECT f.docid, length(COALESCE(f.c0_text,'')) AS fts_len, length(COALESCE(m._text,'')) AS msg_len,
              CASE WHEN json_valid(m._contentMetadata) THEN json_extract(m._contentMetadata,'$.UNSENT') END AS unsent
            FROM _message_fts_content f JOIN _message m ON m.rowid = f.docid
            WHERE (m._contentType=0 AND (m._text IS NULL OR m._text='')) OR (json_valid(m._contentMetadata) AND json_extract(m._contentMetadata,'$.UNSENT')=1)
            ORDER BY f.docid";
        using var r = cmd.ExecuteReader();
        int recoverable = 0;
        while (r.Read())
        {
            var ftsLen = r.GetInt64(1); var msgLen = r.GetInt64(2);
            var note = (ftsLen > 0 && msgLen == 0) ? "  <-- TEXT GONE from _message but STILL IN FTS (recoverable!)" : "";
            if (ftsLen > 0 && msgLen == 0) recoverable++;
            Console.WriteLine($"   docid={r.GetInt64(0)} fts_text_len={ftsLen} msg_text_len={msgLen} unsent={(r.IsDBNull(3)?"-":r.GetValue(3))}{note}");
        }
        Console.WriteLine($"\n   recoverable deleted-text messages (empty in _message, present in FTS): {recoverable}");
    }

    // 3) overall: any FTS content rows whose _message._text is empty (broader residue)
    long broad = Scalar(c, "SELECT COUNT(*) FROM _message_fts_content f JOIN _message m ON m.rowid=f.docid WHERE length(COALESCE(f.c0_text,''))>0 AND (m._text IS NULL OR m._text='')");
    Console.WriteLine($"   broader: FTS-has-text but _message._text empty: {broad}");
}
finally { try { SqliteConnection.ClearAllPools(); if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, true); } catch { } }

static string? FindChatStore(string dir)
{
    if (!Directory.Exists(dir)) return null;
    // "qw*.edb" already excludes keep_/album_/chatStats_ (they don't start with "qw").
    var cands = Directory.EnumerateFiles(dir, "qw*.edb").ToList();
    var wal = cands.FirstOrDefault(f => File.Exists(f + "-wal"));           // the logged-in account's store
    var pick = wal ?? cands.OrderByDescending(f => new FileInfo(f).Length).FirstOrDefault();
    return pick is null ? null : Path.GetFileName(pick);
}

static long Scalar(SqliteConnection c, string sql) { using var cmd = c.CreateCommand(); cmd.CommandText = sql; var o = cmd.ExecuteScalar(); return o is null or DBNull ? -1 : Convert.ToInt64(o); }
static void Copy(string src, string dst) { for (var a = 0; a < 3; a++) { try { using var i = new FileStream(src, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); using var o = new FileStream(dst, FileMode.Create, FileAccess.Write, FileShare.None); i.CopyTo(o); return; } catch (IOException) when (a < 2) { Thread.Sleep(150); } } }
