using System.Security.Cryptography;
using System.Text;

namespace Ivy.Collectors.Telegram.TData;

/// <summary>
/// Locates a Telegram Desktop <c>tdata</c> folder and maps account indices to their on-disk file names,
/// following tdesktop's own derivation (<c>ToFilePart</c>, <c>ComputeDataNameKey</c>, <c>ComposeDataString</c>
/// in <c>storage/storage_account.cpp</c>).
///
/// The default folder is <c>%APPDATA%\Telegram Desktop\tdata</c>. A portable install keeps <c>tdata</c> next
/// to the executable, so an explicit path is also accepted. The exact per-account file naming is reproduced
/// here from the tdesktop source but, with no reference install on this machine, it is one of the things the
/// README flags for verification on the PC.
/// </summary>
public static class TdataLayout
{
    public const string KeyFileName = "key_datas";

    /// <summary>Candidate tdata directories, most specific first. Returns the first that exists, else null.</summary>
    public static string? Resolve(string? configuredPath, string? portableExeDir = null)
    {
        foreach (var candidate in Candidates(configuredPath, portableExeDir))
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(candidate, KeyFileName)))
                return candidate;
        // Fall back to the first candidate that at least exists as a directory, so status can say why.
        foreach (var candidate in Candidates(configuredPath, portableExeDir))
            if (Directory.Exists(candidate))
                return candidate;
        return null;
    }

    public static IEnumerable<string> Candidates(string? configuredPath, string? portableExeDir)
    {
        if (!string.IsNullOrWhiteSpace(configuredPath))
        {
            yield return configuredPath;
            // Allow pointing at the install/portable root instead of tdata itself.
            yield return Path.Combine(configuredPath, "tdata");
        }
        if (!string.IsNullOrWhiteSpace(portableExeDir))
            yield return Path.Combine(portableExeDir, "tdata");

        var appData = Environment.GetEnvironmentVariable("APPDATA");
        if (string.IsNullOrEmpty(appData) && OperatingSystem.IsWindows())
            appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (!string.IsNullOrEmpty(appData))
            yield return Path.Combine(appData, "Telegram Desktop", "tdata");
    }

    /// <summary>tdesktop <c>ComposeDataString("data", index)</c>: index 0 → <c>data</c>, else <c>data#(index+1)</c>.</summary>
    public static string DataName(int index) => index > 0 ? "data#" + (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture) : "data";

    /// <summary>tdesktop <c>ComputeDataNameKey</c>: the first 8 bytes of MD5(utf8(dataName)) as a little-endian u64.</summary>
    public static ulong ComputeDataNameKey(string dataName)
    {
        var md5 = MD5.HashData(Encoding.UTF8.GetBytes(dataName));
        ulong k = 0;
        for (var i = 0; i < 8; i++) k |= (ulong)md5[i] << (8 * i);
        return k;
    }

    /// <summary>tdesktop <c>ToFilePart</c>: 16 uppercase hex chars, low nibble first.</summary>
    public static string ToFilePart(ulong value)
    {
        var sb = new StringBuilder(16);
        for (var i = 0; i < 16; i++)
        {
            var v = (int)(value & 0x0F);
            sb.Append((char)(v < 0x0A ? '0' + v : 'A' + (v - 0x0A)));
            value >>= 4;
        }
        return sb.ToString();
    }

    /// <summary>The account's cache directory: <c>tdata/&lt;ToFilePart(key)&gt;/</c> (map and media; not the MTP block).</summary>
    public static string AccountBaseDir(string tdataDir, int index) =>
        Path.Combine(tdataDir, ToFilePart(ComputeDataNameKey(DataName(index))));

    /// <summary>
    /// The logical base path of the account's MTProto authorization file: <c>tdata/&lt;ToFilePart(key)&gt;</c>,
    /// directly under tdata (tdesktop <c>writeMtpData</c> uses <c>ToFilePart(_dataNameKey)</c> in the base
    /// folder, not inside the account directory). The real file carries a safe-write suffix; resolve it with
    /// <see cref="ResolveSafeWrite"/>.
    /// </summary>
    public static string AccountMtpBase(string tdataDir, int index) =>
        Path.Combine(tdataDir, ToFilePart(ComputeDataNameKey(DataName(index))));

    /// <summary>The logical base path of the key file: <c>tdata/key_data</c> (on disk <c>key_datas</c> etc.).</summary>
    public static string KeyBase(string tdataDir) => Path.Combine(tdataDir, "key_data");

    /// <summary>
    /// tdesktop's safe-write scheme (<c>storage_file_utilities.cpp</c>): a logical file <c>base</c> is stored
    /// as <c>base + 's'</c> (the atomic copy), with <c>base + '0'</c> / <c>base + '1'</c> as the legacy/in-progress
    /// pair. The reader prefers <c>'s'</c>; otherwise it takes whichever of <c>'0'</c>/<c>'1'</c> is newer.
    /// Returns the path to open, or null if none exists.
    /// </summary>
    public static string? ResolveSafeWrite(string basePath)
    {
        var safe = basePath + "s";
        if (File.Exists(safe)) return safe;
        var zero = basePath + "0";
        var one = basePath + "1";
        var hasZero = File.Exists(zero);
        var hasOne = File.Exists(one);
        if (hasZero && hasOne)
            return File.GetLastWriteTimeUtc(zero) >= File.GetLastWriteTimeUtc(one) ? zero : one;
        if (hasZero) return zero;
        if (hasOne) return one;
        return null;
    }
}
