using System.Runtime.Versioning;
using System.Security.Cryptography;

namespace Ivy.Collectors.Telegram;

/// <summary>
/// Holds the Telegram Desktop local passcode, if the user set one. Per WT1/WX2 the passcode is entered once
/// in the Windows app and kept in DPAPI; it is never uploaded and never written to the queue. An account
/// with no local passcode needs no store (the empty passcode derives the key).
/// </summary>
public interface ITelegramPasscodeStore
{
    bool HasPasscode { get; }
    /// <summary>Returns a copy of the passcode bytes; callers zero it after use.</summary>
    byte[] LoadPasscode();
    void StorePasscode(ReadOnlySpan<byte> passcode);
    void Clear();
}

/// <summary>Test/non-Windows store: keeps the passcode in memory only (never persisted).</summary>
public sealed class InMemoryTelegramPasscodeStore : ITelegramPasscodeStore
{
    private byte[]? _passcode;

    public InMemoryTelegramPasscodeStore(ReadOnlySpan<byte> passcode = default)
    {
        if (passcode.Length > 0) _passcode = passcode.ToArray();
    }

    public bool HasPasscode => _passcode is not null;
    public byte[] LoadPasscode() => (byte[]?)_passcode?.Clone() ?? throw new InvalidOperationException("no passcode set");

    public void StorePasscode(ReadOnlySpan<byte> passcode)
    {
        if (_passcode is not null) CryptographicOperations.ZeroMemory(_passcode);
        _passcode = passcode.ToArray();
    }

    public void Clear()
    {
        if (_passcode is not null) CryptographicOperations.ZeroMemory(_passcode);
        _passcode = null;
    }
}

/// <summary>Windows store: the passcode protected with DPAPI (CurrentUser), in a file next to the agent data.</summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiTelegramPasscodeStore : ITelegramPasscodeStore
{
    private static readonly byte[] Entropy = "ivy/v1/telegram-passcode"u8.ToArray();
    private readonly string _path;

    public DpapiTelegramPasscodeStore(string directory)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI is only available on Windows");
        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, "telegram-passcode.bin");
    }

    public bool HasPasscode => File.Exists(_path);

    public byte[] LoadPasscode()
    {
        var @protected = File.ReadAllBytes(_path);
        return ProtectedData.Unprotect(@protected, Entropy, DataProtectionScope.CurrentUser);
    }

    public void StorePasscode(ReadOnlySpan<byte> passcode)
    {
        var @protected = ProtectedData.Protect(passcode.ToArray(), Entropy, DataProtectionScope.CurrentUser);
        var tmp = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllBytes(tmp, @protected);
        File.Move(tmp, _path, overwrite: true);
    }

    public void Clear()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }
}
