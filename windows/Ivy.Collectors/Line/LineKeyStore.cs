using System.Runtime.Versioning;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Line;

/// <summary>
/// Holds the LINE store passphrase (the 32-character key LINE receives from its server). Per WX2 it is
/// entered once in the Windows app and kept in DPAPI; it is never uploaded and never written to the queue.
/// The key is not on disk in LINE's own files, so the user supplies it (manually or via the opt-in reader).
/// </summary>
public interface ILineKeyStore
{
    bool HasKey { get; }
    /// <summary>Returns a copy of the passphrase bytes; callers zero it after use.</summary>
    byte[] LoadKey();
    void StoreKey(ReadOnlySpan<byte> passphrase);
    void Clear();
}

/// <summary>Test/non-Windows store: keeps the key in memory only (never persisted).</summary>
public sealed class InMemoryLineKeyStore : ILineKeyStore
{
    private byte[]? _key;
    public InMemoryLineKeyStore(ReadOnlySpan<byte> key = default) { if (key.Length > 0) _key = key.ToArray(); }
    public bool HasKey => _key is not null;
    public byte[] LoadKey() => (byte[]?)_key?.Clone() ?? throw new InvalidOperationException("no LINE key set");
    public void StoreKey(ReadOnlySpan<byte> passphrase) { if (_key is not null) CryptographicOperations.ZeroMemory(_key); _key = passphrase.ToArray(); }
    public void Clear() { if (_key is not null) CryptographicOperations.ZeroMemory(_key); _key = null; }
}

/// <summary>Windows store: the key at rest is a DPAPI blob (CurrentUser) under the IVY keys directory.</summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiLineKeyStore : ILineKeyStore
{
    private readonly string _path;
    private static readonly byte[] Entropy = System.Text.Encoding.ASCII.GetBytes("ivy/line/key/v1");

    public DpapiLineKeyStore(string keysDir)
    {
        Directory.CreateDirectory(keysDir);
        _path = Path.Combine(keysDir, "line-key.bin");
    }

    public bool HasKey => File.Exists(_path);

    public byte[] LoadKey()
    {
        var blob = File.ReadAllBytes(_path);
        return ProtectedData.Unprotect(blob, Entropy, DataProtectionScope.CurrentUser);
    }

    public void StoreKey(ReadOnlySpan<byte> passphrase)
    {
        var blob = ProtectedData.Protect(passphrase.ToArray(), Entropy, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(_path, blob);
    }

    public void Clear() { if (File.Exists(_path)) File.Delete(_path); }
}

/// <summary>
/// Opens an encrypted LINE store using the passphrase from an <see cref="ILineKeyStore"/> and the wxSQLite3
/// decryptor (<see cref="LineWxCipher"/>). With no key set it reports the honest "no key" state (so the row
/// stays truthful, WL3). With a key, it decrypts the snapshot into a plaintext copy inside the snapshot's own
/// temp directory (which the caller deletes with the snapshot), opens it read-only, and returns the
/// connection. A wrong key yields a Failed result, never garbage. The key lives only in memory here.
/// </summary>
public sealed class KeyedLineUnlocker : ILineStoreUnlocker
{
    private readonly ILineKeyStore _keys;
    public KeyedLineUnlocker(ILineKeyStore keys) => _keys = keys;

    public LineUnlockResult TryOpen(string dbPath, LineStoreMap map)
    {
        if (!_keys.HasKey)
            return LineUnlockResult.Failed(
                $"LINE {map.Version} store is encrypted and no key is set, so Windows captures no LINE messages. " +
                "Enter the LINE key on the LINE page, or let the phone supply the complete history. See docs/internals/line-collector.md.");

        var passphrase = _keys.LoadKey();
        byte[] baseKey;
        try { baseKey = LineWxCipher.DeriveKey(passphrase); }
        finally { CryptographicOperations.ZeroMemory(passphrase); }

        byte[]? plain;
        try { plain = LineWxCipher.Decrypt(File.ReadAllBytes(dbPath), baseKey); }
        finally { CryptographicOperations.ZeroMemory(baseKey); }

        if (plain is null)
            return LineUnlockResult.Failed("the LINE key does not fit this store (wrong key, or a changed LINE version); re-enter it.");

        // The plaintext copy lives beside the snapshot and is removed when the caller disposes the snapshot.
        var plainPath = dbPath + ".plain";
        File.WriteAllBytes(plainPath, plain);
        CryptographicOperations.ZeroMemory(plain);
        var cs = new SqliteConnectionStringBuilder { DataSource = plainPath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString();
        var conn = new SqliteConnection(cs);
        conn.Open();
        return LineUnlockResult.Opened(conn);
    }
}
