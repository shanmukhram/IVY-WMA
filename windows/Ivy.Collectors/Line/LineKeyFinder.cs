using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.RegularExpressions;

namespace Ivy.Collectors.Line;

/// <summary>
/// Reads LINE's own key out of the running LINE for Windows process, as the one step that is not on disk
/// (docs/internals/line-collector.md). This is the user's own key for the user's own account on the user's own
/// machine, used to back up the user's own messages. It is opt-in, only ever targets LINE's own process, and
/// the key it finds is handed to the DPAPI key store and never uploaded (WX2). The value-extraction logic is
/// separated from the Windows process read so it can be tested on any platform.
/// </summary>
public static partial class LineKeyFinder
{
    // The 32-hex-character key appears bounded by these markers, or on its own as 32 hex chars.
    private const string Prefix1 = "encryption_key=";
    private const string Prefix2 = "encryptionkey=";
    private const string Suffix = "mse";

    [GeneratedRegex("[0-9a-f]{32}")]
    private static partial Regex HexKey();

    /// <summary>
    /// Pull the key out of a region of memory. Prefer a value framed by the documented markers; fall back to a
    /// lone 32-hex run. Returns the ASCII key bytes, or null when the region holds none.
    /// </summary>
    public static byte[]? Extract(ReadOnlySpan<byte> region)
    {
        // Treat the bytes as latin1 text so byte offsets and char offsets line up for the marker search.
        var text = Latin1(region);
        foreach (var prefix in new[] { Prefix1, Prefix2 })
        {
            var i = text.IndexOf(prefix, StringComparison.Ordinal);
            while (i >= 0)
            {
                var start = i + prefix.Length;
                var end = text.IndexOf(Suffix, start, StringComparison.Ordinal);
                var slice = end > start ? text[start..end] : text[start..Math.Min(start + 64, text.Length)];
                var m = HexKey().Match(slice);
                if (m.Success) return Encoding.ASCII.GetBytes(m.Value);
                i = text.IndexOf(prefix, start, StringComparison.Ordinal);
            }
        }
        var lone = HexKey().Match(text);
        return lone.Success ? Encoding.ASCII.GetBytes(lone.Value) : null;
    }

    private static string Latin1(ReadOnlySpan<byte> bytes)
    {
        var chars = new char[bytes.Length];
        for (var i = 0; i < bytes.Length; i++) chars[i] = (char)bytes[i];
        return new string(chars);
    }

    /// <summary>
    /// Scan the running LINE process for the key (Windows only). Returns the key or null if LINE is not
    /// running or the key could not be found. Every candidate is confirmed against the store before use by the
    /// caller (a wrong value simply fails to decrypt), so this never feeds an unverified value into the vault.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static byte[]? FromRunningLine()
    {
        var proc = System.Diagnostics.Process.GetProcessesByName("LINE").FirstOrDefault(p =>
        {
            try { return (p.MainModule?.FileName ?? "").EndsWith("LINE.exe", StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        });
        if (proc is null) return null;

        var h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, proc.Id);
        if (h == IntPtr.Zero) return null;
        try
        {
            var addr = IntPtr.Zero;
            var buf = new byte[1 << 20];
            while (VirtualQueryEx(h, addr, out var mbi, (uint)Marshal.SizeOf<MEMORY_BASIC_INFORMATION>()) != 0)
            {
                var regionBase = mbi.BaseAddress;
                var regionSize = (long)mbi.RegionSize;
                if (mbi.State == MEM_COMMIT && (mbi.Protect & PAGE_READABLE) != 0 && (mbi.Protect & PAGE_GUARD) == 0)
                {
                    for (long off = 0; off < regionSize; off += buf.Length)
                    {
                        var want = (int)Math.Min(buf.Length, regionSize - off);
                        if (ReadProcessMemory(h, regionBase + (nint)off, buf, want, out var read) && read > 0)
                        {
                            var key = Extract(buf.AsSpan(0, (int)read));
                            if (key is not null) return key;
                        }
                    }
                }
                var next = (long)regionBase + regionSize;
                if (next <= (long)addr) break;
                addr = (nint)next;
            }
            return null;
        }
        finally { CloseHandle(h); }
    }

    private const int PROCESS_VM_READ = 0x0010;
    private const int PROCESS_QUERY_INFORMATION = 0x0400;
    private const int MEM_COMMIT = 0x1000;
    private const uint PAGE_GUARD = 0x100;
    private const uint PAGE_READABLE = 0x02 | 0x04 | 0x20 | 0x40; // READONLY|READWRITE|EXECUTE_READ|EXECUTE_READWRITE

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORY_BASIC_INFORMATION
    {
        public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect;
        public IntPtr RegionSize; public int State; public uint Protect; public int Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION mbi, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
}
