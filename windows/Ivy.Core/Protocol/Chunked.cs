using System.Security.Cryptography;
using System.Text.Json;
using Ivy.Core.Records;

namespace Ivy.Core.Protocol;

/// <summary>TEST-ONLY injection points for chunked encryption (vectors).</summary>
internal sealed record ChunkedTestInputs(
    byte[]? ContentKey = null,
    byte[]? ManifestEphemeralSecretKey = null,
    byte[]? ManifestContentKey = null,
    byte[]? ManifestWrapNonce = null,
    byte[]? ManifestBodyNonce = null);

public sealed record ChunkPart(int Index, string ObjectKey, byte[] Bytes);

public sealed record ChunkedResult(ManifestRecord Manifest, string ManifestKey, byte[] ManifestEnvelope, IReadOnlyList<ChunkPart> Parts);

/// <summary>
/// Incremental chunked-object encryptor (PROTOCOL.md §2.2). One CEK per object; chunk <c>i</c> is
/// encrypted under the derived nonce <c>0^4 || u64be(i)</c> with AAD binding object id, index, total
/// and the blob_chunk kind id. Chunks may be produced one at a time so a multi-GB original is never
/// held in memory; <see cref="Finish"/> then yields the manifest envelope.
/// </summary>
public sealed class ChunkedEncryptor : IDisposable
{
    public const int ChunkHeaderLen = 32;
    private static readonly byte[] AadChunkLabel = "ivy/v1/chunk"u8.ToArray();

    private readonly byte[] _recipientPublicKey;
    private readonly byte[] _cek;
    private readonly ManifestChunk?[] _chunks;
    private readonly ChunkedTestInputs? _inputs;
    private readonly IRandomSource _random;
    private bool _finished;

    public string Oid { get; }
    public byte[] ObjectId { get; }
    public Kind PayloadKind { get; }
    public long TotalSize { get; }
    public int ChunkSize { get; }
    public int TotalChunks { get; }

    public ChunkedEncryptor(byte[] recipientPublicKey, string oid, byte[] objectId, Kind payloadKind, long totalSize, int chunkSize, IRandomSource? random = null)
        : this(recipientPublicKey, oid, objectId, payloadKind, totalSize, chunkSize, null, random) { }

    internal ChunkedEncryptor(byte[] recipientPublicKey, string oid, byte[] objectId, Kind payloadKind, long totalSize, int chunkSize,
        ChunkedTestInputs? inputs, IRandomSource? random = null)
    {
        if (recipientPublicKey.Length != X25519.KeyLen) throw new ArgumentException("recipient public key must be 32 bytes", nameof(recipientPublicKey));
        if (objectId.Length != 16) throw new ArgumentException("objectId must be 16 bytes", nameof(objectId));
        if (chunkSize <= 0) throw new ArgumentOutOfRangeException(nameof(chunkSize), "chunkSize must be positive");
        if (totalSize < 0) throw new ArgumentOutOfRangeException(nameof(totalSize));
        _recipientPublicKey = recipientPublicKey;
        _inputs = inputs;
        _random = random ?? SystemRandomSource.Instance;
        _cek = inputs?.ContentKey is { } fixedCek ? (byte[])fixedCek.Clone() : _random.Bytes(AesGcm256.KeyLen);
        Oid = oid;
        ObjectId = (byte[])objectId.Clone();
        PayloadKind = payloadKind;
        TotalSize = totalSize;
        ChunkSize = chunkSize;
        var total = Math.Max(1L, (totalSize + chunkSize - 1) / chunkSize);
        if (total > uint.MaxValue || total > int.MaxValue) throw new ArgumentOutOfRangeException(nameof(totalSize), "too many chunks");
        TotalChunks = (int)total;
        _chunks = new ManifestChunk?[TotalChunks];
    }

    /// <summary>Expected plaintext length of chunk <paramref name="index"/>.</summary>
    public int ChunkLength(int index)
    {
        if (index < 0 || index >= TotalChunks) throw new ArgumentOutOfRangeException(nameof(index));
        var start = (long)index * ChunkSize;
        return (int)Math.Min(ChunkSize, TotalSize - start);
    }

    public static byte[] ChunkNonce(int index) => Bytes.Concat(new byte[4], Bytes.U64Be((ulong)index));

    internal static byte[] ChunkAad(ReadOnlySpan<byte> objectId, int index, int totalChunks) =>
        Bytes.Concat(AadChunkLabel, new byte[] { 0x00 }, objectId.ToArray(), Bytes.U32Be((uint)index), Bytes.U32Be((uint)totalChunks),
            new[] { Kind.BlobChunk.Id() });

