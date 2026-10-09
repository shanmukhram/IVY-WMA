using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using Ivy.Core.Protocol;

namespace Ivy.Core.KeyStore;

/// <summary>Public pairing state (no secrets). Persisted as plain JSON alongside the protected key.</summary>
public sealed record PairingState
{
    [JsonPropertyName("v")] public int V { get; init; } = 1;
    [JsonPropertyName("deviceId")] public required string DeviceId { get; init; }
    [JsonPropertyName("role")] public required string Role { get; init; }
    [JsonPropertyName("pairingId")] public required string PairingId { get; init; }
    [JsonPropertyName("r2Endpoint")] public required string R2Endpoint { get; init; }
    [JsonPropertyName("upBucket")] public required string UpBucket { get; init; }
    [JsonPropertyName("cmdBucket")] public required string CmdBucket { get; init; }
    [JsonPropertyName("macPublicKey")] public required string MacPublicKey { get; init; }
    [JsonPropertyName("macFingerprint")] public required string MacFingerprint { get; init; }
    [JsonPropertyName("devicePublicKey")] public required string DevicePublicKey { get; init; }
    [JsonPropertyName("deviceFingerprint")] public required string DeviceFingerprint { get; init; }
    [JsonPropertyName("pairedAt")] public required string PairedAt { get; init; }

    [JsonIgnore] public byte[] MacPublicKeyBytes => Bytes.FromBase64(MacPublicKey);
}

/// <summary>The two scoped R2 tokens. Secret: stored only through <see cref="IDeviceKeyStore"/> protection.</summary>
public sealed record DeviceCredentials
{
    [JsonPropertyName("cmdReadToken")] public required string CmdReadToken { get; init; }
    [JsonPropertyName("upWriteToken")] public required string UpWriteToken { get; init; }
}

/// <summary>
/// Device key store: the device X25519 secret key, the scoped R2 tokens (both protected at rest),
/// and the public pairing state. On Windows the protection is DPAPI (<see cref="DpapiKeyStore"/>).
/// </summary>
public interface IDeviceKeyStore
{
    bool HasSecretKey { get; }
    /// <summary>Returns a copy of the 32-byte secret; callers should zero it after use.</summary>
    byte[] LoadSecretKey();
    void StoreSecretKey(ReadOnlySpan<byte> secretKey);

    DeviceCredentials? LoadCredentials();
    void StoreCredentials(DeviceCredentials credentials);

    PairingState? LoadPairingState();
    void StorePairingState(PairingState state);

    /// <summary>Forget everything (unpair).</summary>
    void Clear();
}

/// <summary>
/// File-backed key store. Secret material goes through <see cref="Protect"/>/<see cref="Unprotect"/>;
/// files are written atomically (temp + rename).
/// </summary>
public abstract class ProtectedFileKeyStore : IDeviceKeyStore
{
    private const string SecretFile = "device-key.bin";
    private const string CredentialsFile = "credentials.bin";
    private const string StateFile = "pairing.json";
    private static readonly byte[] SecretEntropy = "ivy/v1/device-key"u8.ToArray();
    private static readonly byte[] CredentialsEntropy = "ivy/v1/credentials"u8.ToArray();
    private readonly object _lock = new();

    protected ProtectedFileKeyStore(string directory)
    {
        Directory = directory;
        System.IO.Directory.CreateDirectory(directory);
    }

    public string Directory { get; }

    protected abstract byte[] Protect(byte[] plaintext, byte[] entropy);
    protected abstract byte[] Unprotect(byte[] protectedData, byte[] entropy);

    private string PathOf(string name) => Path.Combine(Directory, name);

    public bool HasSecretKey => File.Exists(PathOf(SecretFile));

    public byte[] LoadSecretKey()
    {
        lock (_lock)
        {
            if (!HasSecretKey) throw new InvalidOperationException("device key not present (not paired)");
            var sk = Unprotect(File.ReadAllBytes(PathOf(SecretFile)), SecretEntropy);
            if (sk.Length != X25519.KeyLen) throw new CryptographicException("stored device key has wrong length");
            return sk;
        }
    }

