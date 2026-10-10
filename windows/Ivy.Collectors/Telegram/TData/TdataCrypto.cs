using System.Security.Cryptography;

namespace Ivy.Collectors.Telegram.TData;

/// <summary>
/// The Telegram Desktop local-storage crypto primitives, ported faithfully from tdesktop
/// (<c>storage/details/storage_file_utilities.cpp</c>, <c>mtproto/mtproto_auth_key.cpp</c>). These are the
/// MTProto-1.0 ("oldmtp") SHA-1 key derivation, AES-256-IGE, the PBKDF2-SHA512 passcode key, and the
/// framed <c>EncryptedDescriptor</c> used by every local blob.
///
/// This is a security-sensitive port with no reference install available on this machine, so it is written
/// to be verified both ways: the test project's <see cref="TdataWriter"/> uses the SAME primitives, so the
/// reader is checked byte-for-byte against known inputs. The constants and byte layout follow tdesktop so a
/// real install has a chance of being read directly, but that MUST be confirmed on the PC (see README).
///
/// IMPORTANT: Everything here produces or consumes key material. No plaintext key byte produced by this
/// class is ever serialized to the upload queue or logged; callers hold keys in memory (or DPAPI) only.
/// </summary>
internal static class TdataCrypto
{
    public const int LocalKeySize = 256;          // MTP::AuthKey::Data size tdesktop uses for the local key
    public const int SaltSize = 32;               // LocalEncryptSaltSize
    public const int AuthKeySize = 256;           // one MTProto auth key
    public const int LocalEncryptIterCount = 100000;
    public const int LocalEncryptNoPwdIterCount = 1;

    /// <summary>
    /// <c>CreateLocalKey</c>: derive the 256-byte passcode key from the passcode and the stored salt.
    /// <c>hash = SHA512(salt ‖ passcode ‖ salt)</c>, then PBKDF2-HMAC-SHA512 over that hash with the salt,
    /// 1 iteration for an empty passcode and <see cref="LocalEncryptIterCount"/> otherwise.
    /// </summary>
    public static byte[] CreateLocalKey(ReadOnlySpan<byte> passcode, ReadOnlySpan<byte> salt)
    {
        Span<byte> hashInput = new byte[salt.Length * 2 + passcode.Length];
        salt.CopyTo(hashInput);
        passcode.CopyTo(hashInput[salt.Length..]);
        salt.CopyTo(hashInput[(salt.Length + passcode.Length)..]);
        var hash = SHA512.HashData(hashInput);
        var iterations = passcode.Length == 0 ? LocalEncryptNoPwdIterCount : LocalEncryptIterCount;
        try
        {
            return Rfc2898DeriveBytes.Pbkdf2(hash, salt.ToArray(), iterations, HashAlgorithmName.SHA512, LocalKeySize);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(hash);
            CryptographicOperations.ZeroMemory(hashInput);
        }
    }

    /// <summary>
    /// <c>prepareAES_oldmtp(auth_key, msgKey, send=false)</c>: the MTProto-1.0 SHA-1 KDF. Local storage
    /// always uses <c>send = false</c> (x = 8). Returns a 32-byte AES key and a 32-byte IGE IV.
    /// </summary>
    public static (byte[] Key, byte[] Iv) PrepareAesOldMtp(ReadOnlySpan<byte> authKey, ReadOnlySpan<byte> msgKey)
    {
        const int x = 8; // send == false
        Span<byte> buf = stackalloc byte[16 + 32];

        msgKey[..16].CopyTo(buf);
        authKey.Slice(x, 32).CopyTo(buf[16..]);
        var a = SHA1.HashData(buf[..(16 + 32)].ToArray());

        Span<byte> buf2 = stackalloc byte[16 + 16 + 16];
        authKey.Slice(x + 32, 16).CopyTo(buf2);
        msgKey[..16].CopyTo(buf2[16..]);
        authKey.Slice(x + 48, 16).CopyTo(buf2[32..]);
        var b = SHA1.HashData(buf2.ToArray());

        Span<byte> buf3 = stackalloc byte[32 + 16];
        authKey.Slice(x + 64, 32).CopyTo(buf3);
        msgKey[..16].CopyTo(buf3[32..]);
        var c = SHA1.HashData(buf3.ToArray());

        Span<byte> buf4 = stackalloc byte[16 + 32];
        msgKey[..16].CopyTo(buf4);
        authKey.Slice(x + 96, 32).CopyTo(buf4[16..]);
        var d = SHA1.HashData(buf4.ToArray());

        var key = new byte[32];
        a.AsSpan(0, 8).CopyTo(key.AsSpan(0));
        b.AsSpan(8, 12).CopyTo(key.AsSpan(8));
        c.AsSpan(4, 12).CopyTo(key.AsSpan(20));

        var iv = new byte[32];
        a.AsSpan(8, 12).CopyTo(iv.AsSpan(0));
        b.AsSpan(0, 8).CopyTo(iv.AsSpan(12));
        c.AsSpan(16, 4).CopyTo(iv.AsSpan(20));
        d.AsSpan(0, 8).CopyTo(iv.AsSpan(24));

        return (key, iv);
    }

