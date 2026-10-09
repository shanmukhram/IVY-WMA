using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Collectors.Common;

/// <summary>
/// Shared services for every collector. <see cref="Sink"/> returns null until the device is paired
/// (<c>VaultAgent.Sink</c>); collectors skip capture while it is null and show <c>WaitingForPairing</c>.
/// </summary>
public sealed class CollectorContext
{
    public CollectorContext(VaultDb db, Func<IRecordSink?> sink, ActivityLog? activity = null, CollectorStateStore? states = null,
        UploadQueue? queue = null, TimeProvider? time = null, ILoggerFactory? loggers = null)
    {
        Db = db;
        Sink = sink;
        Activity = activity;
        States = states ?? new CollectorStateStore(db);
        Queue = queue;
        Time = time ?? TimeProvider.System;
        Loggers = loggers ?? NullLoggerFactory.Instance;
        Settings = new CollectorSettingsStore(db);
        CollectorDb.EnsureSchema(db);
    }

    public VaultDb Db { get; }
    public Func<IRecordSink?> Sink { get; }
    public ActivityLog? Activity { get; }
    public CollectorStateStore States { get; }
    public UploadQueue? Queue { get; }
    public TimeProvider Time { get; }
    public ILoggerFactory Loggers { get; }
    public CollectorSettingsStore Settings { get; }
}
