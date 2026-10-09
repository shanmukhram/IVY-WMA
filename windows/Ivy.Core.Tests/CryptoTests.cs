using Ivy.Core.Protocol;

namespace Ivy.Core.Tests;

public class EnvelopeTests
{
    private static readonly (byte[] Sk, byte[] Pk) Mac = X25519.GenerateKeyPair();
    private const string Key = "up/file/06CWGB60000000000000000004";
    private static readonly byte[] Plain = Bytes.Utf8.GetBytes("hello vault — ünïcode ✓");

    [Fact]
    public void Round_trip()
    {
        var env = Envelope.Encrypt(Mac.Pk, Kind.FileMeta, Key, Plain);
        Assert.Equal(Envelope.SizeFor(Plain.Length), env.Length);
        Assert.Equal(Kind.FileMeta, Envelope.PeekKind(env));
        var d = Envelope.Decrypt(Mac.Sk, Key, env, Kind.FileMeta);
        Assert.Equal(Plain, d.Plaintext);
    }

    [Fact]
    public void Empty_plaintext_round_trips_at_minimum_length()
    {
        var env = Envelope.Encrypt(Mac.Pk, Kind.UsageEvent, Key, ReadOnlySpan<byte>.Empty);
        Assert.Equal(Envelope.MinLength, env.Length);
        Assert.Empty(Envelope.Decrypt(Mac.Sk, Key, env).Plaintext);
    }

    [Fact]
    public void Fresh_randomness_per_object()
    {
        var a = Envelope.Encrypt(Mac.Pk, Kind.FileMeta, Key, Plain);
        var b = Envelope.Encrypt(Mac.Pk, Kind.FileMeta, Key, Plain);
        Assert.NotEqual(Bytes.ToHex(a.AsSpan(8, 32)), Bytes.ToHex(b.AsSpan(8, 32)));
        Assert.NotEqual(Bytes.ToHex(a), Bytes.ToHex(b));
    }

    public static IEnumerable<object[]> TamperOffsets()
    {
        // magic, version, mode, kind, reserved, epk, wrap nonce, wrapped cek, body nonce, body, tag
        foreach (var o in new[] { 0, 4, 5, 6, 7, 8, 39, 40, 51, 52, 99, 100, 111, 112, -1 }) yield return new object[] { o };
    }

    [Theory]
    [MemberData(nameof(TamperOffsets))]
    public void Any_flipped_byte_fails(int offset)
    {
        var env = Envelope.Encrypt(Mac.Pk, Kind.FileMeta, Key, Plain);
        var i = offset < 0 ? env.Length + offset : offset;
        env[i] ^= 0x01;
        Assert.ThrowsAny<IvyCryptoException>(() => Envelope.Decrypt(Mac.Sk, Key, env));
    }

    [Fact]
    public void Wrong_recipient_fails()
    {
        var env = Envelope.Encrypt(Mac.Pk, Kind.FileMeta, Key, Plain);
        var other = X25519.GenerateKeyPair();
        Assert.Throws<IvyCryptoException>(() => Envelope.Decrypt(other.SecretKey, Key, env));
    }

    [Fact]
    public void Relocated_object_key_fails()
    {
        var env = Envelope.Encrypt(Mac.Pk, Kind.FileMeta, Key, Plain);
        Assert.Throws<IvyCryptoException>(() => Envelope.Decrypt(Mac.Sk, "up/file/06CWGB60000000000000000008", env));
    }

    [Fact]
    public void Relabelled_kind_fails_and_expected_kind_is_enforced()
    {
        var env = Envelope.Encrypt(Mac.Pk, Kind.FileMeta, Key, Plain);
        Assert.Throws<IvyCryptoException>(() => Envelope.Decrypt(Mac.Sk, Key, env, Kind.Screenshot));
        env[6] = Kind.Screenshot.Id();
        Assert.Throws<IvyCryptoException>(() => Envelope.Decrypt(Mac.Sk, Key, env));
    }

    [Fact]
    public void Truncated_or_extended_fails()
    {
        var env = Envelope.Encrypt(Mac.Pk, Kind.FileMeta, Key, Plain);
        Assert.Throws<IvyCryptoException>(() => Envelope.Decrypt(Mac.Sk, Key, env.AsSpan(0, env.Length - 1)));
        Assert.Throws<IvyCryptoException>(() => Envelope.Decrypt(Mac.Sk, Key, env.AsSpan(0, 127)));
        Assert.Throws<IvyCryptoException>(() => Envelope.Decrypt(Mac.Sk, Key, Bytes.Concat(env, new byte[] { 0 })));
    }

    [Fact]
    public void Chunk_part_is_not_a_single_shot_envelope()
    {
        var r = Chunked.Encrypt(Mac.Pk, Oids.New(), new byte[16], PayloadKinds.Screenshot, new byte[300], 256);
        Assert.Throws<IvyCryptoException>(() => Envelope.Decrypt(Mac.Sk, r.Parts[0].ObjectKey, r.Parts[0].Bytes));
    }
}

public class ChunkedTests
{
    private static readonly (byte[] Sk, byte[] Pk) Mac = X25519.GenerateKeyPair();

    private static (ChunkedResult R, byte[] Plain) Make(int size = 1000, int chunk = 256)
    {
        var plain = new byte[size];
        Random.Shared.NextBytes(plain);
        var oid = Oids.New();
        return (Chunked.Encrypt(Mac.Pk, oid, Oids.ToBytes(oid), PayloadKinds.Screenshot, plain, chunk), plain);
    }

    private static Dictionary<int, byte[]> Parts(ChunkedResult r) => r.Parts.ToDictionary(p => p.Index, p => (byte[])p.Bytes.Clone());

