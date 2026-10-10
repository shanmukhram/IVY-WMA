using System.Linq;
using System.Text;
using Ivy.Collectors.Line;
using Xunit;

namespace Ivy.Collectors.Tests;

public class LineKeyFinderTests
{
    private const string Key = "a1b2c3d4e5f607182930abcdef012345";

    [Fact]
    public void Extracts_a_key_framed_by_the_markers()
    {
        var region = Encoding.ASCII.GetBytes($"...junk...encryption_key={Key}mse...more junk...");
        Assert.Equal(Key, Encoding.ASCII.GetString(LineKeyFinder.Extract(region)!));
    }

    [Fact]
    public void Extracts_the_alternate_marker_spelling()
    {
        var region = Encoding.ASCII.GetBytes($"encryptionkey={Key}mse");
        Assert.Equal(Key, Encoding.ASCII.GetString(LineKeyFinder.Extract(region)!));
    }

    [Fact]
    public void Falls_back_to_a_lone_32_hex_run()
    {
        var region = Encoding.ASCII.GetBytes($"no markers here {Key} trailing");
        Assert.Equal(Key, Encoding.ASCII.GetString(LineKeyFinder.Extract(region)!));
    }

    [Fact]
    public void Returns_null_when_there_is_no_key()
    {
        Assert.Null(LineKeyFinder.Extract(Encoding.ASCII.GetBytes("nothing that looks like a 32 hex key, only short abc123")));
        Assert.Null(LineKeyFinder.Extract(new byte[] { 0, 1, 2, 3, 4, 5 }));
    }

    [Fact]
    public void Candidates_returns_every_distinct_hex_markers_first()
    {
        var a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        var region = Encoding.ASCII.GetBytes($"{a} junk encryption_key={b}mse {a}");
        var cands = LineKeyFinder.Candidates(region).Select(c => Encoding.ASCII.GetString(c)).ToList();
        Assert.Equal(b, cands[0]);            // marker-framed first
        Assert.Contains(a, cands);
        Assert.Equal(2, cands.Count);          // distinct
    }

    [Fact]
    public void Key_fits_validates_the_right_key_on_page_one_only()
    {
        // Build a tiny valid SQLite header page, encrypt it, and confirm KeyFits accepts the right key only.
        var page = new byte[4096];
        System.Security.Cryptography.RandomNumberGenerator.Fill(page);
        Encoding.ASCII.GetBytes("SQLite format 3\0").CopyTo(page, 0);
        page[16] = 0x10; page[17] = 0x00; // page size 4096
        var right = LineWxCipher.DeriveKey(Encoding.ASCII.GetBytes(Key));
        var enc = LineWxCipher.Encrypt(page, right, 4096);
        Assert.True(LineWxCipher.KeyFits(enc, right));
        Assert.False(LineWxCipher.KeyFits(enc, LineWxCipher.DeriveKey(Encoding.ASCII.GetBytes("ffffffffffffffffffffffffffffffff"))));
    }

    [Fact]
    public void A_32_hex_run_that_is_really_the_key_round_trips_into_the_decryptor()
    {
        // The extracted ASCII key is exactly what DeriveKey expects, so detection and decryption agree.
        var region = Encoding.ASCII.GetBytes($"encryption_key={Key}mse");
        var found = LineKeyFinder.Extract(region)!;
        Assert.Equal(LineWxCipher.DeriveKey(Encoding.ASCII.GetBytes(Key)), LineWxCipher.DeriveKey(found));
    }
}
