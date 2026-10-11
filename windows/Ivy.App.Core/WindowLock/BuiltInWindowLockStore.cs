namespace Ivy.App.Core.WindowLock;

/// <summary>
/// The owner's window-lock passphrase check record: the JSON from <see cref="PassphraseHash.Create"/> (a salted
/// PBKDF2-SHA256 hash), never the passphrase itself. It is compiled into the app so it survives a Windows reinstall.
/// An empty string means no passphrase is built in yet, in which case the unlock gesture opens nothing.
/// </summary>
public static class WindowLockRecord
{
    public const string Json = @"{""v"":1,""kdf"":""pbkdf2-sha256"",""iterations"":600000,""salt"":""jmVhJjA9glyhIKcBhWSN3w=="",""hash"":""uD7T7AM3ju\u002BaYdQXwRsBbi5Jnpeab3/hokbG\u002B6md6DA=""}";
}

/// <summary>Serves <see cref="WindowLockRecord.Json"/> as the window-lock record. Read-only: the passphrase is built into the app.</summary>
public sealed class BuiltInWindowLockStore : IWindowLockStore
{
    public byte[]? Load() =>
        string.IsNullOrWhiteSpace(WindowLockRecord.Json) ? null : System.Text.Encoding.UTF8.GetBytes(WindowLockRecord.Json);

    public void Save(byte[] record) =>
        throw new NotSupportedException("the window lock passphrase is built into the app");
}
