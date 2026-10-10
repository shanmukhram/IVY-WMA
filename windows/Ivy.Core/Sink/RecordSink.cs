using System.Buffers;
using System.Security.Cryptography;
using System.Text.Json;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Core.Sink;

public sealed record EnqueuedRecord(string Oid, string ObjectKey, long CiphertextSize);

/// <summary>Result of <see cref="IRecordSink.EnqueueBlob"/>: reference the blob from a record via <see cref="Oid"/>.</summary>
public sealed record EnqueuedBlob(string Oid, string ManifestKey, int TotalChunks, long TotalSize, string PlaintextSha256);

/// <summary>
/// What collectors call to emit captures. Every call serializes → encrypts to the Mac's public key →
/// writes ciphertext to the queue directory → enqueues → logs to <c>activity_log</c>. Plaintext is never
/// written to disk.
/// </summary>
public interface IRecordSink
{
    /// <summary>
    /// Enqueue one record. <paramref name="objectKeyPrefix"/> must be the kind's prefix
    /// (<c>up/&lt;prefix&gt;</c>, e.g. <c>up/file</c>); <paramref name="recordJson"/> must be a v1 JSON
    /// object whose <c>kind</c> equals <paramref name="kind"/>.
    /// </summary>
    EnqueuedRecord Enqueue(Kind kind, string objectKeyPrefix, string recordJson, string? collector = null);

    /// <summary>Serialize, validate and enqueue a typed record.</summary>
    EnqueuedRecord Enqueue<T>(T record, string? collector = null) where T : IvyRecord;

    /// <summary>
    /// Encrypt a stream as a chunked blob (manifest first, then parts, uploaded in that order).
    /// The stream must be seekable (or <paramref name="length"/> given) because every chunk's AAD binds
    /// the total chunk count. <paramref name="commandId"/> (an original uploaded for a <c>file_request</c>) is
    /// written into the manifest so the Mac can track the transfer before the status arrives (§2.2).
    /// <paramref name="oid"/> lets the caller pick the blob's oid ahead of time (a record that references the
    /// blob was already emitted); it must never have been enqueued before. <paramref name="bulk"/> puts the
    /// blob in the bulk lane of the upload queue, which drains after every normal item (records first).
    /// </summary>
    EnqueuedBlob EnqueueBlob(Stream stream, string payloadKind, string? collector = null, long? length = null, string? commandId = null,
        string? oid = null, bool bulk = false);
}

public sealed class RecordSinkOptions
{
    /// <summary>Plaintext bytes per chunk (one chunk is in memory at a time). Chunks above the uploader's
    /// multipart threshold are sent with resumable S3 multipart, so a 50 MB original is 2 chunk objects of
    /// 8 MiB-part multipart uploads.</summary>
    public int ChunkSize { get; init; } = 32 * 1024 * 1024;
}

public sealed class RecordSink : IRecordSink
{
    private readonly UploadQueue _queue;
    private readonly byte[] _macPublicKey;
    private readonly string _deviceId;
    private readonly ActivityLog? _activity;
    private readonly RecordSinkOptions _options;
    private readonly TimeProvider _time;
    private readonly IRandomSource _random;
    private readonly ILogger _logger;

