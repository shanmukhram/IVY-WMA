using System.Runtime.Versioning;
using System.Security.Cryptography;
using Ivy.App.Core.WindowLock;

namespace Ivy.App.Platform;

/// <summary>
/// Keeps the window-lock record (the owner's passphrase check data, already hashed by the lock core) in
/// <c>window-lock.bin</c> inside the given directory, protected with DPAPI for the current Windows user.
/// Same pattern as the device key store: a fixed entropy string and a temp-file-then-rename write.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiWindowLockStore : IWindowLockStore
{
    private const string FileName = "window-lock.bin";
    private static readonly byte[] Entropy = "ivy/v1/window-lock"u8.ToArray();
    private readonly string _directory;
    private readonly object _gate = new();

    public DpapiWindowLockStore(string directory)
    {
        _directory = directory;
    }

    private string FilePath => Path.Combine(_directory, FileName);

    /// <summary>The saved record, or null when there is none or it cannot be unprotected (damaged, or another Windows user).</summary>
    public byte[]? Load()
    {
        lock (_gate)
        {
            try
            {
                if (!File.Exists(FilePath)) return null;
                return ProtectedData.Unprotect(File.ReadAllBytes(FilePath), Entropy, DataProtectionScope.CurrentUser);
            }
            catch
            {
                return null;
            }
        }
    }

    public void Save(byte[] record)
    {
        ArgumentNullException.ThrowIfNull(record);
        lock (_gate)
        {
            Directory.CreateDirectory(_directory);
            var protectedBytes = ProtectedData.Protect(record, Entropy, DataProtectionScope.CurrentUser);
            var tmp = FilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                fs.Write(protectedBytes);
                fs.Flush(flushToDisk: true);
            }
            File.Move(tmp, FilePath, overwrite: true);
        }
    }
}
