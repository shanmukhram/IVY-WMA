using System.Security.Cryptography;

namespace Ivy.Core.Protocol;

/// <summary>AES-256-GCM with 12-byte nonce and the 16-byte tag appended (<c>ciphertext || tag</c>).</summary>
public static class AesGcm256
{
    public const int KeyLen = 32;
    public const int NonceLen = 12;
    public const int TagLen = 16;

    public static byte[] Encrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> plaintext, ReadOnlySpan<byte> aad)
    {
        if (key.Length != KeyLen) throw new ArgumentException("AES-256-GCM key must be 32 bytes", nameof(key));
        if (nonce.Length != NonceLen) throw new ArgumentException("GCM nonce must be 12 bytes", nameof(nonce));
        var output = new byte[plaintext.Length + TagLen];
        using var gcm = new AesGcm(key, TagLen);
        gcm.Encrypt(nonce, plaintext, output.AsSpan(0, plaintext.Length), output.AsSpan(plaintext.Length, TagLen), aad);
        return output;
    }

    /// <summary>Decrypt <c>ciphertext || tag</c>. Throws <see cref="IvyCryptoException"/> on any authentication failure.</summary>
    public static byte[] Decrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> ciphertextAndTag, ReadOnlySpan<byte> aad)
    {
        if (key.Length != KeyLen) throw new ArgumentException("AES-256-GCM key must be 32 bytes", nameof(key));
        if (nonce.Length != NonceLen) throw new ArgumentException("GCM nonce must be 12 bytes", nameof(nonce));
        if (ciphertextAndTag.Length < TagLen) throw new IvyCryptoException("ciphertext too short");
        var ctLen = ciphertextAndTag.Length - TagLen;
        var output = new byte[ctLen];
        try
        {
            using var gcm = new AesGcm(key, TagLen);
            gcm.Decrypt(nonce, ciphertextAndTag[..ctLen], ciphertextAndTag[ctLen..], output, aad);
        }
        catch (CryptographicException e)
        {
            CryptographicOperations.ZeroMemory(output);
            throw new IvyCryptoException("authentication failed", e);
        }
        return output;
    }
}

/// <summary>Raised for any envelope / chunk / bootstrap verification or authentication failure.</summary>
public sealed class IvyCryptoException : Exception
{
    public IvyCryptoException(string message) : base(message) { }
    public IvyCryptoException(string message, Exception inner) : base(message, inner) { }
}
