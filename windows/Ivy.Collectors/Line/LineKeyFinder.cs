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
    /// First candidate (backward-compatible): a value framed by the documented markers, else a lone 32-hex run.
    /// </summary>
    public static byte[]? Extract(ReadOnlySpan<byte> region) => Candidates(region).FirstOrDefault();

    /// <summary>
    /// Every distinct 32-hex candidate in a region, marker-framed ones first. The real key is one of these; the
    /// caller confirms each against the store (a candidate that does not decrypt is simply discarded), so this
    /// never needs the markers to be present in this LINE version.
    /// </summary>
    public static IEnumerable<byte[]> Candidates(ReadOnlySpan<byte> region)
    {
        var text = Latin1(region);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<string>();
        void Add(string hex) { if (seen.Add(hex)) ordered.Add(hex); }

        foreach (var prefix in new[] { Prefix1, Prefix2 })
        {
            var i = text.IndexOf(prefix, StringComparison.Ordinal);
            while (i >= 0)
            {
                var start = i + prefix.Length;
                var end = text.IndexOf(Suffix, start, StringComparison.Ordinal);
                var slice = end > start ? text[start..end] : text[start..Math.Min(start + 64, text.Length)];
                var m = HexKey().Match(slice);
                if (m.Success) Add(m.Value);
                i = text.IndexOf(prefix, start, StringComparison.Ordinal);
            }
        }
        foreach (Match m in HexKey().Matches(text)) Add(m.Value);
        return ordered.Select(h => Encoding.ASCII.GetBytes(h)).ToList();
    }

    private static string Latin1(ReadOnlySpan<byte> bytes)
    {
        var chars = new char[bytes.Length];
        for (var i = 0; i < bytes.Length; i++) chars[i] = (char)bytes[i];
        return new string(chars);
    }

    /// <summary>
    /// Scan the running LINE process for a key that <paramref name="fits"/> accepts (Windows only). Returns the
    /// first candidate the predicate confirms, or null if LINE is not running or none fit. The predicate is the
    /// store check, so only a key that actually decrypts the store is ever returned.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static byte[]? FromRunningLine(Func<byte[], bool> fits)
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
                            foreach (var cand in Candidates(buf.AsSpan(0, (int)read)))
                                if (fits(cand)) return cand;
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
