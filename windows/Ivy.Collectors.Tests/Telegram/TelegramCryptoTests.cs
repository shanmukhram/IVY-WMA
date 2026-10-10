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
