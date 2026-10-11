namespace Ivy.App.Core.WindowLock;

/// <summary>
/// One-time provisioning of the window lock passphrase. The owner chooses the passphrase and the shell's command-line
/// switch calls <see cref="StorePassphrase"/>; the window itself never asks to set one. Only the salted hash from
/// <see cref="PassphraseHash"/> is stored. Nothing here logs.
/// </summary>
public static class WindowLockSetup
{
    /// <summary>
    /// Hash <paramref name="passphrase"/> and save it, replacing any existing record. Throws
    /// <see cref="ArgumentException"/> when the passphrase is null, empty or whitespace.
    /// </summary>
    public static void StorePassphrase(IWindowLockStore store, string passphrase)
    {
        ArgumentNullException.ThrowIfNull(store);
        if (string.IsNullOrWhiteSpace(passphrase))
            throw new ArgumentException("The passphrase must not be empty or whitespace.", nameof(passphrase));
        store.Save(PassphraseHash.Create(passphrase));
    }

    /// <summary>True when the store holds a usable passphrase record.</summary>
    public static bool HasPassphrase(IWindowLockStore store)
    {
        ArgumentNullException.ThrowIfNull(store);
        return PassphraseHash.IsValid(store.Load());
    }
}
