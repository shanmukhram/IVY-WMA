using System.Security.Cryptography;

namespace Ivy.Collectors.Line;

/// <summary>
/// Decrypts a LINE for Windows chat store, which is a wxSQLite3 (SQLite3 Multiple Ciphers) AES-128-CBC
/// page-encrypted database in its "new" (non-legacy) mode. The algorithm is transcribed from the wxSQLite3
/// source (<c>cipher_wxaes128.c</c>, <c>codec_algos.c</c>) and matches the scheme documented for LINE v7.x in
/// Kang, Kim, Hur and Kim, "Forensic Analysis of wxSQLite3-Encrypted Databases", Electronics 13(7):1325, 2024.
///
/// The passphrase is a 32-character hex string LINE receives from its server at login; it is not on disk.
/// This type only performs the decryption given that passphrase. It produces plaintext bytes only when the
/// page-1 header check passes (a wrong passphrase yields null), so it never emits garbage (PRD WL3). The
/// passphrase is supplied by the caller and is not stored or logged here (WX2).
/// </summary>
public static class LineWxCipher
{
    private static readonly byte[] Padding =
    {
        0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
        0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
    };
    private static readonly byte[] Salt = { 0x73, 0x41, 0x6C, 0x54 }; // "sAlT"
    private static readonly byte[] SqliteMagic = System.Text.Encoding.ASCII.GetBytes("SQLite format 3\0");

    private static byte[] Md5(ReadOnlySpan<byte> data) => MD5.HashData(data);

    /// <summary>tdesktop-independent RC4 (as wxSQLite3 uses it): keystream XOR over <paramref name="data"/>.</summary>
    private static void Rc4(ReadOnlySpan<byte> key, Span<byte> data)
    {
        Span<byte> s = stackalloc byte[256];
        for (var i = 0; i < 256; i++) s[i] = (byte)i;
        int j = 0;
        for (var i = 0; i < 256; i++)
        {
            j = (j + s[i] + key[i % key.Length]) & 0xff;
            (s[i], s[j]) = (s[j], s[i]);
        }
        int a = 0, b = 0;
        for (var n = 0; n < data.Length; n++)
        {
            a = (a + 1) & 0xff;
            b = (b + s[a]) & 0xff;
            (s[a], s[b]) = (s[b], s[a]);
            data[n] ^= s[(s[a] + s[b]) & 0xff];
        }
    }

    private static byte[] Pad(ReadOnlySpan<byte> password)
    {
        var p = new byte[32];
        var m = Math.Min(password.Length, 32);
        password[..m].CopyTo(p);
        for (int i = m, k = 0; i < 32; i++, k++) p[i] = Padding[k];
        return p;
    }

    /// <summary>Derive the 16-byte base encryption key from the passphrase (GenerateKeyAES128Cipher).</summary>
    public static byte[] DeriveKey(ReadOnlySpan<byte> passphrase)
    {
        var userPad = Pad(passphrase);
        var ownerPad = Pad(ReadOnlySpan<byte>.Empty);

        var digest = Md5(ownerPad);
        for (var k = 0; k < 50; k++) digest = Md5(digest.AsSpan(0, 16));

        var ownerKey = (byte[])userPad.Clone();
        Span<byte> mkey = stackalloc byte[16];
        for (var i = 0; i < 20; i++)
        {
            for (var j = 0; j < 16; j++) mkey[j] = (byte)(digest[j] ^ i);
            Rc4(mkey, ownerKey);
        }

        var enc = new byte[64];
        userPad.CopyTo(enc, 0);
        ownerKey.CopyTo(enc, 32);
        digest = Md5(enc);
        for (var k = 0; k < 50; k++) digest = Md5(digest.AsSpan(0, 16));
        return digest.AsSpan(0, 16).ToArray();
    }

    private static byte[] PageKey(byte[] baseKey, int page)
    {
        var nkey = new byte[16 + 4 + 4];
        baseKey.CopyTo(nkey, 0);
        nkey[16] = (byte)page; nkey[17] = (byte)(page >> 8); nkey[18] = (byte)(page >> 16); nkey[19] = (byte)(page >> 24);
        Salt.CopyTo(nkey, 20);
        return Md5(nkey).AsSpan(0, 16).ToArray();
    }

    private static byte[] PageIv(int page)
    {
        long z = page + 1;
        var initkey = new byte[16];
        for (var j = 0; j < 4; j++)
        {
            // MODMULT(52774, 40692, 3791, 2147483399, z)
            long q = z / 52774;
            z = 40692 * (z - 52774 * q) - 3791 * q;
            if (z < 0) z += 2147483399L;
            initkey[4 * j + 0] = (byte)z;
            initkey[4 * j + 1] = (byte)(z >> 8);
            initkey[4 * j + 2] = (byte)(z >> 16);
            initkey[4 * j + 3] = (byte)(z >> 24);
        }
        return Md5(initkey).AsSpan(0, 16).ToArray();
    }

    private static void AesCbc(byte[] baseKey, int page, bool encrypt, Span<byte> data)
    {
        var pk = PageKey(baseKey, page);
        var iv = PageIv(page);
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.None;
        aes.Key = pk;
        var outBuf = encrypt ? aes.EncryptCbc(data, iv, PaddingMode.None) : aes.DecryptCbc(data, iv, PaddingMode.None);
        outBuf.CopyTo(data);
    }

