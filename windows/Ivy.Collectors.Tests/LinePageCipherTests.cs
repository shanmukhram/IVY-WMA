using System.Buffers.Binary;
using System.Security.Cryptography;
using Ivy.Collectors.Line;
using Xunit;

namespace Ivy.Collectors.Tests;

public class LinePageCipherTests
{
    // A buffer that passes the SQLite header checks LinePageCipher validates: magic at 0, page size at 16.
    private static byte[] MakePlaintext(int pageSize, int pages)
    {
        var buf = new byte[pageSize * pages];
        RandomNumberGenerator.Fill(buf);
        LinePageCipher.SqliteHeader.CopyTo(buf.AsSpan(0));
        BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(16, 2), (ushort)(pageSize == 65536 ? 1 : pageSize));
        return buf;
    }

    // Mirrors LinePageCipher's IV-at-page-end layout, so the test encrypts exactly what the cipher decrypts.
    private static byte[] Encrypt(byte[] plaintext, byte[] key, LineCipherConfig c)
    {
        var encRegion = c.PageSize - c.ReservedBytes;
        var pages = plaintext.Length / c.PageSize;
        var outBuf = (byte[])plaintext.Clone();
        using var aes = Aes.Create();
        aes.Key = key; aes.Mode = CipherMode.CBC; aes.Padding = PaddingMode.None;
        for (var p = 0; p < pages; p++)
        {
            var start = p * c.PageSize;
            var header = p == 0 ? c.Page1HeaderBytes : 0;
            var iv = RandomNumberGenerator.GetBytes(16);
            var region = plaintext.AsSpan(start + header, encRegion - header);
            var cipher = aes.EncryptCbc(region, iv, PaddingMode.None);
            cipher.CopyTo(outBuf.AsSpan(start + header));
            iv.CopyTo(outBuf.AsSpan(start + encRegion));
        }
        return outBuf;
    }

    // The reserved tail of each page holds the IV, not data; SQLite ignores it. Compare only the meaningful
    // (encrypted) region of each page.
    private static void AssertDataEqual(byte[] expected, byte[] actual, LineCipherConfig c)
    {
        Assert.Equal(expected.Length, actual.Length);
        var encRegion = c.PageSize - c.ReservedBytes;
        for (var start = 0; start < expected.Length; start += c.PageSize)
            Assert.True(expected.AsSpan(start, encRegion).SequenceEqual(actual.AsSpan(start, encRegion)),
                $"page at {start} differs in its data region");
    }

    [Theory]
    [InlineData(16, 4096, 1)]
    [InlineData(16, 4096, 5)]
    [InlineData(32, 4096, 3)]
    [InlineData(32, 1024, 4)]
    public void Round_trips_a_known_key_and_config(int keyBytes, int pageSize, int pages)
    {
        var config = new LineCipherConfig { KeyBytes = keyBytes, PageSize = pageSize, ReservedBytes = 16 };
        var key = RandomNumberGenerator.GetBytes(keyBytes);
        var plaintext = MakePlaintext(pageSize, pages);

        var encrypted = Encrypt(plaintext, key, config);
        Assert.False(LinePageCipher.LooksLikeSqlite(encrypted.AsSpan(0, pageSize))); // encrypted page 1 is not plain

        var decrypted = LinePageCipher.TryDecrypt(encrypted, key, config);
        Assert.NotNull(decrypted);
        AssertDataEqual(plaintext, decrypted!, config);
    }

    [Fact]
    public void A_wrong_key_yields_null_not_garbage()
    {
        var config = LineCipherConfig.Aes256IvTail();
        var key = RandomNumberGenerator.GetBytes(32);
        var encrypted = Encrypt(MakePlaintext(4096, 3), key, config);

        var wrong = RandomNumberGenerator.GetBytes(32);
        Assert.Null(LinePageCipher.TryDecrypt(encrypted, wrong, config));
    }

    [Fact]
    public void A_wrong_page_size_yields_null()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var encrypted = Encrypt(MakePlaintext(4096, 2), key, LineCipherConfig.Aes256IvTail(4096));
        Assert.Null(LinePageCipher.TryDecrypt(encrypted, key, LineCipherConfig.Aes256IvTail(1024)));
    }

    [Fact]
    public void Page1_header_bytes_are_preserved_in_the_clear()
    {
        var config = new LineCipherConfig { KeyBytes = 32, PageSize = 4096, ReservedBytes = 16, Page1HeaderBytes = 16 };
        var key = RandomNumberGenerator.GetBytes(32);
        var plaintext = MakePlaintext(4096, 2);
        var encrypted = Encrypt(plaintext, key, config);

        // With a 16-byte clear header, the SQLite magic is visible in the encrypted file's page 1.
        Assert.True(LinePageCipher.LooksLikeSqlite(encrypted.AsSpan(0, 4096)));
        AssertDataEqual(plaintext, LinePageCipher.TryDecrypt(encrypted, key, config)!, config);
    }
}
