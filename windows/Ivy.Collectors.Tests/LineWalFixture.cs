using System.Buffers.Binary;
using Ivy.Collectors.Line;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Tests;

/// <summary>
/// A LINE-shaped store (from <see cref="LineFixture"/>) switched to WAL mode with automatic checkpoints off and
/// a writer connection kept open, so every row written through <see cref="Writer"/> lives only in the "-wal"
/// file, as it does while LINE is running. Dispose closes the writer (which may checkpoint the live copy; tests
/// only ever use copies taken before that).
/// </summary>
internal sealed class LineWalStore : IDisposable
{
    private LineWalStore(string path, SqliteConnection writer, int pageSize)
    {
        LivePath = path;
        Writer = writer;
        PageSize = pageSize;
    }

    public string LivePath { get; }
    public SqliteConnection Writer { get; }
    public int PageSize { get; }

    /// <summary>Create the store in <paramref name="liveDir"/>; <paramref name="mainRows"/> are written before
    /// the switch to WAL mode, so they sit in the main file.</summary>
    public static LineWalStore Create(string liveDir, Action<SqliteConnection>? mainRows = null)
    {
        var path = LineFixture.Create(liveDir);
        if (mainRows is not null)
        {
            using var c = LineFixture.Open(path);
            mainRows(c);
        }
        SqliteConnection.ClearAllPools();
        var w = LineFixture.Open(path);
        LineFixture.Exec(w, "PRAGMA journal_mode=wal; PRAGMA wal_autocheckpoint=0;");
        using var cmd = w.CreateCommand();
        cmd.CommandText = "PRAGMA page_size;";
        var ps = Convert.ToInt32(cmd.ExecuteScalar());
        return new LineWalStore(path, w, ps);
    }

    /// <summary>Number of whole frames currently in the live WAL.</summary>
    public int FrameCount
    {
        get
        {
            var fi = new FileInfo(LivePath + "-wal");
            return fi.Exists && fi.Length >= LineWalBytes.HeaderSize ? (int)((fi.Length - LineWalBytes.HeaderSize) / (LineWalBytes.FrameHeaderSize + PageSize)) : 0;
        }
    }

    /// <summary>Copy the db and its -wal/-shm side-cars (shared read, writer still open) to <paramref name="destDb"/>.</summary>
    public void CopyTo(string destDb, bool includeShm = true)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destDb)!);
        foreach (var s in includeShm ? new[] { "", "-wal", "-shm" } : new[] { "", "-wal" })
            if (File.Exists(LivePath + s)) File.WriteAllBytes(destDb + s, ReadShared(LivePath + s));
    }

    /// <summary>The main file and the WAL as bytes.</summary>
    public (byte[] Main, byte[] Wal) ReadFiles() => (ReadShared(LivePath), ReadShared(LivePath + "-wal"));

    /// <summary>The _message ids visible in the main file alone (a copy with no -wal beside it).</summary>
    public List<string> MainOnlyMessageIds(string scratchDir)
    {
        Directory.CreateDirectory(scratchDir);
        var copy = Path.Combine(scratchDir, "main-only.edb");
        File.WriteAllBytes(copy, ReadShared(LivePath));
        var ids = new List<string>();
        using (var c = LineFixture.Open(copy))
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT _id FROM _message ORDER BY _id";
            using var r = cmd.ExecuteReader();
            while (r.Read()) ids.Add(r.GetString(0));
        }
        SqliteConnection.ClearAllPools();
        return ids;
    }

    private static byte[] ReadShared(string path)
    {
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var ms = new MemoryStream();
        input.CopyTo(ms);
        return ms.ToArray();
    }

    public void Dispose()
    {
        Writer.Dispose();
        SqliteConnection.ClearAllPools();
    }
}

/// <summary>Byte-level helpers for SQLite WAL files: frame layout, re-encryption and the checksum chain.</summary>
internal static class LineWalBytes
{
    public const int HeaderSize = 32;
    public const int FrameHeaderSize = 24;
    public const uint MagicLittleEndian = 0x377f0682;

    public static int FrameOffset(int index, int pageSize) => HeaderSize + index * (FrameHeaderSize + pageSize);

    public static bool BigEndianSums(byte[] wal) => (BinaryPrimitives.ReadUInt32BigEndian(wal) & 1) == 1;

    public static uint PageNumber(byte[] wal, int index, int pageSize) =>
        BinaryPrimitives.ReadUInt32BigEndian(wal.AsSpan(FrameOffset(index, pageSize)));

    public static uint CommitSize(byte[] wal, int index, int pageSize) =>
        BinaryPrimitives.ReadUInt32BigEndian(wal.AsSpan(FrameOffset(index, pageSize) + 4));

