using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Ivy.Core.Protocol;

/// <summary>
/// Byte and encoding helpers (PROTOCOL.md §0). All multi-byte integers are big-endian,
/// strings are UTF-8 without BOM.
/// </summary>
public static class Bytes
{
    /// <summary>UTF-8 without BOM.</summary>
    public static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    public static byte[] Concat(params byte[][] parts)
    {
        var total = 0;
        foreach (var p in parts) total += p.Length;
        var output = new byte[total];
        var off = 0;
        foreach (var p in parts)
        {
            Buffer.BlockCopy(p, 0, output, off, p.Length);
            off += p.Length;
        }
        return output;
    }

    public static byte[] U32Be(uint n)
    {
        var b = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(b, n);
        return b;
    }

    public static uint ReadU32Be(ReadOnlySpan<byte> b, int offset) =>
        BinaryPrimitives.ReadUInt32BigEndian(b.Slice(offset, 4));

    public static byte[] U64Be(ulong n)
    {
        var b = new byte[8];
        BinaryPrimitives.WriteUInt64BigEndian(b, n);
        return b;
    }

    public static byte[] U48Be(long n)
    {
        if (n < 0 || n > 0xffff_ffff_ffffL) throw new ArgumentOutOfRangeException(nameof(n), "u48be out of range");
        var b = new byte[6];
        for (var i = 5; i >= 0; i--)
        {
            b[i] = (byte)(n & 0xff);
            n >>= 8;
        }
        return b;
    }

    /// <summary>Lowercase hex.</summary>
    public static string ToHex(ReadOnlySpan<byte> b) => Convert.ToHexString(b).ToLowerInvariant();

    public static byte[] FromHex(string hex)
    {
        if (hex.Length % 2 != 0) throw new FormatException("hex length must be even");
        return Convert.FromHexString(hex);
    }

    public static string ToBase64(ReadOnlySpan<byte> b) => Convert.ToBase64String(b);

    public static byte[] FromBase64(string s) => Convert.FromBase64String(s);

    /// <summary>RFC 4648 §5 base64url without padding (matches Node's "base64url").</summary>
    public static string ToBase64Url(ReadOnlySpan<byte> b) =>
        Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Decode base64url; padding is optional (Node accepts both).</summary>
    public static byte[] FromBase64Url(string s)
    {
        var t = s.Trim().TrimEnd('=').Replace('-', '+').Replace('_', '/');
        switch (t.Length % 4)
        {
            case 0: break;
            case 2: t += "=="; break;
            case 3: t += "="; break;
            default: throw new FormatException("invalid base64url length");
        }
        return Convert.FromBase64String(t);
    }

    public static bool FixedTimeEquals(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b) =>
        CryptographicOperations.FixedTimeEquals(a, b);

    public static byte[] Sha256(ReadOnlySpan<byte> data) => SHA256.HashData(data);
}

/// <summary>
/// Crockford base32 as used by the reference implementation (packages/protocol/src/bytes.ts):
/// big-endian bit order, 5-bit groups taken from the most significant end, and any trailing
/// partial group zero-padded on the RIGHT. Note that this differs from the canonical ULID text
/// encoding (which left-pads the first character); for 16 bytes it yields 26 characters whose
/// lexicographic order equals the byte order.
/// </summary>
public static class Crockford
{
    public const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    public static string Encode(ReadOnlySpan<byte> b)
    {
        var sb = new StringBuilder((b.Length * 8 + 4) / 5);
        var bits = 0;
        var value = 0;
        foreach (var x in b)
        {
            value = ((value << 8) | x) & 0xffff;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(Alphabet[(value >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(Alphabet[(value << (5 - bits)) & 31]);
        return sb.ToString();
    }

    /// <summary>Decode <paramref name="s"/> into exactly <paramref name="byteLength"/> bytes. Pad bits must be zero.</summary>
    public static byte[] Decode(string s, int byteLength)
    {
        if (s.Length != (byteLength * 8 + 4) / 5) throw new FormatException("crockford length mismatch");
        var output = new byte[byteLength];
        var bits = 0;
        var value = 0;
        var o = 0;
        foreach (var ch in s)
        {
            var d = Alphabet.IndexOf(char.ToUpperInvariant(ch));
            if (d < 0) throw new FormatException($"invalid crockford character '{ch}'");
            value = ((value << 5) | d) & 0xffff;
            bits += 5;
            if (bits >= 8)
            {
                output[o++] = (byte)((value >> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        if (o != byteLength) throw new FormatException("crockford decode length mismatch");
        if (bits > 0 && (value & ((1 << bits) - 1)) != 0) throw new FormatException("non-zero crockford pad bits");
        return output;
    }
}
