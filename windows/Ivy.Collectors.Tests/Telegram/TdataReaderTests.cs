using System.Security.Cryptography;
using System.Text;
using Ivy.Collectors.Telegram.TData;
using Ivy.Collectors.Tests.Support;

namespace Ivy.Collectors.Tests.Telegram;

/// <summary>
/// The tdata reader recovers the logged-in accounts' MTProto auth keys from a generated fixture, byte-for-byte,
/// and reports honest failures for a missing folder, a wrong passcode, and corruption (WT1/WX2).
/// </summary>
public class TdataReaderTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    private string Tdata => _dir.Sub("tdata");

    [Fact]
    public void Round_trips_a_single_account_with_an_empty_passcode()
    {
        var key = TdataWriter.RandomAuthKey();
        TdataWriter.Write(Tdata, ReadOnlySpan<byte>.Empty, activeIndex: 0,
            new TdataWriter.AccountSpec(0, UserId: 4242, MainDcId: 2, new Dictionary<int, byte[]> { [2] = key }));

        var result = TdataReader.ReadAccounts(Tdata, ReadOnlySpan<byte>.Empty);

        Assert.True(result.Ok, result.Detail);
        var account = result.Accounts!.Active;
        Assert.Equal(4242, account.UserId);
        Assert.Equal(2, account.MainDcId);
        Assert.Equal(key, account.MainAuthKey);          // byte-for-byte
        Assert.Equal(256, account.MainAuthKey.Length);
    }

    [Fact]
    public void Round_trips_multiple_accounts_and_honours_the_active_index()
    {
        var k0 = TdataWriter.RandomAuthKey();
        var k1a = TdataWriter.RandomAuthKey();
        var k1b = TdataWriter.RandomAuthKey();
        TdataWriter.Write(Tdata, ReadOnlySpan<byte>.Empty, activeIndex: 1,
            new TdataWriter.AccountSpec(0, 100, 1, new Dictionary<int, byte[]> { [1] = k0 }),
            new TdataWriter.AccountSpec(1, 200, 4, new Dictionary<int, byte[]> { [4] = k1a, [2] = k1b }));

        var result = TdataReader.ReadAccounts(Tdata, ReadOnlySpan<byte>.Empty);

        Assert.True(result.Ok, result.Detail);
        Assert.Equal(2, result.Accounts!.Accounts.Count);
        var active = result.Accounts.Active;
        Assert.Equal(200, active.UserId);
        Assert.Equal(4, active.MainDcId);
        Assert.Equal(k1a, active.MainAuthKey);
        Assert.Equal(k1b, active.AuthKeys[2]);           // secondary DC key preserved
        var first = result.Accounts.Accounts.Single(a => a.Index == 0);
        Assert.Equal(k0, first.MainAuthKey);
    }

    [Fact]
    public void Round_trips_a_passcode_protected_session()
    {
        var pass = Encoding.UTF8.GetBytes("s3cr3t");
        var key = TdataWriter.RandomAuthKey();
        TdataWriter.Write(Tdata, pass, activeIndex: 0,
            new TdataWriter.AccountSpec(0, 7, 5, new Dictionary<int, byte[]> { [5] = key }));

        Assert.True(TdataReader.ReadAccounts(Tdata, pass).Ok);
        Assert.Equal(key, TdataReader.ReadAccounts(Tdata, pass).Accounts!.Active.MainAuthKey);
    }

    [Fact]
    public void Wrong_passcode_reports_needs_passcode_and_no_accounts()
    {
        TdataWriter.Write(Tdata, Encoding.UTF8.GetBytes("right"), activeIndex: 0,
            new TdataWriter.AccountSpec(0, 7, 5, new Dictionary<int, byte[]> { [5] = TdataWriter.RandomAuthKey() }));

        var result = TdataReader.ReadAccounts(Tdata, Encoding.UTF8.GetBytes("wrong"));

        Assert.False(result.Ok);
        Assert.Equal(TdataReader.Failure.NeedsPasscode, result.Failure);
        Assert.Null(result.Accounts);
    }

    [Fact]
    public void Missing_folder_and_missing_key_file_report_not_found()
    {
        Assert.Equal(TdataReader.Failure.NotFound, TdataReader.ReadAccounts(_dir.Sub("nope"), default).Failure);
        Directory.CreateDirectory(Tdata);
        Assert.Equal(TdataReader.Failure.NotFound, TdataReader.ReadAccounts(Tdata, default).Failure);
    }

    [Fact]
    public void Corrupt_key_file_reports_invalid()
    {
        Directory.CreateDirectory(Tdata);
        File.WriteAllBytes(Path.Combine(Tdata, TdataLayout.KeyFileName), RandomNumberGenerator.GetBytes(256));

        Assert.Equal(TdataReader.Failure.Invalid, TdataReader.ReadAccounts(Tdata, default).Failure);
    }
}
