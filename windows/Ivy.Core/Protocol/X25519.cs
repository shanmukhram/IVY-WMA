using System.Security.Cryptography;
using NSec.Cryptography;

namespace Ivy.Core.Protocol;

/// <summary>
/// X25519 (RFC 7748) via NSec/libsodium. Secret scalars are 32 raw bytes used directly; clamping
/// happens inside the X25519 function.
/// </summary>
public static class X25519
{
    public const int KeyLen = 32;
    private static readonly KeyAgreementAlgorithm Alg = KeyAgreementAlgorithm.X25519;

    public static byte[] PublicKeyFromSecret(ReadOnlySpan<byte> secretKey)
    {
        if (secretKey.Length != KeyLen) throw new ArgumentException("secret key must be 32 bytes", nameof(secretKey));
        using var key = Key.Import(Alg, secretKey, KeyBlobFormat.RawPrivateKey);
        return key.PublicKey.Export(KeyBlobFormat.RawPublicKey);
    }

    /// <summary>Generate a random keypair (device keys, PROTOCOL.md §3.2).</summary>
    public static (byte[] SecretKey, byte[] PublicKey) GenerateKeyPair(IRandomSource? random = null)
    {
        var sk = (random ?? SystemRandomSource.Instance).Bytes(KeyLen);
        return (sk, PublicKeyFromSecret(sk));
    }

    /// <summary>HKDF-SHA256(ikm = X25519(secret, peer), salt, info, 32). The raw shared secret never leaves NSec.</summary>
    internal static byte[] AgreeAndDerive(ReadOnlySpan<byte> secretKey, ReadOnlySpan<byte> peerPublicKey, ReadOnlySpan<byte> salt, ReadOnlySpan<byte> info)
    {
        if (secretKey.Length != KeyLen) throw new ArgumentException("secret key must be 32 bytes", nameof(secretKey));
        if (peerPublicKey.Length != KeyLen) throw new ArgumentException("public key must be 32 bytes", nameof(peerPublicKey));
        using var key = Key.Import(Alg, secretKey, KeyBlobFormat.RawPrivateKey);
        var peer = PublicKey.Import(Alg, peerPublicKey, KeyBlobFormat.RawPublicKey);
        using var shared = Alg.Agree(key, peer) ?? throw new IvyCryptoException("X25519 agreement failed (low-order point)");
        return KeyDerivationAlgorithm.HkdfSha256.DeriveBytes(shared, salt, info, AesGcm256.KeyLen);
    }
}

/// <summary>HKDF-SHA256 over plain input keying material (pairing bootstrap key, §7).</summary>
public static class Hkdf256
{
    public static byte[] Derive(byte[] ikm, byte[] salt, byte[] info, int length = 32) =>
        HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, length, salt, info);
}

/// <summary>Fingerprint of a public key (§3.4): SHA-256(pub)[0:8] uppercase hex, XXXX-XXXX-XXXX-XXXX.</summary>
public static class Fingerprint
{
    public static string Of(ReadOnlySpan<byte> publicKey)
    {
        if (publicKey.Length != X25519.KeyLen) throw new ArgumentException("public key must be 32 bytes", nameof(publicKey));
        var hex = Convert.ToHexString(SHA256.HashData(publicKey).AsSpan(0, 8));
        return $"{hex[..4]}-{hex[4..8]}-{hex[8..12]}-{hex[12..16]}";
    }

    public static string OfBase64(string publicKeyB64) => Of(Bytes.FromBase64(publicKeyB64));

    /// <summary>Constant-time comparison of two fingerprint strings.</summary>
    public static bool Matches(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Bytes.Utf8.GetBytes(a), Bytes.Utf8.GetBytes(b));
}