    /// <summary>
    /// Cheap check that a base key fits the store, using only page 1 (bytes 16..23 decrypt back to the
    /// plaintext header backup). Lets detection test many candidate keys without decrypting the whole file.
    /// </summary>
    public static bool KeyFits(ReadOnlySpan<byte> page1, byte[] baseKey)
    {
        if (page1.Length < 24) return false;
        var pageSize = (page1[16] << 8) | (page1[17] << 16);
        if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) != 0 || page1.Length < pageSize) return false;
        var span = page1[..pageSize].ToArray().AsSpan();
        var dbHeader = span.Slice(16, 8).ToArray();
        span.Slice(8, 8).CopyTo(span.Slice(16, 8));
        AesCbc(baseKey, 1, false, span.Slice(16, pageSize - 16));
        return span.Slice(16, 8).SequenceEqual(dbHeader);
    }

    /// <summary>
    /// Decrypt one page in place. <paramref name="page"/> is exactly one page as stored on disk (or in a WAL
    /// frame) and <paramref name="pageNumber"/> is its 1-based SQLite page number, which selects the page key
    /// and IV. Page 1 gets the wxaes128 treatment: bytes 16..23 are stored in the clear, the encrypted copy of
    /// them sits at 8..15, and bytes 0..15 are discarded and replaced with the SQLite magic. Returns false only
    /// for page 1 when the decrypted header does not match the clear copy (wrong key or not this scheme); in
    /// that case the buffer contents are undefined and the caller should zero and discard it.
    /// </summary>
    internal static bool DecryptPage(Span<byte> page, int pageNumber, byte[] baseKey)
    {
        if (pageNumber == 1)
        {
            Span<byte> dbHeader = stackalloc byte[8];
            page.Slice(16, 8).CopyTo(dbHeader);       // plaintext header backup
            page.Slice(8, 8).CopyTo(page.Slice(16, 8)); // restore the encrypted bytes 16..23
            AesCbc(baseKey, 1, false, page.Slice(16, page.Length - 16));
            if (!page.Slice(16, 8).SequenceEqual(dbHeader)) return false; // wrong key
            SqliteMagic.CopyTo(page.Slice(0, 16));
            return true;
        }
        AesCbc(baseKey, pageNumber, false, page);
        return true;
    }

    /// <summary>
    /// Encrypt one plaintext page in place, the inverse of <see cref="DecryptPage"/> (page 1 included). Used
    /// by <see cref="Encrypt"/> and by tests that build an encrypted store or WAL.
    /// </summary>
    internal static void EncryptPage(Span<byte> page, int pageNumber, byte[] baseKey)
    {
        if (pageNumber == 1)
        {
            Span<byte> dbHeader = stackalloc byte[8];
            page.Slice(16, 8).CopyTo(dbHeader);                     // save plaintext header
            AesCbc(baseKey, 1, true, page.Slice(0, 16));            // encrypt the magic block (discarded on read)
            AesCbc(baseKey, 1, true, page.Slice(16, page.Length - 16));
            page.Slice(16, 8).CopyTo(page.Slice(8, 8));             // move encrypted 16..23 to 8..15
            dbHeader.CopyTo(page.Slice(16, 8));                     // restore plaintext 16..23
            return;
        }
        AesCbc(baseKey, pageNumber, true, page);
    }

    /// <summary>Page size from page 1 bytes 16..17 (big-endian, where the stored value 1 means 65536).</summary>
    internal static int PageSizeOf(ReadOnlySpan<byte> page1Header)
    {
        if (page1Header.Length < 18) return 0;
        var pageSize = (page1Header[16] << 8) | (page1Header[17] << 16);
        return pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) != 0 ? 0 : pageSize;
    }

    /// <summary>
    /// Decrypt a whole wxSQLite3 AES-128-CBC store with the base key from <see cref="DeriveKey"/>. Returns the
    /// plaintext SQLite bytes, or null if page 1 does not validate (wrong passphrase / not this scheme).
    /// This covers the main file only; <see cref="LineWal"/> overlays committed WAL frames afterwards.
    /// </summary>
    public static byte[]? Decrypt(ReadOnlySpan<byte> file, byte[] baseKey)
    {
        if (file.Length < 24) return null;
        // Page size lives in plaintext bytes 16..17 of page 1 (wxaes128 keeps 16..23 in the clear).
        var pageSize = PageSizeOf(file);
        if (pageSize == 0) return null;
        if (file.Length % pageSize != 0) return null;

        var outBuf = file.ToArray();
        var pages = file.Length / pageSize;
        for (var p = 0; p < pages; p++)
        {
            // wxSQLite3 page numbers are 1-based
            if (!DecryptPage(outBuf.AsSpan(p * pageSize, pageSize), p + 1, baseKey))
            {
                CryptographicOperations.ZeroMemory(outBuf);
                return null;
            }
        }
        return outBuf;
    }

    /// <summary>
    /// Encrypt plaintext SQLite bytes with the base key, for round-trip tests only. Inverts <see cref="Decrypt"/>.
    /// </summary>
    public static byte[] Encrypt(ReadOnlySpan<byte> plaintext, byte[] baseKey, int pageSize)
    {
        var outBuf = plaintext.ToArray();
        var pages = plaintext.Length / pageSize;
        for (var p = 0; p < pages; p++)
            EncryptPage(outBuf.AsSpan(p * pageSize, pageSize), p + 1, baseKey);
        return outBuf;
    }
}
