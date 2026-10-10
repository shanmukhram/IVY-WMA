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
    public void A_32_hex_run_that_is_really_the_key_round_trips_into_the_decryptor()
    {
        // The extracted ASCII key is exactly what DeriveKey expects, so detection and decryption agree.
        var region = Encoding.ASCII.GetBytes($"encryption_key={Key}mse");
        var found = LineKeyFinder.Extract(region)!;
        Assert.Equal(LineWxCipher.DeriveKey(Encoding.ASCII.GetBytes(Key)), LineWxCipher.DeriveKey(found));
    }
}
