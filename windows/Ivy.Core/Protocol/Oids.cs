namespace Ivy.Core.Protocol;

/// <summary>
/// Object id (§4.1): 48-bit big-endian millisecond timestamp followed by 80 random bits, encoded as
/// 26 Crockford base32 characters (reference bit order, see <see cref="Crockford"/>). String order
/// equals time order.
/// </summary>
public static class Oids
{
    public const int Length = 26;
    public const int ByteLength = 16;

    public static string Make(long timeMs, ReadOnlySpan<byte> random80)
    {
        if (random80.Length != 10) throw new ArgumentException("oid random part must be 10 bytes", nameof(random80));
        var bytes = new byte[16];
        Bytes.U48Be(timeMs).CopyTo(bytes, 0);
        random80.CopyTo(bytes.AsSpan(6));
        return Crockford.Encode(bytes);
    }

    public static string New(TimeProvider? time = null, IRandomSource? random = null)
    {
        var ms = (time ?? TimeProvider.System).GetUtcNow().ToUnixTimeMilliseconds();
        return Make(ms, (random ?? SystemRandomSource.Instance).Bytes(10));
    }

    /// <summary>The 16-byte binary form of an oid (used as the chunked object id).</summary>
    public static byte[] ToBytes(string oid)
    {
        if (oid.Length != Length) throw new FormatException("oid must be 26 characters");
        return Crockford.Decode(oid, ByteLength);
    }

    public static long TimestampMs(string oid)
    {
        var b = ToBytes(oid);
        long t = 0;
        for (var i = 0; i < 6; i++) t = (t << 8) | b[i];
        return t;
    }

    public static bool IsValid(string? oid)
    {
        if (oid is null || oid.Length != Length) return false;
        try { _ = ToBytes(oid); return true; }
        catch (FormatException) { return false; }
    }

    /// <summary>True if <paramref name="oid"/> sorts strictly after <paramref name="marker"/> (ordinal).</summary>
    public static bool After(string oid, string marker)
    {
        if (oid.Length != Length || marker.Length != Length) throw new ArgumentException("oids must be 26 chars");
        return string.CompareOrdinal(oid, marker) > 0;
    }
}