    public void StoreSecretKey(ReadOnlySpan<byte> secretKey)
    {
        if (secretKey.Length != X25519.KeyLen) throw new ArgumentException("secret key must be 32 bytes", nameof(secretKey));
        var copy = secretKey.ToArray();
        try { lock (_lock) WriteAtomic(SecretFile, Protect(copy, SecretEntropy)); }
        finally { CryptographicOperations.ZeroMemory(copy); }
    }

    public DeviceCredentials? LoadCredentials()
    {
        lock (_lock)
        {
            var p = PathOf(CredentialsFile);
            if (!File.Exists(p)) return null;
            var json = Unprotect(File.ReadAllBytes(p), CredentialsEntropy);
            try { return IvyJson.Deserialize<DeviceCredentials>(json); }
            finally { CryptographicOperations.ZeroMemory(json); }
        }
    }

    public void StoreCredentials(DeviceCredentials credentials)
    {
        var json = IvyJson.SerializeToUtf8(credentials);
        try { lock (_lock) WriteAtomic(CredentialsFile, Protect(json, CredentialsEntropy)); }
        finally { CryptographicOperations.ZeroMemory(json); }
    }

    public PairingState? LoadPairingState()
    {
        lock (_lock)
        {
            var p = PathOf(StateFile);
            return File.Exists(p) ? IvyJson.Deserialize<PairingState>(File.ReadAllBytes(p)) : null;
        }
    }

    public void StorePairingState(PairingState state)
    {
        lock (_lock) WriteAtomic(StateFile, IvyJson.SerializeToUtf8(state));
    }

    public void Clear()
    {
        lock (_lock)
        {
            foreach (var f in new[] { SecretFile, CredentialsFile, StateFile })
            {
                var p = PathOf(f);
                if (File.Exists(p)) File.Delete(p);
            }
        }
    }

    private void WriteAtomic(string name, byte[] data)
    {
        var final = PathOf(name);
        var tmp = final + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            fs.Write(data);
            fs.Flush(flushToDisk: true);
        }
        File.Move(tmp, final, overwrite: true);
    }
}

/// <summary>
/// Windows key store: secret key and tokens protected with DPAPI, <see cref="DataProtectionScope.CurrentUser"/>
/// (PRD WP3). Only constructible on Windows.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiKeyStore : ProtectedFileKeyStore
{
    public DpapiKeyStore(string directory) : base(directory)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI is only available on Windows");
    }

    protected override byte[] Protect(byte[] plaintext, byte[] entropy) =>
        ProtectedData.Protect(plaintext, entropy, DataProtectionScope.CurrentUser);

    protected override byte[] Unprotect(byte[] protectedData, byte[] entropy) =>
        ProtectedData.Unprotect(protectedData, entropy, DataProtectionScope.CurrentUser);
}

/// <summary>
/// TEST DOUBLE for non-Windows hosts. Provides NO real at-rest protection: secret material is stored
/// with a fixed marker header only. Never use in production; <see cref="DeviceKeyStores.CreateDefault"/>
/// refuses to hand it out unless explicitly asked.
/// </summary>
public sealed class FileKeyStore : ProtectedFileKeyStore
{
    private static readonly byte[] Header = "IVY-INSECURE-TEST-KEYSTORE\n"u8.ToArray();

    public FileKeyStore(string directory) : base(directory) { }

    protected override byte[] Protect(byte[] plaintext, byte[] entropy) => Bytes.Concat(Header, entropy, plaintext);

    protected override byte[] Unprotect(byte[] protectedData, byte[] entropy)
    {
        var prefix = Bytes.Concat(Header, entropy);
        if (protectedData.Length < prefix.Length || !protectedData.AsSpan(0, prefix.Length).SequenceEqual(prefix))
            throw new CryptographicException("file key store entry corrupt or for a different slot");
        return protectedData[prefix.Length..];
    }
}

public static class DeviceKeyStores
{
    /// <summary>DPAPI on Windows; elsewhere only the insecure test double, and only when <paramref name="allowInsecureTestStore"/>.</summary>
    public static IDeviceKeyStore CreateDefault(string directory, bool allowInsecureTestStore = false)
    {
        if (OperatingSystem.IsWindows()) return new DpapiKeyStore(directory);
        if (allowInsecureTestStore) return new FileKeyStore(directory);
        throw new PlatformNotSupportedException("no secure device key store on this platform");
    }
}
