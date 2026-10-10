using System.Security.Cryptography;
using Ivy.Collectors.Telegram.TData;

namespace Ivy.Collectors.Tests.Telegram;

/// <summary>
/// The tdata crypto primitives, exercised with the test <see cref="TdataWriter"/>'s inverse operations so the
/// reader path is checked byte-for-byte (WT1/WX2): AES-256-IGE, the local-blob framing, and the PBKDF2 key.
/// </summary>
public class TelegramCryptoTests
{
    [Fact]
    public void Aes_ige_round_trips_a_multiblock_buffer()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var iv = RandomNumberGenerator.GetBytes(32);
        var plain = RandomNumberGenerator.GetBytes(16 * 7);

        var cipher = TdataCrypto.AesIgeEncrypt(plain, key, iv);
        Assert.NotEqual(plain, cipher);
        var back = TdataCrypto.AesIgeDecrypt(cipher, key, iv);
        Assert.Equal(plain, back);
    }

    [Fact]
    public void Aes_ige_rejects_non_block_lengths()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var iv = RandomNumberGenerator.GetBytes(32);
        Assert.Throws<ArgumentException>(() => TdataCrypto.AesIgeEncrypt(new byte[17], key, iv));
    }

    [Fact]
    public void Encrypt_local_round_trips_through_decrypt_local()
    {
        var localKey = RandomNumberGenerator.GetBytes(TdataCrypto.LocalKeySize);
        var body = RandomNumberGenerator.GetBytes(123); // deliberately not block-aligned

        var blob = TdataCrypto.EncryptLocal(body, localKey);
        var back = TdataCrypto.DecryptLocal(blob, localKey);
        Assert.Equal(body, back);
    }

    // Builds a local blob with an explicitly chosen byte order for the leading length prefix, so the
    // test does not depend on EncryptLocal's own choice. The body after the prefix is irrelevant here.
    private static byte[] BuildLocalBlobWithPrefix(byte[] localKey, int bodyLen, bool littleEndianPrefix)
    {
        var full = 4 + bodyLen;
        var padded = (full + 15) & ~15;
        var plain = new byte[padded];
        if (littleEndianPrefix)
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(plain.AsSpan(0, 4), (uint)full);
        else
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(plain.AsSpan(0, 4), (uint)full);
        RandomNumberGenerator.Fill(plain.AsSpan(4, bodyLen));
        var msgKey = System.Security.Cryptography.SHA1.HashData(plain).AsSpan(0, 16).ToArray();
        var (key, iv) = TdataCrypto.PrepareAesOldMtp(localKey, msgKey);
        var cipher = TdataCrypto.AesIgeEncrypt(plain, key, iv);
        var blob = new byte[16 + cipher.Length];
        msgKey.CopyTo(blob.AsSpan(0));
        cipher.CopyTo(blob.AsSpan(16));
        return blob;
    }

    [Fact]
    public void Local_length_prefix_is_read_little_endian_like_telegram_desktop()
    {
        // Regression: Telegram Desktop stores the leading full-length as a native little-endian uint32,
        // not the big-endian Qt stream used for the body. A big-endian prefix of 260 (0x104) reads as
        // 0x04010000 = 67174400 and must be rejected; the little-endian form must decrypt.
        var localKey = RandomNumberGenerator.GetBytes(TdataCrypto.LocalKeySize);

        var good = BuildLocalBlobWithPrefix(localKey, bodyLen: 256, littleEndianPrefix: true);
        var body = TdataCrypto.DecryptLocal(good, localKey);
        Assert.Equal(256, body.Length);

        var wrong = BuildLocalBlobWithPrefix(localKey, bodyLen: 256, littleEndianPrefix: false);
        var ex = Assert.Throws<TdataFormatException>(() => TdataCrypto.DecryptLocal(wrong, localKey));
        Assert.Contains("67174400", ex.Message);
    }

    [Fact]
    public void Decrypt_local_with_the_wrong_key_is_a_bad_key_error()
    {
        var localKey = RandomNumberGenerator.GetBytes(TdataCrypto.LocalKeySize);
        var other = RandomNumberGenerator.GetBytes(TdataCrypto.LocalKeySize);
        var blob = TdataCrypto.EncryptLocal(RandomNumberGenerator.GetBytes(64), localKey);

        Assert.Throws<TdataBadKeyException>(() => TdataCrypto.DecryptLocal(blob, other));
    }

    [Fact]
    public void Create_local_key_is_deterministic_and_passcode_sensitive()
    {
        var salt = RandomNumberGenerator.GetBytes(TdataCrypto.SaltSize);
        var a1 = TdataCrypto.CreateLocalKey(System.Text.Encoding.UTF8.GetBytes("hunter2"), salt);
        var a2 = TdataCrypto.CreateLocalKey(System.Text.Encoding.UTF8.GetBytes("hunter2"), salt);
        var b = TdataCrypto.CreateLocalKey(System.Text.Encoding.UTF8.GetBytes("hunter3"), salt);
        var empty = TdataCrypto.CreateLocalKey(ReadOnlySpan<byte>.Empty, salt);

        Assert.Equal(TdataCrypto.LocalKeySize, a1.Length);
        Assert.Equal(a1, a2);          // deterministic
        Assert.NotEqual(a1, b);        // passcode changes the key
        Assert.NotEqual(a1, empty);    // empty passcode is a distinct key
    }

    [Fact]
    public void Tdf_container_round_trips_and_detects_corruption()
    {
        var payload = RandomNumberGenerator.GetBytes(200);
        var file = TdfFile.Write(1, payload);
        Assert.Equal(payload, TdfFile.Read(file).Payload);

        file[^1] ^= 0xFF; // flip a signature byte
        Assert.Throws<TdataFormatException>(() => TdfFile.Read(file));
    }
}
