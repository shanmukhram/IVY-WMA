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
    /// Decrypt a whole wxSQLite3 AES-128-CBC store with the base key from <see cref="DeriveKey"/>. Returns the
    /// plaintext SQLite bytes, or null if page 1 does not validate (wrong passphrase / not this scheme).
    /// </summary>
    public static byte[]? Decrypt(ReadOnlySpan<byte> file, byte[] baseKey)
    {
        if (file.Length < 24) return null;
        // Page size lives in plaintext bytes 16..17 of page 1 (wxaes128 keeps 16..23 in the clear).
        var pageSize = (file[16] << 8) | (file[17] << 16);
        if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) != 0) return null;
        if (file.Length % pageSize != 0) return null;

        var outBuf = file.ToArray();
        var pages = file.Length / pageSize;
        for (var p = 0; p < pages; p++)
        {
            var page = p + 1; // wxSQLite3 page numbers are 1-based
            var span = outBuf.AsSpan(p * pageSize, pageSize);
            if (page == 1)
            {
                var dbHeader = new byte[8];
                span.Slice(16, 8).CopyTo(dbHeader);      // plaintext header backup
                span.Slice(8, 8).CopyTo(span.Slice(16, 8)); // restore the encrypted bytes 16..23
                AesCbc(baseKey, page, false, span.Slice(16, pageSize - 16));
                if (!span.Slice(16, 8).SequenceEqual(dbHeader)) return null; // wrong key
                SqliteMagic.CopyTo(span.Slice(0, 16));
            }
            else
            {
                AesCbc(baseKey, page, false, span);
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
        {
            var page = p + 1;
            var span = outBuf.AsSpan(p * pageSize, pageSize);
            if (page == 1)
            {
                var dbHeader = new byte[8];
                span.Slice(16, 8).CopyTo(dbHeader);                 // save plaintext header
                AesCbc(baseKey, page, true, span.Slice(0, 16));     // encrypt the magic block (discarded on read)
                AesCbc(baseKey, page, true, span.Slice(16, pageSize - 16));
                span.Slice(16, 8).CopyTo(span.Slice(8, 8));         // move encrypted 16..23 to 8..15
                dbHeader.CopyTo(span.Slice(16, 8));                 // restore plaintext 16..23
            }
            else
            {
                AesCbc(baseKey, page, true, span);
            }
        }
        return outBuf;
    }
}