    public RecordSink(UploadQueue queue, byte[] macPublicKey, string deviceId, ActivityLog? activity = null,
        RecordSinkOptions? options = null, TimeProvider? time = null, IRandomSource? random = null, ILogger<RecordSink>? logger = null)
    {
        if (macPublicKey.Length != X25519.KeyLen) throw new ArgumentException("mac public key must be 32 bytes", nameof(macPublicKey));
        _queue = queue;
        _macPublicKey = (byte[])macPublicKey.Clone();
        _deviceId = deviceId;
        _activity = activity;
        _options = options ?? new RecordSinkOptions();
        if (_options.ChunkSize <= 0) throw new ArgumentException("ChunkSize must be positive", nameof(options));
        _time = time ?? TimeProvider.System;
        _random = random ?? SystemRandomSource.Instance;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    public string DeviceId => _deviceId;
    public TimeProvider Time => _time;

    public EnqueuedRecord Enqueue(Kind kind, string objectKeyPrefix, string recordJson, string? collector = null)
    {
        var expectedPrefix = ObjectKeys.UpPrefix(kind);
        if (objectKeyPrefix.TrimEnd('/') != expectedPrefix)
            throw new ArgumentException($"object key prefix '{objectKeyPrefix}' does not match kind {kind.WireName()} (expected '{expectedPrefix}')", nameof(objectKeyPrefix));
        var plaintext = Bytes.Utf8.GetBytes(recordJson);
        try
        {
            CheckRecordJson(kind, plaintext);
            return EnqueuePlaintext(kind, plaintext, collector, groupKey: null);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    public EnqueuedRecord Enqueue<T>(T record, string? collector = null) where T : IvyRecord => EnqueueRecord(record, collector, null);

    /// <summary>Typed enqueue with an ordering group (e.g. a command status that must follow its blob).</summary>
    internal EnqueuedRecord EnqueueRecord<T>(T record, string? collector, string? groupKey) where T : IvyRecord
    {
        record.Validate();
        var plaintext = IvyJson.SerializeToUtf8(record);
        try { return EnqueuePlaintext(record.RecordKind, plaintext, collector, groupKey); }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
    }

    private static void CheckRecordJson(Kind kind, byte[] json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new ArgumentException("record JSON must be an object");
            if (!root.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || v.GetInt32() != 1)
                throw new ArgumentException("record JSON must have v == 1");
            if (!root.TryGetProperty("kind", out var k) || k.GetString() != kind.WireName())
                throw new ArgumentException($"record JSON kind must be '{kind.WireName()}'");
            foreach (var f in new[] { "deviceId", "eventTime", "captureTime" })
                if (!root.TryGetProperty(f, out var p) || p.ValueKind != JsonValueKind.String || p.GetString()!.Length == 0)
                    throw new ArgumentException($"record JSON requires non-empty '{f}'");
        }
        catch (JsonException e)
        {
            throw new ArgumentException("record JSON is not valid JSON", e);
        }
    }

    private EnqueuedRecord EnqueuePlaintext(Kind kind, byte[] plaintext, string? collector, string? groupKey)
    {
        var oid = Oids.New(_time, _random);
        var key = kind switch
        {
            Kind.CommandStatus => ObjectKeys.CommandStatus(oid),
            Kind.DeviceReport => ObjectKeys.DeviceReport(oid),
            _ => ObjectKeys.Up(kind, oid),
        };
        var envelope = Envelope.Encrypt(_macPublicKey, kind, key, plaintext, _random);
        _activity?.Append(collector, ActivityEvents.Encrypted, $"{kind.WireName()} {key} {envelope.Length} bytes");
        _queue.EnqueueCiphertext(key, kind, envelope, collector, groupKey);
        _activity?.Append(collector, ActivityEvents.Queued, $"{key}");
        return new EnqueuedRecord(oid, key, envelope.Length);
    }

    public EnqueuedBlob EnqueueBlob(Stream stream, string payloadKind, string? collector = null, long? length = null, string? commandId = null,
        string? oid = null, bool bulk = false)
    {
        var total = length ?? (stream.CanSeek ? stream.Length - stream.Position : throw new ArgumentException("stream must be seekable or length given", nameof(stream)));
        if (oid is not null && !Oids.IsValid(oid)) throw new ArgumentException("invalid blob oid", nameof(oid));
        oid ??= Oids.New(_time, _random);
        var objectId = Oids.ToBytes(oid);
        var written = new List<PartFile>();
        var buffer = ArrayPool<byte>.Shared.Rent(_options.ChunkSize);
        try
        {
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var enc = new ChunkedEncryptor(_macPublicKey, oid, objectId, payloadKind, total, _options.ChunkSize, _random) { CommandId = commandId };
            for (var i = 0; i < enc.TotalChunks; i++)
            {
                var want = enc.ChunkLength(i);
                var span = buffer.AsSpan(0, want);
                var got = 0;
                while (got < want)
                {
                    var n = stream.Read(span[got..]);
                    if (n == 0) throw new IOException($"stream ended early: expected {total} bytes");
                    got += n;
                }
                sha.AppendData(span);
                var part = enc.EncryptChunk(i, span);
                CryptographicOperations.ZeroMemory(span);
                written.Add(_queue.WritePartFile(ObjectKeys.BlobChunk(oid, i), Kind.BlobChunk, part));
            }
            if (stream.ReadByte() != -1) throw new IOException($"stream is longer than the declared {total} bytes");
            var (_, manifestKey, manifestEnvelope) = enc.Finish();
            var manifestFile = _queue.WritePartFile(manifestKey, Kind.Manifest, manifestEnvelope);
            var ordered = new List<PartFile>(written.Count + 1) { manifestFile };
            ordered.AddRange(written);
            _queue.Enqueue(ordered, groupKey: oid, collector, bulk ? UploadQueue.BulkLane : UploadQueue.NormalLane);
            var digest = Bytes.ToHex(sha.GetHashAndReset());
            _activity?.Append(collector, ActivityEvents.Encrypted, $"blob {oid} {payloadKind} {total} bytes in {enc.TotalChunks} chunks");
            _activity?.Append(collector, ActivityEvents.Queued, $"{manifestKey} + {enc.TotalChunks} parts");
            return new EnqueuedBlob(oid, manifestKey, enc.TotalChunks, total, digest);
        }
        catch
        {
            // Nothing was enqueued; remove ciphertext files so reconciliation has nothing half-done to find.
            foreach (var f in written)
            {
                try { File.Delete(f.FullPath); }
                catch (IOException e) { _logger.LogWarning(e, "could not delete {Path}", f.FullPath); }
            }
            try { File.Delete(Path.Combine(_queue.QueueDirectory, UploadQueue.FileNameFor(ObjectKeys.BlobManifest(oid)))); }
            catch (IOException) { }
            throw;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer.AsSpan(0, Math.Min(buffer.Length, _options.ChunkSize)));
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}
