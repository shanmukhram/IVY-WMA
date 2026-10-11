using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ivy.App.Core.WindowLock;

/// <summary>
/// Hashing for the window lock passphrase. The passphrase is run through PBKDF2-HMAC-SHA256 with a random 16-byte
/// salt and stored only as that salted hash, serialised as
/// <c>{"v":1,"kdf":"pbkdf2-sha256","iterations":N,"salt":base64,"hash":base64}</c>.
/// Nothing here logs; callers must not log the passphrase, the salt or the hash either.
/// </summary>
public static class PassphraseHash
{
    public const int Version = 1;
    public const string Kdf = "pbkdf2-sha256";
    /// <summary>PBKDF2 iteration count for new records.</summary>
    public const int Iterations = 600_000;
    public const int SaltBytes = 16;
    public const int HashBytes = 32;
    /// <summary>Upper bound on the iteration count read back from a record, so a damaged record cannot stall the UI.</summary>
    private const int MaxIterations = 10_000_000;

    /// <summary>Hash <paramref name="passphrase"/> with a fresh random salt and return the JSON record bytes.</summary>
    public static byte[] Create(string passphrase)
    {
        ArgumentNullException.ThrowIfNull(passphrase);
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Derive(passphrase, salt, Iterations);
        try
        {
            return JsonSerializer.SerializeToUtf8Bytes(new Record
            {
                V = Version,
                Kdf = Kdf,
                Iterations = Iterations,
                Salt = Convert.ToBase64String(salt),
                Hash = Convert.ToBase64String(hash),
            });
        }
        finally
        {
            CryptographicOperations.ZeroMemory(hash);
        }
    }

    /// <summary>True when <paramref name="passphrase"/> matches the record. A missing, corrupt or unknown record is false.</summary>
    public static bool Verify(string passphrase, byte[]? record)
    {
        if (passphrase is null || !TryParse(record, out var iterations, out var salt, out var expected)) return false;
        var actual = Derive(passphrase, salt, iterations);
        try { return CryptographicOperations.FixedTimeEquals(actual, expected); }
        finally { CryptographicOperations.ZeroMemory(actual); }
    }

    /// <summary>True when <paramref name="record"/> parses as a usable record.</summary>
    public static bool IsValid(byte[]? record) => TryParse(record, out _, out _, out _);

    private static byte[] Derive(string passphrase, byte[] salt, int iterations)
    {
        var bytes = Encoding.UTF8.GetBytes(passphrase);
        try { return Rfc2898DeriveBytes.Pbkdf2(bytes, salt, iterations, HashAlgorithmName.SHA256, HashBytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static bool TryParse(byte[]? record, out int iterations, out byte[] salt, out byte[] hash)
    {
        iterations = 0;
        salt = Array.Empty<byte>();
        hash = Array.Empty<byte>();
        if (record is null || record.Length == 0) return false;
        Record? r;
        try { r = JsonSerializer.Deserialize<Record>(record); }
        catch (JsonException) { return false; }
        if (r is null || r.V != Version || r.Kdf != Kdf || r.Iterations is < 1 or > MaxIterations
            || r.Salt is null || r.Hash is null) return false;
        try
        {
            salt = Convert.FromBase64String(r.Salt);
            hash = Convert.FromBase64String(r.Hash);
        }
        catch (FormatException) { return false; }
        if (salt.Length != SaltBytes || hash.Length != HashBytes) return false;
        iterations = r.Iterations;
        return true;
    }

    private sealed class Record
    {
        [JsonPropertyName("v")] public int V { get; set; }
        [JsonPropertyName("kdf")] public string? Kdf { get; set; }
        [JsonPropertyName("iterations")] public int Iterations { get; set; }
        [JsonPropertyName("salt")] public string? Salt { get; set; }
        [JsonPropertyName("hash")] public string? Hash { get; set; }
    }
}