    public static void SetCommitSize(byte[] wal, int index, int pageSize, uint value) =>
        BinaryPrimitives.WriteUInt32BigEndian(wal.AsSpan(FrameOffset(index, pageSize) + 4), value);

    /// <summary>Frames from the start whose salts match the header (the ones SQLite could consider).</summary>
    public static int ValidFrameCount(byte[] wal, int pageSize)
    {
        var n = 0;
        for (var off = HeaderSize; off + FrameHeaderSize + pageSize <= wal.Length; off += FrameHeaderSize + pageSize, n++)
            if (!wal.AsSpan(off + 8, 8).SequenceEqual(wal.AsSpan(16, 8))) break;
        return n;
    }

    /// <summary>Encrypt every frame's page as wxSQLite3 would (page key from the frame's page number), then
    /// recompute the checksum chain over the encrypted bytes.</summary>
    public static void EncryptFrames(byte[] wal, int pageSize, byte[] baseKey)
    {
        var frames = ValidFrameCount(wal, pageSize);
        for (var i = 0; i < frames; i++)
        {
            var off = FrameOffset(i, pageSize);
            LineWxCipher.EncryptPage(wal.AsSpan(off + FrameHeaderSize, pageSize), (int)PageNumber(wal, i, pageSize), baseKey);
        }
        Rechain(wal, pageSize, 0);
    }

    /// <summary>Recompute frame checksums from frame <paramref name="fromFrame"/> to the end, continuing from the
    /// previous frame's stored checksum (or the header's for frame 0): over frame bytes 0..7, then the page,
    /// written to frame bytes 16..23.</summary>
    public static void Rechain(byte[] wal, int pageSize, int fromFrame)
    {
        var be = BigEndianSums(wal);
        var prev = fromFrame == 0 ? 24 : FrameOffset(fromFrame - 1, pageSize) + 16;
        uint s1 = BinaryPrimitives.ReadUInt32BigEndian(wal.AsSpan(prev)), s2 = BinaryPrimitives.ReadUInt32BigEndian(wal.AsSpan(prev + 4));
        var frames = ValidFrameCount(wal, pageSize);
        for (var i = fromFrame; i < frames; i++)
        {
            var off = FrameOffset(i, pageSize);
            LineWal.Checksum(wal.AsSpan(off, 8), be, ref s1, ref s2);
            LineWal.Checksum(wal.AsSpan(off + FrameHeaderSize, pageSize), be, ref s1, ref s2);
            BinaryPrimitives.WriteUInt32BigEndian(wal.AsSpan(off + 16), s1);
            BinaryPrimitives.WriteUInt32BigEndian(wal.AsSpan(off + 20), s2);
        }
    }

    /// <summary>A hand-built WAL header (version 3007000, given salts) with a valid header checksum.</summary>
    public static byte[] Header(int pageSize, uint magic = MagicLittleEndian, uint salt1 = 0x11223344, uint salt2 = 0x55667788)
    {
        var h = new byte[HeaderSize];
        BinaryPrimitives.WriteUInt32BigEndian(h.AsSpan(0), magic);
        BinaryPrimitives.WriteUInt32BigEndian(h.AsSpan(4), 3007000);
        BinaryPrimitives.WriteUInt32BigEndian(h.AsSpan(8), (uint)pageSize);
        BinaryPrimitives.WriteUInt32BigEndian(h.AsSpan(12), 0); // checkpoint sequence
        BinaryPrimitives.WriteUInt32BigEndian(h.AsSpan(16), salt1);
        BinaryPrimitives.WriteUInt32BigEndian(h.AsSpan(20), salt2);
        uint s1 = 0, s2 = 0;
        LineWal.Checksum(h.AsSpan(0, 24), (magic & 1) == 1, ref s1, ref s2);
        BinaryPrimitives.WriteUInt32BigEndian(h.AsSpan(24), s1);
        BinaryPrimitives.WriteUInt32BigEndian(h.AsSpan(28), s2);
        return h;
    }

    /// <summary>Append a frame (salts from the header, page filled with <paramref name="fill"/>) and chain its checksum.</summary>
    public static byte[] AppendFrame(byte[] wal, int pageSize, uint pageNumber, uint commitSize, byte fill = 0xAB)
    {
        var result = new byte[wal.Length + FrameHeaderSize + pageSize];
        wal.CopyTo(result, 0);
        var off = wal.Length;
        BinaryPrimitives.WriteUInt32BigEndian(result.AsSpan(off), pageNumber);
        BinaryPrimitives.WriteUInt32BigEndian(result.AsSpan(off + 4), commitSize);
        wal.AsSpan(16, 8).CopyTo(result.AsSpan(off + 8, 8));
        result.AsSpan(off + FrameHeaderSize, pageSize).Fill(fill);
        Rechain(result, pageSize, (off - HeaderSize) / (FrameHeaderSize + pageSize));
        return result;
    }
}
