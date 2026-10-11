using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Ivy.Collectors.Line;

/// <summary>
/// Reads the SQLite write-ahead log (the "-wal" file) that sits beside an encrypted LINE store and folds its
/// committed pages into the decrypted main file. LINE keeps the store in WAL mode, so messages it has written
/// but not yet checkpointed exist only in the WAL until LINE quits. wxSQLite3 encrypts each WAL frame's page
/// with the same per-page cipher as the main file (page key from the frame's page number, page 1 handled
/// specially), so each kept page is decrypted with <see cref="LineWxCipher.DecryptPage"/>.
///
/// This follows SQLite's own WAL recovery rules and nothing looser: a frame counts only if its salts match the
/// WAL header and the running checksum (over the stored, encrypted bytes) matches; reading stops at the first
/// frame that fails; only frames up to the last commit frame are used; for a repeated page the later frame
/// wins. Anything that does not validate is dropped, never patched up. If the WAL cannot be used at all, the
/// main file is returned unchanged. Works only on the private snapshot copy, never on LINE's live files.
/// </summary>
internal static class LineWal
{
    private const int WalHeaderSize = 32;
    private const int FrameHeaderSize = 24;
    private const uint MagicLittleEndian = 0x377f0682; // checksums use little-endian words
    private const uint MagicBigEndian = 0x377f0683;    // checksums use big-endian words
    private const uint FormatVersion = 3007000;

    /// <summary>The committed content of a WAL: for each page number, the offset (into the WAL) of the page
    /// bytes of the latest committed frame holding it, plus the database size in pages after the last commit.</summary>
    internal sealed record Committed(int PageSize, uint DbSizePages, IReadOnlyDictionary<uint, int> PageOffsets);

    /// <summary>
    /// Parse <paramref name="wal"/> and return its committed frames, or null if the WAL is too short, has an
    /// unknown magic or version, a bad header checksum, a page size other than <paramref name="expectedPageSize"/>,
    /// or no valid commit frame. Page data is not decrypted here.
    /// </summary>
    internal static Committed? ReadCommitted(ReadOnlySpan<byte> wal, int expectedPageSize)
    {
        if (wal.Length < WalHeaderSize) return null;
        var magic = BinaryPrimitives.ReadUInt32BigEndian(wal);
        bool bigEndianSums;
        if (magic == MagicBigEndian) bigEndianSums = true;
        else if (magic == MagicLittleEndian) bigEndianSums = false;
        else return null;
        if (BinaryPrimitives.ReadUInt32BigEndian(wal[4..]) != FormatVersion) return null;
        if (BinaryPrimitives.ReadUInt32BigEndian(wal[8..]) != (uint)expectedPageSize) return null;
        var salt1 = BinaryPrimitives.ReadUInt32BigEndian(wal[16..]);
        var salt2 = BinaryPrimitives.ReadUInt32BigEndian(wal[20..]);

        uint s1 = 0, s2 = 0;
        Checksum(wal[..24], bigEndianSums, ref s1, ref s2);
        if (s1 != BinaryPrimitives.ReadUInt32BigEndian(wal[24..]) || s2 != BinaryPrimitives.ReadUInt32BigEndian(wal[28..]))
            return null;

        var frameSize = FrameHeaderSize + expectedPageSize;
        var pending = new Dictionary<uint, int>();   // frames of the transaction still being read
        var committed = new Dictionary<uint, int>(); // frames up to the last commit frame
        uint dbSize = 0;
        for (var off = WalHeaderSize; off + frameSize <= wal.Length; off += frameSize)
        {
            var fh = wal.Slice(off, FrameHeaderSize);
            var pgno = BinaryPrimitives.ReadUInt32BigEndian(fh);
            var commitSize = BinaryPrimitives.ReadUInt32BigEndian(fh[4..]);
            if (pgno == 0) break;
            if (BinaryPrimitives.ReadUInt32BigEndian(fh[8..]) != salt1 || BinaryPrimitives.ReadUInt32BigEndian(fh[12..]) != salt2) break;
            // The checksum chain continues from the previous frame (or the header) over the first 8 bytes of
            // this frame header and then the page exactly as stored (still encrypted).
            uint c1 = s1, c2 = s2;
            Checksum(fh[..8], bigEndianSums, ref c1, ref c2);
            Checksum(wal.Slice(off + FrameHeaderSize, expectedPageSize), bigEndianSums, ref c1, ref c2);
            if (c1 != BinaryPrimitives.ReadUInt32BigEndian(fh[16..]) || c2 != BinaryPrimitives.ReadUInt32BigEndian(fh[20..])) break;
            s1 = c1; s2 = c2;

            pending[pgno] = off + FrameHeaderSize; // a later frame for the same page replaces the earlier one
            if (commitSize != 0)
            {
                foreach (var (p, o) in pending) committed[p] = o;
                pending.Clear();
                dbSize = commitSize;
            }
        }
        // Frames left in `pending` come after the last commit frame: an unfinished transaction, dropped.
        if (dbSize == 0) return null;
        return new Committed(expectedPageSize, dbSize, committed);
    }

