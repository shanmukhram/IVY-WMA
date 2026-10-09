using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;

namespace Ivy.Collectors.Notifications;

/// <summary>
/// WC5: reads toasts from the Windows notification database and emits <c>windows_notification</c>
/// (<c>app</c> = NotificationHandler.PrimaryId, <c>title</c>/<c>text</c> from the toast XML,
/// <c>sender</c> = attribution text if any, <c>postedAt</c> = ArrivalTime). Cursor = highest Notification.Id
/// emitted, in <c>collector_state.cursor</c>. If the database cannot be read the collector is in the
/// Error state with the reason; it never reports success it did not have.
/// </summary>
public sealed class NotificationCollector : Collector<NotificationSettings>
{
    private readonly Func<NotificationSettings, INotificationDbReader> _readerFactory;
    private INotificationDbReader _reader;

    public NotificationCollector(CollectorContext context, Func<NotificationSettings, INotificationDbReader>? readerFactory = null, NotificationSettings? settings = null)
        : base(CollectorNames.Notifications, context, settings)
    {
        _readerFactory = readerFactory ?? (s => new WpnDatabaseReader(s.DatabasePath ?? NotificationSettings.DefaultDatabasePath()));
        _reader = _readerFactory(Settings);
    }

    public override TimeSpan Interval => TimeSpan.FromSeconds(Settings.PollSeconds);

    public long LastId { get; private set; }

    protected override void Validate(NotificationSettings s)
    {
        if (s.PollSeconds < 5) throw new ArgumentException("pollSeconds must be >= 5");
        if (s.BatchSize is < 1 or > 10_000) throw new ArgumentException("batchSize must be 1..10000");
    }

    protected override void OnSettingsChanged(NotificationSettings previous, NotificationSettings current) => _reader = _readerFactory(current);

    public override Task StartAsync(CancellationToken ct)
    {
        LastId = long.TryParse(Context.States.Get(Name)?.Cursor, out var id) ? id : 0;
        Cursor = LastId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Task.CompletedTask;
    }

    public override Task TickAsync(CancellationToken ct)
    {
        var sink = Sink;
        if (sink is null) return Task.CompletedTask;
        var total = 0;
        while (!ct.IsCancellationRequested)
        {
            IReadOnlyList<RawNotification> rows;
            try { rows = _reader.ReadAfter(LastId, Settings.BatchSize); }
            catch (NotificationDbUnavailableException e)
            {
                SetError(e.Message);
                Detail = $"cannot read {_reader.DatabasePath}";
                return Task.CompletedTask;
            }
            foreach (var row in rows)
            {
                if (ToRecord(row, DeviceId(sink)) is { } record) { Emit(sink, record); total++; }
                LastId = Math.Max(LastId, row.Id);
                Cursor = LastId.ToString(System.Globalization.CultureInfo.InvariantCulture);
                // Persist after every row so a crash never re-sends or skips (host also records after the tick).
                Context.States.RecordRun(Name, Now, Cursor);
            }
            if (rows.Count < Settings.BatchSize) break;
        }
        Detail = $"last notification id {LastId}" + (total > 0 ? $", {total} new" : "");
        return Task.CompletedTask;
    }

    private WindowsNotificationRecord? ToRecord(RawNotification row, string deviceId)
    {
        if (row.Type is not null && !row.Type.Equals("toast", StringComparison.OrdinalIgnoreCase)) return null; // tiles/badges carry no message
        var app = row.HandlerPrimaryId ?? "unknown";
        if (Settings.ExcludedApps.Any(x => app.Contains(x, StringComparison.OrdinalIgnoreCase))) return null;
        var toast = ToastXml.Parse(row.PayloadXml);
        if (toast is null) return null;
        var posted = row.ArrivalTimeFileTime > 0 ? IvyTime.Format(DateTimeOffset.FromFileTime(row.ArrivalTimeFileTime)) : IvyTime.Format(Now);
        return new WindowsNotificationRecord
        {
            DeviceId = deviceId,
            EventTime = posted,
            CaptureTime = IvyTime.Format(Now),
            App = app,
            Title = toast.Title,
            Text = toast.Text,
            Sender = toast.Attribution,
            PostedAt = posted,
        };
    }
}