    /// <summary>Encrypt chunk <paramref name="index"/> and return the full part bytes (header + ciphertext + tag).</summary>
    public byte[] EncryptChunk(int index, ReadOnlySpan<byte> plaintext)
    {
        if (_finished) throw new InvalidOperationException("encryptor already finished");
        if (plaintext.Length != ChunkLength(index)) throw new ArgumentException($"chunk {index} must be {ChunkLength(index)} bytes", nameof(plaintext));
        var ct = AesGcm256.Encrypt(_cek, ChunkNonce(index), plaintext, ChunkAad(ObjectId, index, TotalChunks));
        var part = new byte[ChunkHeaderLen + ct.Length];
        Envelope.Magic.CopyTo(part, 0);
        part[4] = Envelope.Version;
        part[5] = Envelope.ModeChunk;
        part[6] = Kind.BlobChunk.Id();
        part[7] = 0x00;
        ObjectId.CopyTo(part, 8);
        Bytes.U32Be((uint)index).CopyTo(part, 24);
        Bytes.U32Be((uint)TotalChunks).CopyTo(part, 28);
        ct.CopyTo(part, ChunkHeaderLen);
        _chunks[index] = new ManifestChunk(index, part.Length, Bytes.ToHex(SHA256.HashData(part)));
        return part;
    }

    /// <summary>Build and encrypt the manifest. Every chunk must have been produced.</summary>
    public (ManifestRecord Manifest, string ManifestKey, byte[] ManifestEnvelope) Finish()
    {
        if (_finished) throw new InvalidOperationException("encryptor already finished");
        var chunks = new List<ManifestChunk>(TotalChunks);
        for (var i = 0; i < TotalChunks; i++)
            chunks.Add(_chunks[i] ?? throw new InvalidOperationException($"chunk {i} was not encrypted"));
        var manifest = new ManifestRecord
        {
            ObjectId = Bytes.ToHex(ObjectId),
            PayloadKind = PayloadKind.WireName(),
            TotalSize = TotalSize,
            ChunkSize = ChunkSize,
            TotalChunks = TotalChunks,
            Cek = Bytes.ToBase64(_cek),
            Chunks = chunks,
        };
        var key = ObjectKeys.BlobManifest(Oid);
        var json = IvyJson.SerializeToUtf8(manifest);
        try
        {
            var env = _inputs is null
                ? Envelope.Encrypt(_recipientPublicKey, Kind.Manifest, key, json, _random)
                : Envelope.Encrypt(_recipientPublicKey, Kind.Manifest, key, json, new EnvelopeTestInputs(
                    _inputs.ManifestEphemeralSecretKey, _inputs.ManifestContentKey, _inputs.ManifestWrapNonce, _inputs.ManifestBodyNonce));
            _finished = true;
            return (manifest, key, env);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(json);
        }
    }

    public void Dispose() => CryptographicOperations.ZeroMemory(_cek);
}

/// <summary>Whole-buffer helpers and receiver-side verification for chunked objects.</summary>
public static class Chunked
{
    public static ChunkedResult Encrypt(byte[] recipientPublicKey, string oid, byte[] objectId, Kind payloadKind, ReadOnlySpan<byte> plaintext, int chunkSize, IRandomSource? random = null) =>
        EncryptCore(new ChunkedEncryptor(recipientPublicKey, oid, objectId, payloadKind, plaintext.Length, chunkSize, random), plaintext);

    internal static ChunkedResult Encrypt(byte[] recipientPublicKey, string oid, byte[] objectId, Kind payloadKind, ReadOnlySpan<byte> plaintext, int chunkSize, ChunkedTestInputs inputs) =>
        EncryptCore(new ChunkedEncryptor(recipientPublicKey, oid, objectId, payloadKind, plaintext.Length, chunkSize, inputs), plaintext);

    private static ChunkedResult EncryptCore(ChunkedEncryptor enc, ReadOnlySpan<byte> plaintext)
    {
        using (enc)
        {
            var parts = new List<ChunkPart>(enc.TotalChunks);
            for (var i = 0; i < enc.TotalChunks; i++)
            {
                var start = (int)((long)i * enc.ChunkSize);
                parts.Add(new ChunkPart(i, ObjectKeys.BlobChunk(enc.Oid, i), enc.EncryptChunk(i, plaintext.Slice(start, enc.ChunkLength(i)))));
            }
            var (manifest, key, env) = enc.Finish();
            return new ChunkedResult(manifest, key, env, parts);
        }
    }

