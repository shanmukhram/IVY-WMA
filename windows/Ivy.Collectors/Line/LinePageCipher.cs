using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Ivy.Collectors.Line;

/// <summary>The page cipher of an encrypted SQLite store, as a small set of parameters.</summary>
public sealed record LineCipherConfig
{
    /// <summary>AES key length in bytes: 16 (AES-128) or 32 (AES-256).</summary>
    public required int KeyBytes { get; init; }

    /// <summary>SQLite page size in bytes (power of two, 512..65536). LINE's WAL header reports the real one.</summary>
    public required int PageSize { get; init; }

    /// <summary>
    /// Bytes reserved at the end of every page for the cipher. For an IV-at-page-end layout this is 16
    /// (the per-page IV); a SQLCipher-style layout reserves 48 (IV 16 + HMAC 32). The encrypted region is
    /// <see cref="PageSize"/> minus this.
    /// </summary>
    public required int ReservedBytes { get; init; }

    /// <summary>
    /// How many plaintext bytes at the very start of page 1 are kept outside the cipher. A container that
    /// prepends a fixed magic (LINE) carries it here; a per-file-salt scheme (SQLCipher) carries 16.
    /// </summary>
    public int Page1HeaderBytes { get; init; }

    public static LineCipherConfig Aes128IvTail(int pageSize = 4096) =>
        new() { KeyBytes = 16, PageSize = pageSize, ReservedBytes = 16 };

    public static LineCipherConfig Aes256IvTail(int pageSize = 4096) =>
        new() { KeyBytes = 32, PageSize = pageSize, ReservedBytes = 16 };
}

/// <summary>
/// Decrypts an encrypted SQLite store a page at a time into a plaintext file, given a raw key and a
/// <see cref="LineCipherConfig"/>. This is the machinery the LINE unlocker needs once a key is known; it
/// produces data only when the result is a valid SQLite file (<see cref="LooksLikeSqlite"/>), so a wrong
/// key or wrong config yields nothing rather than garbage (PRD WL3, never guess into the vault). The key
/// itself is supplied by the caller and held only in memory; this type neither stores nor logs it (WX2).
///
/// IV-at-page-end layout: each page is <c>ciphertext ‖ iv(16) ‖ (reserved tail)</c>, AES-CBC with that IV.
/// Page 1 keeps its first <see cref="LineCipherConfig.Page1HeaderBytes"/> bytes in the clear.
/// </summary>
public static class LinePageCipher
{
    public static readonly byte[] SqliteHeader = System.Text.Encoding.ASCII.GetBytes("SQLite format 3\0");

    /// <summary>True if <paramref name="page1"/> begins with the SQLite file magic.</summary>
    public static bool LooksLikeSqlite(ReadOnlySpan<byte> page1) =>
        page1.Length >= 16 && page1[..16].SequenceEqual(SqliteHeader);

    /// <summary>
    /// Decrypt <paramref name="encrypted"/> (a whole store file) with <paramref name="key"/> and
    /// <paramref name="config"/>. Returns the plaintext bytes when the first decrypted page is valid SQLite;
    /// returns null (no exception) when the key/config does not fit, so a caller can try another.
    /// </summary>
    public static byte[]? TryDecrypt(ReadOnlySpan<byte> encrypted, ReadOnlySpan<byte> key, LineCipherConfig config)
    {
        if (key.Length != config.KeyBytes) return null;
        var pageSize = config.PageSize;
        if (pageSize < 512 || (pageSize & (pageSize - 1)) != 0) return null;
        if (encrypted.Length < pageSize || encrypted.Length % pageSize != 0) return null;

        var encRegion = pageSize - config.ReservedBytes;
        if (encRegion <= 0 || encRegion % 16 != 0) return null;

        var pages = encrypted.Length / pageSize;
        var outBuf = new byte[encrypted.Length];
        using var aes = Aes.Create();
        aes.KeySize = config.KeyBytes * 8;
        aes.Key = key.ToArray();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.None;

        for (var p = 0; p < pages; p++)
        {
            var pageStart = p * pageSize;
            var page = encrypted.Slice(pageStart, pageSize);
            var outPage = outBuf.AsSpan(pageStart, pageSize);

            // The reserved tail (IV + any MAC) is copied through so page offsets stay identical.
            page[encRegion..].CopyTo(outPage[encRegion..]);

            var headerBytes = p == 0 ? config.Page1HeaderBytes : 0;
            if (headerBytes > 0) page[..headerBytes].CopyTo(outPage[..headerBytes]);

            var iv = page.Slice(encRegion, 16);
            var cipherStart = headerBytes;
            var cipherLen = encRegion - headerBytes;
            if (cipherLen <= 0 || cipherLen % 16 != 0) return null;

            try
            {
                var plain = aes.DecryptCbc(page.Slice(cipherStart, cipherLen), iv, PaddingMode.None);
                plain.CopyTo(outPage[cipherStart..]);
            }
            catch (CryptographicException) { return null; }

            if (p == 0 && !LooksLikeSqlite(outPage)) return null; // wrong key/config
        }

        // Validate the page size recorded in the decrypted header matches what we used (bytes 16..17, BE;
        // the value 1 means 65536). A match is strong evidence the key and page size are right.
        var declared = BinaryPrimitives.ReadUInt16BigEndian(outBuf.AsSpan(16, 2));
        var declaredSize = declared == 1 ? 65536 : declared;
        if (declaredSize != pageSize) return null;

        return outBuf;
    }
}
