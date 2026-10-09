#if WINDOWS
using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Ivy.Collectors.Abstractions;
using Microsoft.Win32.SafeHandles;
using static Ivy.Collectors.Windows.NativeMethods;

namespace Ivy.Collectors.Windows;

/// <summary>
/// NTFS change journal via DeviceIoControl. Opens <c>\\.\C:</c> with GENERIC_READ (needs elevation); if
/// that is denied it falls back to FSCTL_READ_UNPRIVILEGED_USN_JOURNAL (Windows 10 1709+) on a handle
/// opened with FILE_READ_ATTRIBUTES. Records are USN_RECORD_V2 (requested through READ_USN_JOURNAL_DATA_V0).
/// Full paths are resolved from the parent directory's file reference (OpenFileById +
/// GetFinalPathNameByHandle) plus the record's file name; parent paths are cached per volume.
/// NOT VERIFIED ON macOS: compiled for the Windows target only.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsUsnJournal : IUsnJournal, IDisposable
{
    private sealed class Volume : IDisposable
    {
        public required SafeFileHandle Handle { get; init; }
        public required bool Unprivileged { get; init; }
        public Dictionary<long, string?> ParentPaths { get; } = new();
        public void Dispose() => Handle.Dispose();
    }

    private readonly Dictionary<string, Volume> _volumes = new(StringComparer.OrdinalIgnoreCase);
    private const int BufferSize = 64 * 1024;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;

    public UsnJournalInfo Query(string volume)
    {
        var v = Open(volume);
        var size = Marshal.SizeOf<USN_JOURNAL_DATA_V0>();
        var buf = Marshal.AllocHGlobal(size);
        try
        {
            if (!DeviceIoControl(v.Handle, FSCTL_QUERY_USN_JOURNAL, IntPtr.Zero, 0, buf, size, out _, IntPtr.Zero))
                throw Translate(Marshal.GetLastWin32Error(), volume);
            var d = Marshal.PtrToStructure<USN_JOURNAL_DATA_V0>(buf);
            return new UsnJournalInfo(d.UsnJournalID, d.FirstUsn, d.NextUsn);
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    public UsnReadResult Read(string volume, ulong journalId, long startUsn, int maxRecords)
    {
        var v = Open(volume);
        var input = new READ_USN_JOURNAL_DATA_V0
        {
            StartUsn = startUsn,
            ReasonMask = 0xFFFFFFFF,
            ReturnOnlyOnClose = 0,
            Timeout = 0,
            BytesToWaitFor = 0,
            UsnJournalID = journalId,
        };
        var inSize = Marshal.SizeOf<READ_USN_JOURNAL_DATA_V0>();
        var inBuf = Marshal.AllocHGlobal(inSize);
        var outBuf = Marshal.AllocHGlobal(BufferSize);
        var changes = new List<UsnChange>();
        var next = startUsn;
        try
        {
            while (changes.Count < maxRecords)
            {
                input.StartUsn = next;
                Marshal.StructureToPtr(input, inBuf, false);
                var code = v.Unprivileged ? FSCTL_READ_UNPRIVILEGED_USN_JOURNAL : FSCTL_READ_USN_JOURNAL;
                if (!DeviceIoControl(v.Handle, code, inBuf, inSize, outBuf, BufferSize, out var returned, IntPtr.Zero))
                {
                    var err = Marshal.GetLastWin32Error();
                    if (err == ERROR_HANDLE_EOF) break;
                    throw Translate(err, volume);
                }
                if (returned < 8) break;
                var bytes = new byte[returned];
                Marshal.Copy(outBuf, bytes, 0, returned);
                var newNext = BinaryPrimitives.ReadInt64LittleEndian(bytes);
                var offset = 8;
                while (offset + 60 <= returned)
                {
                    var span = bytes.AsSpan(offset);
                    var recordLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(span);
                    if (recordLength <= 0 || offset + recordLength > returned) break;
                    var major = BinaryPrimitives.ReadUInt16LittleEndian(span[4..]);
                    if (major == 2)
                    {
                        // USN_RECORD_V2: FRN @8, ParentFRN @16, Usn @24, TimeStamp @32, Reason @40, SourceInfo @44,
                        // SecurityId @48, FileAttributes @52, FileNameLength @56, FileNameOffset @58.
                        var parent = BinaryPrimitives.ReadInt64LittleEndian(span[16..]);
                        var usn = BinaryPrimitives.ReadInt64LittleEndian(span[24..]);
                        var reason = BinaryPrimitives.ReadUInt32LittleEndian(span[40..]);
                        var attrs = BinaryPrimitives.ReadUInt32LittleEndian(span[52..]);
                        var nameLen = BinaryPrimitives.ReadUInt16LittleEndian(span[56..]);
                        var nameOff = BinaryPrimitives.ReadUInt16LittleEndian(span[58..]);
                        var name = new string(MemoryMarshal.Cast<byte, char>(span.Slice(nameOff, nameLen)));
                        var parentPath = ResolveParent(v, parent);
                        changes.Add(new UsnChange(usn, reason, name, parentPath is null ? null : Path.Combine(parentPath, name),
                            (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0));
                    }
                    offset += recordLength;
                }
                if (newNext <= next) break;
                next = newNext;
                if (returned <= 8) break;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(inBuf);
            Marshal.FreeHGlobal(outBuf);
        }
        return new UsnReadResult(changes, next);
    }

    private Volume Open(string volume)
    {
        var root = Path.GetPathRoot(volume) ?? volume;
        if (_volumes.TryGetValue(root, out var v)) return v;
        var device = @"\\.\" + root.TrimEnd('\\', '/');
        var h = CreateFileW(device, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        var unprivileged = false;
        if (h.IsInvalid)
        {
            var err = Marshal.GetLastWin32Error();
            h.Dispose();
            if (err != ERROR_ACCESS_DENIED) throw Translate(err, root);
            h = CreateFileW(device, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (h.IsInvalid)
            {
                var err2 = Marshal.GetLastWin32Error();
                h.Dispose();
                throw Translate(err2, root);
            }
            unprivileged = true;
        }
        v = new Volume { Handle = h, Unprivileged = unprivileged };
        _volumes[root] = v;
        return v;
    }

    private static string? ResolveParent(Volume v, long parentFrn)
    {
        if (v.ParentPaths.TryGetValue(parentFrn, out var cached)) return cached;
        if (v.ParentPaths.Count > 50_000) v.ParentPaths.Clear();
        var desc = new FILE_ID_DESCRIPTOR { dwSize = 24, Type = 0, FileId = parentFrn };
        string? path = null;
        using (var h = OpenFileById(v.Handle, ref desc, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, FILE_FLAG_BACKUP_SEMANTICS))
        {
            if (!h.IsInvalid)
            {
                var buf = new char[32768];
                var n = GetFinalPathNameByHandleW(h, buf, buf.Length, 0);
                if (n > 0 && n < buf.Length)
                {
                    path = new string(buf, 0, n);
                    if (path.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) path = @"\\" + path[8..];
                    else if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path[4..];
                }
            }
        }
        v.ParentPaths[parentFrn] = path;
        return path;
    }

    private static Exception Translate(int err, string volume) => err switch
    {
        ERROR_ACCESS_DENIED => new UnauthorizedAccessException($"access denied opening the USN journal on {volume}"),
        ERROR_JOURNAL_NOT_ACTIVE or ERROR_INVALID_FUNCTION => new NotSupportedException($"no active USN journal on {volume}"),
        ERROR_JOURNAL_ENTRY_DELETED or ERROR_JOURNAL_DELETE_IN_PROGRESS => new IOException($"USN journal on {volume} was reset ({new Win32Exception(err).Message})"),
        _ => new IOException($"USN journal on {volume}: {new Win32Exception(err).Message}"),
    };

    public void Dispose()
    {
        foreach (var v in _volumes.Values) v.Dispose();
        _volumes.Clear();
    }
}
#endif
