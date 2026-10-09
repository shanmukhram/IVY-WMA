using System.Security.Cryptography;

namespace Ivy.Core.Protocol;

/// <summary>
/// All protocol randomness (device keys, ephemeral keys, content keys, nonces, oids) flows
/// through this interface. Production uses <see cref="SystemRandomSource"/>; tests may inject a
/// deterministic source.
/// </summary>
public interface IRandomSource
{
    void Fill(Span<byte> buffer);
}

public sealed class SystemRandomSource : IRandomSource
{
    public static readonly SystemRandomSource Instance = new();
    public void Fill(Span<byte> buffer) => RandomNumberGenerator.Fill(buffer);
}

public static class RandomSourceExtensions
{
    public static byte[] Bytes(this IRandomSource r, int n)
    {
        var b = new byte[n];
        r.Fill(b);
        return b;
    }
}