    /// <summary>AES-256-IGE encrypt. <paramref name="iv"/> is 32 bytes (two blocks). Length must be a multiple of 16.</summary>
    public static byte[] AesIgeEncrypt(ReadOnlySpan<byte> data, ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv)
    {
        if (data.Length % 16 != 0) throw new ArgumentException("IGE data length must be a multiple of 16", nameof(data));
        using var aes = Aes.Create();
        aes.Key = key.ToArray();

        var @out = new byte[data.Length];
        var prevC = iv[..16].ToArray();
        var prevP = iv.Slice(16, 16).ToArray();
        var xor = new byte[16];
        for (var i = 0; i < data.Length; i += 16)
        {
            var p = data.Slice(i, 16);
            for (var j = 0; j < 16; j++) xor[j] = (byte)(p[j] ^ prevC[j]);
            var block = aes.EncryptEcb(xor, PaddingMode.None);
            for (var j = 0; j < 16; j++) block[j] ^= prevP[j];
            block.CopyTo(@out.AsSpan(i));
            prevC = block;
            prevP = p.ToArray();
        }
        return @out;
    }

    /// <summary>AES-256-IGE decrypt. <paramref name="iv"/> is 32 bytes. Length must be a multiple of 16.</summary>
    public static byte[] AesIgeDecrypt(ReadOnlySpan<byte> data, ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv)
    {
        if (data.Length % 16 != 0) throw new ArgumentException("IGE data length must be a multiple of 16", nameof(data));
        using var aes = Aes.Create();
        aes.Key = key.ToArray();

        var @out = new byte[data.Length];
        var prevC = iv[..16].ToArray();
        var prevP = iv.Slice(16, 16).ToArray();
        var xor = new byte[16];
        for (var i = 0; i < data.Length; i += 16)
        {
            var c = data.Slice(i, 16).ToArray();
            for (var j = 0; j < 16; j++) xor[j] = (byte)(c[j] ^ prevP[j]);
            var block = aes.DecryptEcb(xor, PaddingMode.None);
            for (var j = 0; j < 16; j++) block[j] ^= prevC[j];
            block.CopyTo(@out.AsSpan(i));
            prevC = c;
            prevP = block;
        }
        return @out;
    }

    /// <summary>
    /// <c>DecryptLocal</c>: the stored blob is <c>msgKey(16) ‖ ciphertext</c>. Derive the AES key/IV from the
    /// local key and msgKey, IGE-decrypt, verify the msgKey against SHA-1 of the plaintext, then read the
    /// leading <c>qint32</c> full length. Returns the descriptor body (the bytes after that length prefix).
    /// </summary>
    public static byte[] DecryptLocal(ReadOnlySpan<byte> encrypted, ReadOnlySpan<byte> localKey)
    {
        if (encrypted.Length < 16 || (encrypted.Length - 16) % 16 != 0)
            throw new TdataFormatException("encrypted block is malformed (bad length)");
        var msgKey = encrypted[..16];
        var (key, iv) = PrepareAesOldMtp(localKey, msgKey);
        byte[] decrypted;
        try { decrypted = AesIgeDecrypt(encrypted[16..], key, iv); }
        finally { CryptographicOperations.ZeroMemory(key); CryptographicOperations.ZeroMemory(iv); }

        // msgKey = SHA1(plaintext)[0..16]; a mismatch means the wrong key (wrong/absent passcode).
        var check = SHA1.HashData(decrypted).AsSpan(0, 16);
        if (!check.SequenceEqual(msgKey))
        {
            CryptographicOperations.ZeroMemory(decrypted);
            throw new TdataBadKeyException("message key mismatch (wrong passcode or corrupt data)");
        }

        // The leading full-length prefix is a raw native (little-endian) uint32 in Telegram Desktop
        // (a pointer read in storage/details/storage_file_utilities.cpp), unlike the big-endian Qt
        // stream used for the body that follows it. See docs/internals/telegram-collector.md.
        var full = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(decrypted.AsSpan(0, 4));
        if (full < 4 || full > decrypted.Length)
        {
            CryptographicOperations.ZeroMemory(decrypted);
            throw new TdataFormatException($"bad descriptor length {full}");
        }
        var body = decrypted.AsSpan(4, (int)full - 4).ToArray();
        CryptographicOperations.ZeroMemory(decrypted);
        return body;
    }

    /// <summary>
    /// <c>EncryptLocal</c> (test/writer side): frame <paramref name="body"/> as a descriptor (leading full
    /// length, random padding to a 16-byte boundary), then IGE-encrypt and prepend the msgKey.
    /// </summary>
    public static byte[] EncryptLocal(ReadOnlySpan<byte> body, ReadOnlySpan<byte> localKey, Func<int, byte[]>? randomPad = null)
    {
        var full = 4 + body.Length;
        var padded = (full + 15) & ~15;
        var plain = new byte[padded];
        // Little-endian length prefix, matching the native read in DecryptLocal.
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(plain.AsSpan(0, 4), (uint)full);
        body.CopyTo(plain.AsSpan(4));
        if (padded > full)
        {
            var pad = randomPad?.Invoke(padded - full) ?? RandomNumberGenerator.GetBytes(padded - full);
            pad.CopyTo(plain.AsSpan(full));
        }
        var msgKey = SHA1.HashData(plain).AsSpan(0, 16).ToArray();
        var (key, iv) = PrepareAesOldMtp(localKey, msgKey);
        byte[] cipher;
        try { cipher = AesIgeEncrypt(plain, key, iv); }
        finally { CryptographicOperations.ZeroMemory(key); CryptographicOperations.ZeroMemory(iv); CryptographicOperations.ZeroMemory(plain); }
        var @out = new byte[16 + cipher.Length];
        msgKey.CopyTo(@out.AsSpan(0));
        cipher.CopyTo(@out.AsSpan(16));
        return @out;
    }
}

/// <summary>Thrown when a local blob cannot be decrypted with the supplied key (wrong or missing passcode).</summary>
public sealed class TdataBadKeyException : Exception
{
    public TdataBadKeyException(string message) : base(message) { }
}