    /// <summary>
    /// Overlay the committed WAL pages onto the decrypted main file <paramref name="plain"/>. Returns the
    /// buffer to use from now on: either <paramref name="plain"/> itself (WAL unusable, or size unchanged) or a
    /// new buffer of the committed size, in which case the old one has been zeroed. If any kept page fails to
    /// decrypt (the page 1 header check), the WAL is ignored as a whole and <paramref name="plain"/> is returned
    /// unchanged, so a transaction is never half-applied.
    /// </summary>
    internal static byte[] Overlay(byte[] plain, ReadOnlySpan<byte> wal, byte[] baseKey)
    {
        var pageSize = LineWxCipher.PageSizeOf(plain);
        if (pageSize == 0) return plain;
        var frames = ReadCommitted(wal, pageSize);
        if (frames is null) return plain;
        var newLength = (long)frames.DbSizePages * pageSize;
        if (newLength > Array.MaxLength) return plain;

        // Pages beyond the final database size were truncated away by a later commit, so they are skipped.
        // Decrypt every kept page into a scratch buffer first, so a failure leaves `plain` untouched.
        var kept = frames.PageOffsets.Where(kv => kv.Key <= frames.DbSizePages).ToArray();
        var scratch = new byte[kept.Length * pageSize];
        try
        {
            for (var i = 0; i < kept.Length; i++)
            {
                var page = scratch.AsSpan(i * pageSize, pageSize);
                wal.Slice(kept[i].Value, pageSize).CopyTo(page);
                if (!LineWxCipher.DecryptPage(page, (int)kept[i].Key, baseKey)) return plain;
            }

            var result = plain;
            if (newLength != plain.Length)
            {
                result = new byte[newLength];
                plain.AsSpan(0, (int)Math.Min(plain.Length, newLength)).CopyTo(result);
                CryptographicOperations.ZeroMemory(plain);
            }
            for (var i = 0; i < kept.Length; i++)
                scratch.AsSpan(i * pageSize, pageSize).CopyTo(result.AsSpan((int)((kept[i].Key - 1) * (long)pageSize), pageSize));
            return result;
        }
        finally { CryptographicOperations.ZeroMemory(scratch); }
    }

    /// <summary>
    /// Make a decrypted copy open on its own: switch the header from WAL mode to rollback-journal mode (bytes
    /// 18 and 19 = 1) so SQLite does not look for a "-wal" beside the copy, store the real page count at
    /// bytes 28..31, and copy the change counter (24..27) into version-valid-for (92..95) so SQLite trusts that
    /// count.
    /// </summary>
    internal static void MakeSelfContained(byte[] plain)
    {
        var pageSize = LineWxCipher.PageSizeOf(plain);
        if (pageSize == 0 || plain.Length < 100) return;
        plain[18] = 1;
        plain[19] = 1;
        BinaryPrimitives.WriteUInt32BigEndian(plain.AsSpan(28), (uint)(plain.Length / pageSize));
        plain.AsSpan(24, 4).CopyTo(plain.AsSpan(92, 4));
    }

    /// <summary>Read a snapshot's copy of the WAL, or null if there is none or it cannot be read. Callers pass
    /// only paths inside a snapshot directory, never LINE's live folder.</summary>
    internal static byte[]? TryReadFile(string walPath)
    {
        try { return File.Exists(walPath) ? File.ReadAllBytes(walPath) : null; }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    /// <summary>SQLite's WAL checksum (walChecksumBytes): runs over pairs of 32-bit words, continuing from s1/s2.</summary>
    internal static void Checksum(ReadOnlySpan<byte> data, bool bigEndian, ref uint s1, ref uint s2)
    {
        for (var i = 0; i + 8 <= data.Length; i += 8)
        {
            uint x0, x1;
            if (bigEndian) { x0 = BinaryPrimitives.ReadUInt32BigEndian(data[i..]); x1 = BinaryPrimitives.ReadUInt32BigEndian(data[(i + 4)..]); }
            else { x0 = BinaryPrimitives.ReadUInt32LittleEndian(data[i..]); x1 = BinaryPrimitives.ReadUInt32LittleEndian(data[(i + 4)..]); }
            unchecked { s1 += x0 + s2; s2 += x1 + s1; }
        }
    }
}
