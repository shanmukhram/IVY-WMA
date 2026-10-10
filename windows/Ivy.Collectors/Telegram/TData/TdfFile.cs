using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Ivy.Collectors.Telegram.TData;

/// <summary>
/// The Telegram Desktop <c>TDF$</c> file container (<c>FileReadDescriptor</c>/<c>FileWriteDescriptor</c> in
/// <c>storage/details/storage_file_utilities.cpp</c>): a 4-byte magic <c>TDF$</c>, a little-endian
/// <c>qint32</c> version, the payload bytes, and a trailing 16-byte MD5 computed over
/// <c>payload ‖ payloadLen(LE i32) ‖ version(LE i32) ‖ magic</c>. The payload is then parsed as a
/// big-endian Qt data stream (see <see cref="TdeReader"/>).
/// </summary>
internal static class TdfFile
{
    private static readonly byte[] Magic = "TDF$"u8.ToArray();

    public sealed record Parsed(int Version, byte[] Payload);

    public static Parsed Read(byte[] file)
    {
        if (file.Length < 4 + 4 + 16) throw new TdataFormatException("TDF file too short");
        if (!file.AsSpan(0, 4).SequenceEqual(Magic)) throw new TdataFormatException("bad TDF magic");
        var version = BinaryPrimitives.ReadInt32LittleEndian(file.AsSpan(4, 4));
        var rest = file.AsSpan(8);
        var payloadLen = rest.Length - 16;
        if (payloadLen < 0) throw new TdataFormatException("TDF file missing signature");
        var payload = rest[..payloadLen].ToArray();
        var signature = rest.Slice(payloadLen, 16);
        var expected = Md5(payload, version);
        if (!signature.SequenceEqual(expected)) throw new TdataFormatException("TDF md5 signature mismatch (corrupt file)");
        return new Parsed(version, payload);
    }

    public static byte[] Write(int version, ReadOnlySpan<byte> payload)
    {
        var ms = new MemoryStream();
        ms.Write(Magic);
        Span<byte> v = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(v, version);
        ms.Write(v);
        ms.Write(payload);
        ms.Write(Md5(payload, version));
        return ms.ToArray();
    }

    private static byte[] Md5(ReadOnlySpan<byte> payload, int version)
    {
        using var md5 = MD5.Create();
        md5.TransformBlock(payload.ToArray(), 0, payload.Length, null, 0);
        Span<byte> sizeLe = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(sizeLe, payload.Length);
        md5.TransformBlock(sizeLe.ToArray(), 0, 4, null, 0);
        Span<byte> verLe = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(verLe, version);
        md5.TransformBlock(verLe.ToArray(), 0, 4, null, 0);
        md5.TransformFinalBlock(Magic, 0, Magic.Length);
        return md5.Hash!;
    }
}
