using System.Buffers;
using System.Buffers.Binary;
using System.Security.Cryptography;
using Ivy.Core.Protocol;

namespace Ivy.Collectors.Files;

/// <summary>
/// WC1 quick hash: SHA-256 over (first 64 KiB) ‖ (last 64 KiB) ‖ (size as 8-byte little-endian), truncated to
/// 16 bytes, lower-case hex (32 chars). Files of 128 KiB or less are hashed whole (head = entire file, no
/// tail) so no byte is counted twice. Change detection only; not a content identity.
/// </summary>
public static class QuickHash
{
    public const int SegmentSize = 64 * 1024;

    public static string Compute(Stream stream)
    {
        var size = stream.Length;
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buf = ArrayPool<byte>.Shared.Rent(SegmentSize);
        try
        {
            if (size <= 2L * SegmentSize)
            {
                stream.Position = 0;
                ReadInto(stream, sha, buf, size);
            }
            else
            {
                stream.Position = 0;
                ReadInto(stream, sha, buf, SegmentSize);
                stream.Position = size - SegmentSize;
                ReadInto(stream, sha, buf, SegmentSize);
            }
            Span<byte> len = stackalloc byte[8];
            BinaryPrimitives.WriteInt64LittleEndian(len, size);
            sha.AppendData(len);
            Span<byte> digest = stackalloc byte[32];
            sha.GetHashAndReset(digest);
            return Bytes.ToHex(digest[..16]);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buf);
            ArrayPool<byte>.Shared.Return(buf);
        }
    }

    public static string ComputeFile(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
        return Compute(fs);
    }

    private static void ReadInto(Stream s, IncrementalHash sha, byte[] buf, long count)
    {
        var remaining = count;
        while (remaining > 0)
        {
            var n = s.Read(buf, 0, (int)Math.Min(buf.Length, remaining));
            if (n == 0) throw new IOException("file shrank while hashing");
            sha.AppendData(buf, 0, n);
            remaining -= n;
        }
    }
}
