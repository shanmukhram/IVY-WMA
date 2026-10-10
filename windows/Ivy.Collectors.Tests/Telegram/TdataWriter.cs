using System.Security.Cryptography;
using Ivy.Collectors.Telegram.TData;

namespace Ivy.Collectors.Tests.Telegram;

/// <summary>
/// TEST-ONLY writer that produces a faithful Telegram Desktop <c>tdata</c> tree for a known passcode and known
/// auth keys, so <see cref="TdataReader"/> can be verified byte-for-byte without a real Telegram install. It
/// builds the files from the low-level primitives (<see cref="TdeWriter"/>, <see cref="TdataCrypto.EncryptLocal"/>,
/// <see cref="TdfFile.Write"/>) independently of the reader's parsing logic. It uses the same structural layout
/// the reader expects; the exact tdesktop byte layout for a live install is confirmed separately on the PC.
/// </summary>
internal static class TdataWriter
{
    public sealed record AccountSpec(int Index, long UserId, int MainDcId, IReadOnlyDictionary<int, byte[]> AuthKeys);

    public static void Write(string tdataDir, ReadOnlySpan<byte> passcode, int activeIndex, params AccountSpec[] accounts)
    {
        Directory.CreateDirectory(tdataDir);
        var localKey = RandomNumberGenerator.GetBytes(TdataCrypto.LocalKeySize);
        var salt = RandomNumberGenerator.GetBytes(TdataCrypto.SaltSize);

        // key_datas: salt, localKey encrypted under the passcode key, and the account map under the local key.
        var passcodeKey = TdataCrypto.CreateLocalKey(passcode, salt);
        var keyEncrypted = TdataCrypto.EncryptLocal(localKey, passcodeKey);

        var info = new TdeWriter();
        info.WriteInt32(accounts.Length);
        foreach (var a in accounts) info.WriteInt32(a.Index);
        info.WriteInt32(activeIndex);
        var infoEncrypted = TdataCrypto.EncryptLocal(info.ToArray(), localKey);

        var key = new TdeWriter();
        key.WriteByteArray(salt);
        key.WriteByteArray(keyEncrypted);
        key.WriteByteArray(infoEncrypted);
        File.WriteAllBytes(Path.Combine(tdataDir, TdataLayout.KeyFileName), TdfFile.Write(1, key.ToArray()));

        foreach (var a in accounts)
        {
            // The MTProto authorization blob: mainDcId, userId, then each (dcId, 256-byte key).
            var mtp = new TdeWriter();
            mtp.WriteInt32(a.MainDcId);
            mtp.WriteInt64(a.UserId);
            mtp.WriteInt32(a.AuthKeys.Count);
            foreach (var (dcId, k) in a.AuthKeys)
            {
                if (k.Length != TdataCrypto.AuthKeySize) throw new ArgumentException("auth key must be 256 bytes");
                mtp.WriteInt32(dcId);
                mtp.WriteRaw(k);
            }

            var descriptor = new TdeWriter();
            descriptor.WriteUInt32(TdataReader.DbiMtpAuthorization);
            descriptor.WriteByteArray(mtp.ToArray());

            var file = TdfFile.Write(1, TdataCrypto.EncryptLocal(descriptor.ToArray(), localKey));
            var path = TdataLayout.AccountDataFile(tdataDir, a.Index);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path, file);
        }

        CryptographicOperations.ZeroMemory(localKey);
        CryptographicOperations.ZeroMemory(passcodeKey);
    }

    public static byte[] RandomAuthKey() => RandomNumberGenerator.GetBytes(TdataCrypto.AuthKeySize);
}
