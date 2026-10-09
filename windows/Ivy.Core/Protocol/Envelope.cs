using System.Security.Cryptography;

namespace Ivy.Core.Protocol;

/// <summary>
/// TEST-ONLY injection points for <see cref="Envelope.Encrypt(byte[],Kind,string,ReadOnlySpan{byte},EnvelopeTestInputs?)"/>.
/// Production callers never set these; fresh randomness is drawn for each object.
/// </summary>
internal sealed record EnvelopeTestInputs(
    byte[]? EphemeralSecretKey = null,
    byte[]? ContentKey = null,
    byte[]? WrapNonce = null,
    byte[]? BodyNonce = null);

public sealed record DecryptedEnvelope(Kind Kind, byte[] Plaintext);

/// <summary>Single-shot envelope (PROTOCOL.md §2.1, mode 0x01).</summary>
public static class Envelope
{
    public static readonly byte[] Magic = "IVY1"u8.ToArray();
    public const byte Version = 0x01;
    public const byte ModeSingle = 0x01;
    public const byte ModeChunk = 0x02;

    public const int HeaderFixedLen = 8;
    public const int EpkLen = 32;
    public const int WrappedCekLen = AesGcm256.KeyLen + AesGcm256.TagLen; // 48
    public const int BodyOffset = HeaderFixedLen + EpkLen + AesGcm256.NonceLen + WrappedCekLen + AesGcm256.NonceLen; // 112
    public const int MinLength = BodyOffset + AesGcm256.TagLen; // 128

    private static readonly byte[] HkdfInfo = "IVY1 kek v1"u8.ToArray();
    private static readonly byte[] AadWrapLabel = "ivy/v1/wrap"u8.ToArray();
    private static readonly byte[] AadBodyLabel = "ivy/v1/body"u8.ToArray();
    private static readonly byte[] Sep = { 0x00 };

    /// <summary>Length of a single-shot envelope for an N-byte plaintext.</summary>
    public static long SizeFor(long plaintextLength) => BodyOffset + plaintextLength + AesGcm256.TagLen;

    internal static byte[] WrapAad(string objectKey, Kind kind, byte[] epk) =>
        Bytes.Concat(AadWrapLabel, Sep, Bytes.Utf8.GetBytes(objectKey), Sep, new[] { kind.Id() }, Sep, epk);

    internal static byte[] BodyAad(string objectKey, Kind kind, byte[] epk) =>
        Bytes.Concat(AadBodyLabel, Sep, Bytes.Utf8.GetBytes(objectKey), Sep, new[] { kind.Id() }, Sep, epk);

    private static byte[] DeriveKek(byte[] secret, byte[] peerPublic, byte[] epk, byte[] recipientPublic) =>
        X25519.AgreeAndDerive(secret, peerPublic, salt: epk, info: Bytes.Concat(HkdfInfo, recipientPublic));

    /// <summary>Encrypt one object to <paramref name="recipientPublicKey"/>, bound to <paramref name="objectKey"/> and <paramref name="kind"/>.</summary>
    public static byte[] Encrypt(byte[] recipientPublicKey, Kind kind, string objectKey, ReadOnlySpan<byte> plaintext, IRandomSource? random = null) =>
        EncryptCore(recipientPublicKey, kind, objectKey, plaintext, null, random ?? SystemRandomSource.Instance);

    internal static byte[] Encrypt(byte[] recipientPublicKey, Kind kind, string objectKey, ReadOnlySpan<byte> plaintext, EnvelopeTestInputs? inputs) =>
        EncryptCore(recipientPublicKey, kind, objectKey, plaintext, inputs, SystemRandomSource.Instance);