    [Theory]
    [InlineData(0, 256)]
    [InlineData(1, 256)]
    [InlineData(256, 256)]
    [InlineData(257, 256)]
    [InlineData(1000, 256)]
    [InlineData(4096, 1000)]
    public void Round_trip(int size, int chunk)
    {
        var (r, plain) = Make(size, chunk);
        Assert.Equal(Math.Max(1, (size + chunk - 1) / chunk), r.Manifest.TotalChunks);
        Assert.All(r.Parts, p => Assert.Equal(32 + Math.Min(chunk, Math.Max(0, size - p.Index * chunk)) + 16, p.Bytes.Length));
        var d = Chunked.Decrypt(Mac.Sk, r.ManifestKey, r.ManifestEnvelope, Parts(r));
        Assert.Equal(plain, d.Plaintext);
        Assert.Null(d.Manifest.CommittedParts);
    }

    [Fact]
    public void Reordered_parts_fail()
    {
        var (r, _) = Make();
        var parts = Parts(r);
        (parts[0], parts[1]) = (parts[1], parts[0]);
        var e = Assert.Throws<IvyCryptoException>(() => Chunked.Decrypt(Mac.Sk, r.ManifestKey, r.ManifestEnvelope, parts));
        Assert.Contains("chunk 0", e.Message);
    }

    [Fact]
    public void Reorder_is_rejected_cryptographically_even_without_manifest_hashes()
    {
        var (r, _) = Make();
        var manifest = Chunked.OpenManifest(Mac.Sk, r.ManifestKey, r.ManifestEnvelope);
        // forge a manifest entry for position 0 that matches part 1's hash and length
        var p1 = r.Parts[1].Bytes;
        var forged = manifest with
        {
            Chunks = manifest.Chunks.Select((c, i) => i == 0 ? c with { CtLen = p1.Length, Sha256 = Bytes.ToHex(Bytes.Sha256(p1)) } : c).ToList(),
        };
        Assert.Throws<IvyCryptoException>(() => Chunked.OpenPart(forged, 0, p1)); // header index 1 != 0
        var relabelled = (byte[])p1.Clone();
        Bytes.U32Be(0).CopyTo(relabelled, 24); // rewrite header index -> AAD mismatch
        var forged2 = forged with
        {
            Chunks = forged.Chunks.Select((c, i) => i == 0 ? c with { Sha256 = Bytes.ToHex(Bytes.Sha256(relabelled)) } : c).ToList(),
        };
        Assert.Throws<IvyCryptoException>(() => Chunked.OpenPart(forged2, 0, relabelled));
    }

    [Fact]
    public void Missing_part_fails()
    {
        var (r, _) = Make();
        var parts = Parts(r);
        parts.Remove(parts.Keys.Max());
        Assert.Throws<IvyCryptoException>(() => Chunked.Decrypt(Mac.Sk, r.ManifestKey, r.ManifestEnvelope, parts));
    }

    [Fact]
    public void Truncated_part_fails()
    {
        var (r, _) = Make();
        var parts = Parts(r);
        parts[1] = parts[1][..^1];
        Assert.Throws<IvyCryptoException>(() => Chunked.Decrypt(Mac.Sk, r.ManifestKey, r.ManifestEnvelope, parts));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(8)]
    [InlineData(24)]
    [InlineData(28)]
    [InlineData(32)]
    [InlineData(-1)]
    public void Flipped_byte_fails(int offset)
    {
        var (r, _) = Make();
        var parts = Parts(r);
        var i = offset < 0 ? parts[2].Length + offset : offset;
        parts[2][i] ^= 0x80;
        Assert.Throws<IvyCryptoException>(() => Chunked.Decrypt(Mac.Sk, r.ManifestKey, r.ManifestEnvelope, parts));
    }

    [Fact]
    public void Part_from_another_object_fails()
    {
        var (a, _) = Make();
        var (b, _) = Make();
        var parts = Parts(a);
        parts[1] = b.Parts[1].Bytes;
        Assert.Throws<IvyCryptoException>(() => Chunked.Decrypt(Mac.Sk, a.ManifestKey, a.ManifestEnvelope, parts));
    }

    [Fact]
    public void Wrong_recipient_or_relocated_manifest_fails()
    {
        var (r, _) = Make();
        var other = X25519.GenerateKeyPair();
        Assert.Throws<IvyCryptoException>(() => Chunked.Decrypt(other.SecretKey, r.ManifestKey, r.ManifestEnvelope, Parts(r)));
        Assert.Throws<IvyCryptoException>(() => Chunked.Decrypt(Mac.Sk, ObjectKeys.BlobManifest(Oids.New()), r.ManifestEnvelope, Parts(r)));
    }

    [Fact]
    public void Encryptor_requires_exact_chunk_lengths_and_all_chunks()
    {
        using var enc = new ChunkedEncryptor(Mac.Pk, Oids.New(), new byte[16], PayloadKinds.FileOriginal, 600, 256);
        Assert.Equal(3, enc.TotalChunks);
        Assert.Equal(88, enc.ChunkLength(2));
        Assert.Throws<ArgumentException>(() => enc.EncryptChunk(0, new byte[100]));
        enc.EncryptChunk(0, new byte[256]);
        Assert.Throws<InvalidOperationException>(() => enc.Finish());
    }

    [Fact]
    public void Chunk_nonce_layout()
    {
        Assert.Equal("000000000000000000000000", Bytes.ToHex(ChunkedEncryptor.ChunkNonce(0)));
        Assert.Equal("000000000000000000000102", Bytes.ToHex(ChunkedEncryptor.ChunkNonce(258)));
    }
}
