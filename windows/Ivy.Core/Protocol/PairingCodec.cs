using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ivy.Core.Protocol;

/// <summary>Decoded pairing string payload (PROTOCOL.md §7). Property order matches the reference.</summary>
public sealed record PairingPayload
{
    [JsonPropertyName("v")] public int V { get; init; } = 1;
    [JsonPropertyName("r2Endpoint")] public required string R2Endpoint { get; init; }
    [JsonPropertyName("role")] public required string Role { get; init; }
    [JsonPropertyName("cmdBucket")] public required string CmdBucket { get; init; }
    [JsonPropertyName("upBucket")] public required string UpBucket { get; init; }
    [JsonPropertyName("cmdReadToken")] public required string CmdReadToken { get; init; }
    [JsonPropertyName("macPublicKey")] public required string MacPublicKey { get; init; }
    [JsonPropertyName("macFingerprint")] public required string MacFingerprint { get; init; }
    [JsonPropertyName("pairingId")] public required string PairingId { get; init; }
    [JsonPropertyName("secret")] public required string Secret { get; init; }
    /// <summary>Expiry, Unix epoch milliseconds.</summary>
    [JsonPropertyName("exp")] public required long Exp { get; init; }
}

/// <summary>Plaintext of the bootstrap object <c>pair/&lt;pairingId&gt;</c>.</summary>
public sealed record BootstrapPayload
{
    [JsonPropertyName("v")] public int V { get; init; } = 1;
    [JsonPropertyName("upBucket")] public required string UpBucket { get; init; }
    [JsonPropertyName("upWriteToken")] public required string UpWriteToken { get; init; }
    [JsonPropertyName("pairingId")] public required string PairingId { get; init; }
}

/// <summary>Serialized sealed bootstrap: <c>{ v:1, nonce, ct }</c> (base64).</summary>
public sealed record SealedBootstrap
{
    [JsonPropertyName("v")] public int V { get; init; } = 1;
    [JsonPropertyName("nonce")] public required string Nonce { get; init; }
    [JsonPropertyName("ct")] public required string Ct { get; init; }
}

public sealed class PairingException : Exception
{
    public PairingException(string message) : base(message) { }
    public PairingException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>Pairing string encode/decode and bootstrap sealing (§7).</summary>
public static class PairingCodec
{
    public const string Prefix = "IVYPAIR1";
    public const int SecretLen = 32;
    private static readonly byte[] BootstrapInfo = "IVY1 pair v1"u8.ToArray();
    private static readonly byte[] BootstrapAadLabel = "ivy/v1/pair"u8.ToArray();

    public static string Encode(PairingPayload payload) =>
        $"{Prefix}.{Bytes.ToBase64Url(IvyJson.SerializeToUtf8(payload))}";

    /// <summary>
    /// Decode and validate format, version and expiry. Fingerprint verification is a separate step
    /// (<see cref="VerifyMacFingerprint"/>) so callers can report it distinctly.
    /// </summary>
    public static PairingPayload Decode(string s, DateTimeOffset now)
    {
        s = s.Trim();
        var dot = s.IndexOf('.', StringComparison.Ordinal);
        if (dot < 0 || s[..dot] != Prefix) throw new PairingException("not an IVY pairing string");
        PairingPayload p;
        try { p = IvyJson.Deserialize<PairingPayload>(Bytes.FromBase64Url(s[(dot + 1)..])); }
        catch (Exception e) when (e is FormatException or JsonException) { throw new PairingException("malformed pairing string", e); }
        if (p.V != 1) throw new PairingException($"unsupported pairing version {p.V}");
        if (now.ToUnixTimeMilliseconds() > p.Exp) throw new PairingException("pairing code expired");
        return p;
    }

    /// <summary>Throws unless <c>fingerprint(macPublicKey) == macFingerprint</c>.</summary>
    public static byte[] VerifyMacFingerprint(PairingPayload p)
    {
        byte[] pub;
        try { pub = Bytes.FromBase64(p.MacPublicKey); }
        catch (FormatException e) { throw new PairingException("mac public key is not base64", e); }
        if (pub.Length != X25519.KeyLen) throw new PairingException("mac public key must be 32 bytes");
        if (!Fingerprint.Matches(Fingerprint.Of(pub), p.MacFingerprint))
            throw new PairingException("mac fingerprint does not match mac public key");
        return pub;
    }

    private static byte[] BootstrapKey(byte[] secret, string pairingId) =>
        Hkdf256.Derive(secret, Bytes.Utf8.GetBytes(pairingId), BootstrapInfo);

    private static byte[] BootstrapAad(string pairingId) =>
        Bytes.Concat(BootstrapAadLabel, new byte[] { 0x00 }, Bytes.Utf8.GetBytes(pairingId));

    /// <summary>Seal a bootstrap (Mac side; used by tests to simulate the Mac).</summary>
    public static SealedBootstrap SealBootstrap(BootstrapPayload payload, byte[] secret, byte[]? nonce = null)
    {
        if (secret.Length != SecretLen) throw new ArgumentException("secret must be 32 bytes", nameof(secret));
        var key = BootstrapKey(secret, payload.PairingId);
        nonce ??= SystemRandomSource.Instance.Bytes(AesGcm256.NonceLen);
        var pt = IvyJson.SerializeToUtf8(payload);
        try
        {
            var ct = AesGcm256.Encrypt(key, nonce, pt, BootstrapAad(payload.PairingId));
            return new SealedBootstrap { Nonce = Bytes.ToBase64(nonce), Ct = Bytes.ToBase64(ct) };
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(pt);
        }
    }

    /// <summary>Open a sealed bootstrap with the one-time secret. Throws <see cref="PairingException"/>.</summary>
    public static BootstrapPayload OpenBootstrap(SealedBootstrap sealedBootstrap, byte[] secret, string pairingId)
    {
        if (sealedBootstrap.V != 1) throw new PairingException($"unsupported bootstrap version {sealedBootstrap.V}");
        if (secret.Length != SecretLen) throw new PairingException("secret must be 32 bytes");
        var key = BootstrapKey(secret, pairingId);
        byte[] pt;
        try { pt = AesGcm256.Decrypt(key, Bytes.FromBase64(sealedBootstrap.Nonce), Bytes.FromBase64(sealedBootstrap.Ct), BootstrapAad(pairingId)); }
        catch (Exception e) when (e is IvyCryptoException or FormatException) { throw new PairingException("bootstrap authentication failed", e); }
        finally { CryptographicOperations.ZeroMemory(key); }
        try
        {
            var b = IvyJson.Deserialize<BootstrapPayload>(pt);
            if (b.V != 1) throw new PairingException($"unsupported bootstrap payload version {b.V}");
            if (b.PairingId != pairingId) throw new PairingException("bootstrap pairing id mismatch");
            return b;
        }
        catch (JsonException e) { throw new PairingException("malformed bootstrap", e); }
        finally { CryptographicOperations.ZeroMemory(pt); }
    }
}
