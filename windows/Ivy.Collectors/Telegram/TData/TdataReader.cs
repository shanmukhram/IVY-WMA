using System.Security.Cryptography;

namespace Ivy.Collectors.Telegram.TData;

/// <summary>
/// Reads a Telegram Desktop <c>tdata</c> folder and recovers the logged-in accounts' MTProto auth keys,
/// without ever touching Telegram's servers or asking the user to log in (WT1, WX2).
///
/// Flow (tdesktop <c>Storage::Account::start</c>): read <c>key_datas</c> (salt, the local key encrypted under
/// the passcode, and the account map encrypted under the local key); derive the passcode key with
/// <see cref="TdataCrypto.CreateLocalKey"/>; decrypt the local key; then for each account read its data file
/// and pull the <c>dbiMtpAuthorization</c> block (main DC id, user id, per-DC auth keys).
///
/// Everything returned is secret key material. Callers keep it in memory (or DPAPI) and never let it reach
/// the sink or the queue directory (verified by a test that scans the queue for key bytes).
/// </summary>
public static class TdataReader
{
    /// <summary>tdesktop local-settings block id for the MTProto authorization blob.</summary>
    internal const uint DbiMtpAuthorization = 0x4B;

    /// <summary>What <see cref="ReadAccounts"/> could not do, so the collector can show an honest status.</summary>
    public enum Failure { None, NotFound, NeedsPasscode, Invalid }

    public sealed record Result(TdataAccounts? Accounts, Failure Failure, string? Detail)
    {
        public bool Ok => Accounts is not null && Failure == Failure.None;
    }

    public static Result ReadAccounts(string? tdataDir, ReadOnlySpan<byte> passcode)
    {
        if (string.IsNullOrEmpty(tdataDir) || !Directory.Exists(tdataDir))
            return new Result(null, Failure.NotFound, "tdata folder not found");
        var keyFile = Path.Combine(tdataDir, TdataLayout.KeyFileName);
        if (!File.Exists(keyFile))
            return new Result(null, Failure.NotFound, $"{TdataLayout.KeyFileName} not found in tdata");

        byte[] localKey;
        int[] indices;
        int activeIndex;
        try
        {
            var payload = TdfFile.Read(File.ReadAllBytes(keyFile)).Payload;
            var r = new TdeReader(payload);
            var salt = r.ReadByteArray();
            var keyEncrypted = r.ReadByteArray();
            var passcodeKey = TdataCrypto.CreateLocalKey(passcode, salt);
            try { localKey = TdataCrypto.DecryptLocal(keyEncrypted, passcodeKey); }
            finally { CryptographicOperations.ZeroMemory(passcodeKey); }

            // The account map is optional (older single-account layouts omit it).
            if (r.Remaining >= 4)
            {
                var infoEncrypted = r.ReadByteArray();
                var info = TdataCrypto.DecryptLocal(infoEncrypted, localKey);
                try
                {
                    var ir = new TdeReader(info);
                    var count = ir.ReadInt32();
                    if (count < 0 || count > 1024) throw new TdataFormatException($"implausible account count {count}");
                    indices = new int[count];
                    for (var i = 0; i < count; i++) indices[i] = ir.ReadInt32();
                    activeIndex = ir.Remaining >= 4 ? ir.ReadInt32() : (count > 0 ? indices[0] : 0);
                }
                finally { CryptographicOperations.ZeroMemory(info); }
            }
            else
            {
                indices = new[] { 0 };
                activeIndex = 0;
            }
        }
        catch (TdataBadKeyException e)
        {
            return new Result(null, Failure.NeedsPasscode, e.Message);
        }
        catch (TdataFormatException e)
        {
            return new Result(null, Failure.Invalid, e.Message);
        }

        try
        {
            var accounts = new List<TelegramAccount>();
            foreach (var index in indices)
            {
                var account = ReadAccount(tdataDir, index, localKey);
                if (account is not null) accounts.Add(account);
            }
            if (accounts.Count == 0)
                return new Result(null, Failure.Invalid, "no usable accounts in tdata (no MTProto authorization found)");
            return new Result(new TdataAccounts { Accounts = accounts, ActiveIndex = activeIndex }, Failure.None, null);
        }
        catch (TdataFormatException e)
        {
            return new Result(null, Failure.Invalid, e.Message);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(localKey);
        }
    }

    private static TelegramAccount? ReadAccount(string tdataDir, int index, byte[] localKey)
    {
        var dataFile = TdataLayout.AccountDataFile(tdataDir, index);
        if (!File.Exists(dataFile)) return null;
        var payload = TdfFile.Read(File.ReadAllBytes(dataFile)).Payload;
        var descriptor = TdataCrypto.DecryptLocal(payload, localKey);
        try
        {
            var r = new TdeReader(descriptor);
            while (r.Remaining >= 4)
            {
                var blockId = r.ReadUInt32();
                if (blockId == DbiMtpAuthorization)
                {
                    var serialized = r.ReadByteArray();
                    return ParseMtpAuthorization(serialized, index);
                }
                // Unknown block: we cannot know its length, so stop scanning here.
                break;
            }
            return null;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(descriptor);
        }
    }

    /// <summary>
    /// Parse the MTProto authorization blob: <c>i32 mainDcId, i64 userId, i32 keyCount, [i32 dcId, raw256]*</c>.
    /// This is the shape <see cref="TdataWriter"/> (tests) produces; the real tdesktop serialization must be
    /// mapped onto this on the PC (README).
    /// </summary>
    private static TelegramAccount ParseMtpAuthorization(byte[] serialized, int index)
    {
        var r = new TdeReader(serialized);
        var mainDcId = r.ReadInt32();
        var userId = r.ReadInt64();
        var keyCount = r.ReadInt32();
        if (keyCount < 0 || keyCount > 64) throw new TdataFormatException($"implausible auth key count {keyCount}");
        var keys = new Dictionary<int, byte[]>(keyCount);
        for (var i = 0; i < keyCount; i++)
        {
            var dcId = r.ReadInt32();
            var key = r.ReadRaw(TdataCrypto.AuthKeySize);
            keys[dcId] = key;
        }
        if (!keys.ContainsKey(mainDcId)) throw new TdataFormatException($"no auth key for main dc {mainDcId}");
        return new TelegramAccount { UserId = userId, MainDcId = mainDcId, AuthKeys = keys, Index = index };
    }
}
