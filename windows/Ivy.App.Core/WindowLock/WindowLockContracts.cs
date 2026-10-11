namespace Ivy.App.Core.WindowLock;

/// <summary>
/// Where the window lock keeps its passphrase record (PRD Part 1 "App UI", window privacy lock). The record is the
/// JSON produced by <see cref="PassphraseHash"/>: a salted PBKDF2 hash, never the passphrase. The Windows
/// implementation wraps these bytes in DPAPI before writing them to disk; this layer only sees the JSON bytes.
/// </summary>
public interface IWindowLockStore
{
    /// <summary>The stored record, or null when none has been saved.</summary>
    byte[]? Load();

    /// <summary>Replace the stored record.</summary>
    void Save(byte[] record);
}

/// <summary>
/// Marker for the neutral screen the shell shows while the window is locked. Kept as its own type so a later phase
/// can put a useful utility page there without touching the lock or unlock logic.
/// </summary>
public interface ICoverSurface { }

/// <summary>The quiet unlock gesture: the owner presses the single sidebar entry this many times.</summary>
public static class UnlockGesture
{
    /// <summary>The press that opens the passphrase prompt.</summary>
    public const int PressCount = 20;

    /// <summary>From this press until <see cref="PressCount"/>, a small hint is shown so the owner knows it is working.</summary>
    public const int HintFromPress = 18;
}

/// <summary>Which passphrase prompt the shell should show.</summary>
public enum LockPrompt
{
    None,
    /// <summary>No passphrase stored yet: ask the owner to choose one (entered twice).</summary>
    SetPassphrase,
    /// <summary>A passphrase is stored: ask for it.</summary>
    EnterPassphrase,
}

/// <summary>Keeps the passphrase record in memory only (the default when no store is given, and in tests).</summary>
public sealed class InMemoryWindowLockStore : IWindowLockStore
{
    private readonly object _gate = new();
    private byte[]? _record;

    public byte[]? Load()
    {
        lock (_gate) return _record is null ? null : (byte[])_record.Clone();
    }

    public void Save(byte[] record)
    {
        ArgumentNullException.ThrowIfNull(record);
        lock (_gate) _record = (byte[])record.Clone();
    }
}
