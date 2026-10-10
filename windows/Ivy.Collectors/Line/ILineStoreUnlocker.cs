using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Line;

/// <summary>The outcome of trying to open an encrypted LINE store.</summary>
public sealed class LineUnlockResult
{
    private LineUnlockResult(SqliteConnection? connection, string? reason)
    {
        Connection = connection;
        Reason = reason;
    }

    /// <summary>An opened, decrypted, read-only connection when <see cref="Ok"/>; otherwise null.</summary>
    public SqliteConnection? Connection { get; }

    /// <summary>The honest reason it could not be opened when not <see cref="Ok"/> (shown red); otherwise null.</summary>
    public string? Reason { get; }

    public bool Ok => Connection is not null;

    public static LineUnlockResult Opened(SqliteConnection connection) => new(connection, null);
    public static LineUnlockResult Failed(string reason) => new(null, reason);
}

/// <summary>
/// Opens an encrypted LINE store (PRD WL1 "key derivation strategy"). This is a slot, deliberately empty by
/// default: we do not guess key derivation. Until we have a real probe report and implement derivation for a
/// specific LINE version (keeping any key in memory/DPAPI on the PC, never uploaded — WX2), the default
/// <see cref="NotImplementedUnlocker"/> reports red rather than inventing data (WL3).
/// </summary>
public interface ILineStoreUnlocker
{
    /// <summary>
    /// Try to open the plain-SQLite view of the (encrypted) db file at <paramref name="dbPath"/> for the
    /// given <paramref name="map"/>. Return <see cref="LineUnlockResult.Opened"/> with a read-only
    /// connection, or <see cref="LineUnlockResult.Failed"/> with a human reason.
    /// </summary>
    LineUnlockResult TryOpen(string dbPath, LineStoreMap map);
}

/// <summary>
/// The default unlocker: not implemented for any version. It never guesses a key; it reports the honest red
/// state so the first real PC run yields either plain-SQLite data or this reason plus the probe report we
/// need to implement real derivation.
/// </summary>
public sealed class NotImplementedUnlocker : ILineStoreUnlocker
{
    public static readonly NotImplementedUnlocker Instance = new();

    public LineUnlockResult TryOpen(string dbPath, LineStoreMap map) =>
        LineUnlockResult.Failed(
            $"store is encrypted ({map.KeyStrategy}); key derivation for LINE version {map.Version} is not implemented. " +
            "Run the probe on the PC and send the report so the unlocker can be written.");
}
