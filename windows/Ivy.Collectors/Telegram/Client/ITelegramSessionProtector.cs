using System.Runtime.Versioning;
using System.Security.Cryptography;

namespace Ivy.Collectors.Telegram.Client;

/// <summary>
/// Sink for WTelegramClient's running session bytes. The session already encrypts the auth key under a
/// per-process key, but the running blob still must never touch the queue dir (WX2); this keeps it either in
/// memory or in the DPAPI-protected keys directory. The bytes are write-through only — the authoritative
/// session is always rebuilt from <c>tdata</c> on start, so a stale file can never override the real session.
/// </summary>
public interface ITelegramSessionProtector
{
    void Save(ReadOnlySpan<byte> sessionBytes);
}

/// <summary>Keeps the latest session bytes in memory only (tests, and non-Windows builds).</summary>
public sealed class InMemorySessionProtector : ITelegramSessionProtector
{
    public byte[]? Latest { get; private set; }
    public void Save(ReadOnlySpan<byte> sessionBytes) => Latest = sessionBytes.ToArray();
}

/// <summary>Writes the session to <c>%LOCALAPPDATA%\IVY\keys\telegram-session.bin</c>, DPAPI-protected (CurrentUser).</summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiSessionProtector : ITelegramSessionProtector
{
    private static readonly byte[] Entropy = "ivy/v1/telegram-session"u8.ToArray();
    private readonly string _path;

    public DpapiSessionProtector(string keysDirectory)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI is only available on Windows");
        Directory.CreateDirectory(keysDirectory);
        _path = Path.Combine(keysDirectory, "telegram-session.bin");
    }

    public void Save(ReadOnlySpan<byte> sessionBytes)
    {
        var @protected = ProtectedData.Protect(sessionBytes.ToArray(), Entropy, DataProtectionScope.CurrentUser);
        var tmp = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllBytes(tmp, @protected);
        File.Move(tmp, _path, overwrite: true);
    }
}