    private static byte[] EncryptCore(byte[] recipientPublicKey, Kind kind, string objectKey, ReadOnlySpan<byte> plaintext,
        EnvelopeTestInputs? inputs, IRandomSource random)
    {
        if (recipientPublicKey.Length != X25519.KeyLen) throw new ArgumentException("recipient public key must be 32 bytes", nameof(recipientPublicKey));
        var ephSk = inputs?.EphemeralSecretKey ?? random.Bytes(X25519.KeyLen);
        var cek = inputs?.ContentKey ?? random.Bytes(AesGcm256.KeyLen);
        var wrapNonce = inputs?.WrapNonce ?? random.Bytes(AesGcm256.NonceLen);
        var bodyNonce = inputs?.BodyNonce ?? random.Bytes(AesGcm256.NonceLen);
        try
        {
            var epk = X25519.PublicKeyFromSecret(ephSk);
            var kek = DeriveKek(ephSk, recipientPublicKey, epk, recipientPublicKey);
            var wrapped = AesGcm256.Encrypt(kek, wrapNonce, cek, WrapAad(objectKey, kind, epk));
            CryptographicOperations.ZeroMemory(kek);

            var output = new byte[BodyOffset + plaintext.Length + AesGcm256.TagLen];
            Magic.CopyTo(output, 0);
            output[4] = Version;
            output[5] = ModeSingle;
            output[6] = kind.Id();
            output[7] = 0x00;
            epk.CopyTo(output, 8);
            wrapNonce.CopyTo(output, 40);
            wrapped.CopyTo(output, 52);
            bodyNonce.CopyTo(output, 100);
            var body = AesGcm256.Encrypt(cek, bodyNonce, plaintext, BodyAad(objectKey, kind, epk));
            body.CopyTo(output, BodyOffset);
            return output;
        }
        finally
        {
            if (inputs?.ContentKey is null) CryptographicOperations.ZeroMemory(cek);
            if (inputs?.EphemeralSecretKey is null) CryptographicOperations.ZeroMemory(ephSk);
        }
    }

    /// <summary>Read the declared kind from a single-shot header without decrypting.</summary>
    public static Kind PeekKind(ReadOnlySpan<byte> envelope)
    {
        CheckHeader(envelope);
        return Kinds.FromId(envelope[6]);
    }

    private static void CheckHeader(ReadOnlySpan<byte> envelope)
    {
        if (envelope.Length < MinLength) throw new IvyCryptoException("envelope too short");
        if (!Bytes.FixedTimeEquals(envelope[..4], Magic)) throw new IvyCryptoException("bad magic");
        if (envelope[4] != Version) throw new IvyCryptoException($"unsupported version {envelope[4]}");
        if (envelope[5] != ModeSingle) throw new IvyCryptoException($"not a single-shot envelope (mode {envelope[5]})");
        // The reserved byte is not covered by any AAD, so a strict reader rejects anything but 0x00.
        if (envelope[7] != 0x00) throw new IvyCryptoException("reserved header byte must be 0x00");
    }

    /// <summary>Decrypt a single-shot envelope. Throws <see cref="IvyCryptoException"/> on tamper, wrong recipient, wrong key or kind.</summary>
    public static DecryptedEnvelope Decrypt(ReadOnlySpan<byte> recipientSecretKey, string objectKey, ReadOnlySpan<byte> envelope, Kind? expectedKind = null)
    {
        CheckHeader(envelope);
        var kind = Kinds.FromId(envelope[6]);
        if (expectedKind is { } ek && kind != ek)
            throw new IvyCryptoException($"kind mismatch: header says {kind.WireName()}, expected {ek.WireName()}");

        var epk = envelope.Slice(8, EpkLen).ToArray();
        var wrapNonce = envelope.Slice(40, AesGcm256.NonceLen);
        var wrapped = envelope.Slice(52, WrappedCekLen);
        var bodyNonce = envelope.Slice(100, AesGcm256.NonceLen);
        var body = envelope[BodyOffset..];

        var sk = recipientSecretKey.ToArray();
        try
        {
            var recipientPub = X25519.PublicKeyFromSecret(sk);
            var kek = DeriveKek(sk, epk, epk, recipientPub);
            byte[] cek;
            try { cek = AesGcm256.Decrypt(kek, wrapNonce, wrapped, WrapAad(objectKey, kind, epk)); }
            finally { CryptographicOperations.ZeroMemory(kek); }
            try { return new DecryptedEnvelope(kind, AesGcm256.Decrypt(cek, bodyNonce, body, BodyAad(objectKey, kind, epk))); }
            finally { CryptographicOperations.ZeroMemory(cek); }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(sk);
        }
    }
}
