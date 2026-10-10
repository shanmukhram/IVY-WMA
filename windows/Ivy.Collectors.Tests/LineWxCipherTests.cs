using System.Text;
using Ivy.Collectors.Line;
using Ivy.Collectors.Tests.Support;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Ivy.Collectors.Tests;

public class LineWxCipherTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    // The LINE passphrase is a 32-character hex string (used as the password text).
    private static readonly byte[] Passphrase = Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");

    private string MakePlainDb(int rows)
    {
        var path = Path.Combine(_dir.Path, "plain.db");
        using var c = new SqliteConnection($"Data Source={path}");
        c.Open();
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "CREATE TABLE _contact (_mid TEXT PRIMARY KEY, _displayName TEXT);" +
                              "CREATE TABLE _chats (_id INTEGER PRIMARY KEY, _from TEXT, _to TEXT, _content TEXT, _createdTime INTEGER);";
            cmd.ExecuteNonQuery();
        }
        using (var tx = c.BeginTransaction())
        {
            for (var i = 0; i < rows; i++)
            {
                using var cmd = c.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = "INSERT INTO _chats (_from, _to, _content, _createdTime) VALUES ($f,$t,$c,$ts)";
                cmd.Parameters.AddWithValue("$f", "uMID_" + i);
                cmd.Parameters.AddWithValue("$t", "me");
                cmd.Parameters.AddWithValue("$c", $"message number {i} with some text to fill pages");
                cmd.Parameters.AddWithValue("$ts", 1_700_000_000_000L + i);
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
        SqliteConnection.ClearAllPools();
        return path;
    }

    [Fact]
    public void Round_trips_a_real_sqlite_db_through_the_wx_scheme()
    {
        var plainPath = MakePlainDb(rows: 500); // enough to span several pages
        var plain = File.ReadAllBytes(plainPath);
        var pageSize = (plain[16] << 8) | (plain[17] << 16);
        Assert.True(pageSize is >= 512 and <= 65536);

        var key = LineWxCipher.DeriveKey(Passphrase);
        var encrypted = LineWxCipher.Encrypt(plain, key, pageSize);

        // Encrypted page 1 is not plain SQLite, but bytes 16..23 stay in the clear (the identification signature).
        Assert.False(encrypted.AsSpan(0, 16).SequenceEqual(Encoding.ASCII.GetBytes("SQLite format 3\0")));
        Assert.True(encrypted.AsSpan(16, 8).SequenceEqual(plain.AsSpan(16, 8)));

        var decrypted = LineWxCipher.Decrypt(encrypted, key);
        Assert.NotNull(decrypted);

        // The decrypted bytes are a valid SQLite db we can open and read the LINE tables from.
        var outPath = Path.Combine(_dir.Path, "decrypted.db");
        File.WriteAllBytes(outPath, decrypted!);
        using var c = new SqliteConnection($"Data Source={outPath};Mode=ReadOnly");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM _chats";
        Assert.Equal(500L, (long)cmd.ExecuteScalar()!);
        cmd.CommandText = "SELECT _content FROM _chats WHERE _from = 'uMID_42'";
        Assert.Equal("message number 42 with some text to fill pages", (string)cmd.ExecuteScalar()!);
    }

    [Fact]
    public void A_wrong_passphrase_yields_null()
    {
        var plain = File.ReadAllBytes(MakePlainDb(rows: 50));
        var pageSize = (plain[16] << 8) | (plain[17] << 16);
        var encrypted = LineWxCipher.Encrypt(plain, LineWxCipher.DeriveKey(Passphrase), pageSize);

        var wrongKey = LineWxCipher.DeriveKey(Encoding.ASCII.GetBytes("ffffffffffffffffffffffffffffffff"));
        Assert.Null(LineWxCipher.Decrypt(encrypted, wrongKey));
    }

    [Fact]
    public void Derive_key_is_deterministic_and_passphrase_sensitive()
    {
        Assert.Equal(LineWxCipher.DeriveKey(Passphrase), LineWxCipher.DeriveKey(Passphrase));
        Assert.NotEqual(
            Convert.ToHexString(LineWxCipher.DeriveKey(Passphrase)),
            Convert.ToHexString(LineWxCipher.DeriveKey(Encoding.ASCII.GetBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))));
    }
}
