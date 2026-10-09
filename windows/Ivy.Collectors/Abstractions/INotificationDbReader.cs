namespace Ivy.Collectors.Abstractions;

/// <summary>One row of <c>Notification</c> joined to <c>NotificationHandler.PrimaryId</c>.</summary>
public sealed record RawNotification(long Id, string? HandlerPrimaryId, string? Type, string? PayloadXml, long ArrivalTimeFileTime);

/// <summary>Reads the Windows notification database (<c>wpndatabase.db</c>).</summary>
public interface INotificationDbReader
{
    /// <summary>The database this reader opens (for status messages).</summary>
    string DatabasePath { get; }

    /// <summary>
    /// Notifications with <c>Id &gt; afterId</c>, ascending, at most <paramref name="limit"/>. Throws
    /// <see cref="NotificationDbUnavailableException"/> when the database cannot be read.
    /// </summary>
    IReadOnlyList<RawNotification> ReadAfter(long afterId, int limit);
}

public sealed class NotificationDbUnavailableException : Exception
{
    public NotificationDbUnavailableException(string message, Exception? inner = null) : base(message, inner) { }
}