    public static (byte[] ObjectId, int Index, int TotalChunks) ParseChunkHeader(ReadOnlySpan<byte> part)
    {
        if (part.Length < ChunkedEncryptor.ChunkHeaderLen + AesGcm256.TagLen) throw new IvyCryptoException("chunk part too short");
        if (!Bytes.FixedTimeEquals(part[..4], Envelope.Magic)) throw new IvyCryptoException("bad magic");
        if (part[4] != Envelope.Version) throw new IvyCryptoException($"unsupported version {part[4]}");
        if (part[5] != Envelope.ModeChunk) throw new IvyCryptoException($"not a chunk part (mode {part[5]})");
        if (part[6] != Kind.BlobChunk.Id()) throw new IvyCryptoException("chunk part kind is not blob_chunk");
        if (part[7] != 0x00) throw new IvyCryptoException("reserved header byte must be 0x00");
        return (part.Slice(8, 16).ToArray(), (int)Bytes.ReadU32Be(part, 24), (int)Bytes.ReadU32Be(part, 28));
    }

    /// <summary>Decrypt and verify the manifest envelope.</summary>
    public static ManifestRecord OpenManifest(ReadOnlySpan<byte> recipientSecretKey, string manifestKey, ReadOnlySpan<byte> manifestEnvelope)
    {
        var dec = Envelope.Decrypt(recipientSecretKey, manifestKey, manifestEnvelope, Kind.Manifest);
        try
        {
            var m = JsonSerializer.Deserialize<ManifestRecord>(dec.Plaintext, IvyJson.Options)
                    ?? throw new IvyCryptoException("empty manifest");
            if (m.V != 1) throw new IvyCryptoException($"unsupported manifest version {m.V}");
            return m;
        }
        catch (JsonException e) { throw new IvyCryptoException("malformed manifest", e); }
        finally { CryptographicOperations.ZeroMemory(dec.Plaintext); }
    }

    /// <summary>Receiver verification of part <paramref name="index"/> (§2.2 steps 1–5). Returns the chunk plaintext.</summary>
    public static byte[] OpenPart(ManifestRecord manifest, int index, ReadOnlySpan<byte> part)
    {
        if (index < 0 || index >= manifest.TotalChunks || index >= manifest.Chunks.Count) throw new IvyCryptoException($"manifest chunk {index} missing");
        var entry = manifest.Chunks[index];
        if (entry.Index != index) throw new IvyCryptoException($"manifest chunk {index} misordered");
        if (part.Length != entry.CtLen) throw new IvyCryptoException($"chunk {index} length mismatch");
        var hash = Bytes.ToHex(SHA256.HashData(part));
        if (!Bytes.FixedTimeEquals(Bytes.Utf8.GetBytes(hash), Bytes.Utf8.GetBytes(entry.Sha256)))
            throw new IvyCryptoException($"chunk {index} hash mismatch (tampered or reordered)");
        var (objectId, hIndex, hTotal) = ParseChunkHeader(part);
        if (hIndex != index) throw new IvyCryptoException($"chunk {index} header index is {hIndex} (reordered)");
        if (hTotal != manifest.TotalChunks) throw new IvyCryptoException($"chunk {index} total mismatch");
        var cek = Bytes.FromBase64(manifest.Cek);
        try
        {
            if (cek.Length != AesGcm256.KeyLen) throw new IvyCryptoException("manifest cek must be 32 bytes");
            return AesGcm256.Decrypt(cek, ChunkedEncryptor.ChunkNonce(index), part[ChunkedEncryptor.ChunkHeaderLen..],
                ChunkedEncryptor.ChunkAad(objectId, index, manifest.TotalChunks));
        }
        finally { CryptographicOperations.ZeroMemory(cek); }
    }

    /// <summary>Verify and decrypt a whole chunked object (receiver side; used by tests and the Mac simulator).</summary>
    public static (ManifestRecord Manifest, byte[] Plaintext) Decrypt(ReadOnlySpan<byte> recipientSecretKey, string manifestKey,
        ReadOnlySpan<byte> manifestEnvelope, IReadOnlyDictionary<int, byte[]> parts)
    {
        var manifest = OpenManifest(recipientSecretKey, manifestKey, manifestEnvelope);
        if (manifest.Chunks.Count != manifest.TotalChunks) throw new IvyCryptoException("manifest chunk count mismatch");
        using var ms = new MemoryStream();
        for (var i = 0; i < manifest.TotalChunks; i++)
        {
            if (!parts.TryGetValue(i, out var part)) throw new IvyCryptoException($"chunk part {i} not supplied");
            ms.Write(OpenPart(manifest, i, part));
        }
        if (ms.Length != manifest.TotalSize) throw new IvyCryptoException("reassembled size mismatch");
        return (manifest, ms.ToArray());
    }
}
