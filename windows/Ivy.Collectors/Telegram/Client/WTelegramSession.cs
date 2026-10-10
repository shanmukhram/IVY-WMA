using System.Security.Cryptography;
using System.Text.Json;

namespace Ivy.Collectors.Telegram.Client;

/// <summary>
/// Builds a <b>WTelegramClient</b> session blob from a raw MTProto auth key recovered from <c>tdata</c>, so the
/// collector connects as the existing Telegram Desktop session with no login (WT1). WTelegramClient's
/// <c>Client(configProvider, startSession, saveSession)</c> constructor takes the session as a byte array in its
/// own on-disk format: AES-256-CBC over <c>sha256(json) ‖ json</c>, prefixed by the 16-byte IV, keyed by the
/// 32-byte <c>session_key</c>. We generate a random <c>session_key</c> per process and hand WTelegramClient a
/// session it will accept, pre-populated with the account's user id, main DC and per-DC auth key(s), plus a
/// seed address for the main DC (the server replaces the DC table on the first <c>help.getConfig</c>).
///
/// The JSON shape mirrors WTelegramClient's internal <c>Session</c>/<c>DCSession</c>/<c>DcOption</c> field names
/// and its serializer options (public fields, PascalCase, defaults omitted). The auth-key bytes appear only
/// inside the AES-encrypted blob — never in plaintext in the produced buffer (asserted by a unit test).
/// </summary>
public static class WTelegramSession
{
    public const int AuthKeySize = 256;
    private const int SessionKeySize = 32; // AES-256

    /// <summary>A built session: the encrypted bytes to hand WTelegramClient, and the per-process AES key for them.</summary>
    public sealed record Built(byte[] SessionBytes, byte[] SessionKey);

    /// <summary>
    /// Build the encrypted session for <paramref name="session"/>. <paramref name="apiId"/> is persisted into the
    /// session so WTelegramClient's <c>InitConnection</c> presents it (it must be Telegram Desktop's own id).
    /// </summary>
    public static Built Build(TelegramSession session, int apiId)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (!session.AuthKeys.TryGetValue(session.MainDcId, out var mainKey) || mainKey.Length != AuthKeySize)
            throw new ArgumentException($"no {AuthKeySize}-byte auth key for main dc {session.MainDcId}", nameof(session));

        var json = SerializeSession(session, apiId);
        var sessionKey = RandomNumberGenerator.GetBytes(SessionKeySize);
        var sessionBytes = Encrypt(json, sessionKey);
        CryptographicOperations.ZeroMemory(json);
        return new Built(sessionBytes, sessionKey);
    }

    /// <summary>The session as WTelegramClient's JSON (UTF-8). Kept separate so a test can decrypt and inspect it.</summary>
    internal static byte[] SerializeSession(TelegramSession session, int apiId)
    {
        var (ip, port) = TelegramDcEndpoints.ForDc(session.MainDcId);
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteNumber("ApiId", apiId);
            w.WriteNumber("UserId", session.UserId);
            w.WriteNumber("MainDC", session.MainDcId);

            w.WriteStartObject("DCSessions");
            foreach (var (dcId, key) in session.AuthKeys)
            {
                if (key.Length != AuthKeySize) continue;
                w.WriteStartObject(dcId.ToString(System.Globalization.CultureInfo.InvariantCulture));
                w.WriteBase64String("AuthKey", key);
                w.WriteNumber("UserId", session.UserId);
                var (dip, dport) = TelegramDcEndpoints.ForDc(dcId);
                w.WriteStartObject("DataCenter");
                w.WriteNumber("id", dcId);
                w.WriteString("ip_address", dcId == session.MainDcId ? ip : dip);
                w.WriteNumber("port", dcId == session.MainDcId ? port : dport);
                w.WriteEndObject();
                w.WriteEndObject();
            }
            w.WriteEndObject();
            w.WriteEndObject();
        }
        return ms.ToArray();
    }

    private static byte[] Encrypt(byte[] utf8Json, byte[] sessionKey)
    {
        byte[] sha = SHA256.HashData(utf8Json);
        var plain = new byte[sha.Length + utf8Json.Length];
        Buffer.BlockCopy(sha, 0, plain, 0, sha.Length);
        Buffer.BlockCopy(utf8Json, 0, plain, sha.Length, utf8Json.Length);

        using var aes = Aes.Create();
        aes.Key = sessionKey;
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        var iv = RandomNumberGenerator.GetBytes(16);
        using var enc = aes.CreateEncryptor(sessionKey, iv);
        var cipher = enc.TransformFinalBlock(plain, 0, plain.Length);
        CryptographicOperations.ZeroMemory(plain);

        var outBuf = new byte[16 + cipher.Length];
        Buffer.BlockCopy(iv, 0, outBuf, 0, 16);
        Buffer.BlockCopy(cipher, 0, outBuf, 16, cipher.Length);
        return outBuf;
    }

    /// <summary>Decrypt a session blob back to its JSON (used only by tests to confirm the round trip).</summary>
    internal static byte[] DecryptForTest(byte[] sessionBytes, byte[] sessionKey)
    {
        using var aes = Aes.Create();
        aes.Key = sessionKey;
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        using var dec = aes.CreateDecryptor(sessionKey, sessionBytes[..16]);
        var plain = dec.TransformFinalBlock(sessionBytes, 16, sessionBytes.Length - 16);
        // strip the 32-byte sha256 prefix
        return plain[32..];
    }
}
