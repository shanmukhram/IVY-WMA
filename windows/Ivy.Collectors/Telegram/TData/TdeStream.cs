using System.Buffers.Binary;

namespace Ivy.Collectors.Telegram.TData;

/// <summary>
/// A minimal, big-endian reader/writer matching Qt's <c>QDataStream</c> as Telegram Desktop uses it for
/// local storage (<c>storage/details/storage_file_utilities.cpp</c>). Only the primitives tdesktop writes
/// into the key and account files are implemented: <c>qint32</c>/<c>quint32</c>/<c>qint64</c>/<c>quint64</c>
/// (4/8 bytes, big-endian) and <c>QByteArray</c> (a <c>quint32</c> length — <c>0xFFFFFFFF</c> for a null
/// array — followed by the raw bytes).
/// </summary>
internal sealed class TdeReader
{
    private readonly byte[] _data;
    private int _pos;

    public TdeReader(byte[] data) => _data = data;

    public int Position => _pos;
    public int Remaining => _data.Length - _pos;
    public bool AtEnd => _pos >= _data.Length;

    private ReadOnlySpan<byte> Take(int n)
    {
        if (n < 0 || _pos + n > _data.Length) throw new TdataFormatException($"stream underrun: wanted {n} bytes at {_pos} of {_data.Length}");
        var span = _data.AsSpan(_pos, n);
        _pos += n;
        return span;
    }

    public int ReadInt32() => BinaryPrimitives.ReadInt32BigEndian(Take(4));
    public uint ReadUInt32() => BinaryPrimitives.ReadUInt32BigEndian(Take(4));
    public long ReadInt64() => BinaryPrimitives.ReadInt64BigEndian(Take(8));
    public ulong ReadUInt64() => BinaryPrimitives.ReadUInt64BigEndian(Take(8));

    public byte[] ReadRaw(int n) => Take(n).ToArray();

    /// <summary>A Qt <c>QByteArray</c>: a 4-byte big-endian length (<c>0xFFFFFFFF</c> = null) then the bytes.</summary>
    public byte[] ReadByteArray()
    {
        var len = ReadUInt32();
        if (len == 0xFFFFFFFF) return Array.Empty<byte>();
        if (len > int.MaxValue) throw new TdataFormatException($"QByteArray length {len} too large");
        return Take((int)len).ToArray();
    }
}

internal sealed class TdeWriter
{
    private readonly MemoryStream _ms = new();

    public void WriteInt32(int v)
    {
        Span<byte> b = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(b, v);
        _ms.Write(b);
    }

    public void WriteUInt32(uint v)
    {
        Span<byte> b = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(b, v);
        _ms.Write(b);
    }

    public void WriteInt64(long v)
    {
        Span<byte> b = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(b, v);
        _ms.Write(b);
    }

    public void WriteUInt64(ulong v)
    {
        Span<byte> b = stackalloc byte[8];
        BinaryPrimitives.WriteUInt64BigEndian(b, v);
        _ms.Write(b);
    }

    public void WriteRaw(ReadOnlySpan<byte> bytes) => _ms.Write(bytes);

    public void WriteByteArray(ReadOnlySpan<byte> bytes)
    {
        WriteUInt32((uint)bytes.Length);
        _ms.Write(bytes);
    }

    public byte[] ToArray() => _ms.ToArray();
}

/// <summary>Thrown when a tdata file does not have the structure the reader expects.</summary>
public sealed class TdataFormatException : Exception
{
    public TdataFormatException(string message) : base(message) { }
    public TdataFormatException(string message, Exception inner) : base(message, inner) { }
}
