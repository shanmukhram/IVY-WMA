using System.Collections.ObjectModel;
using Ivy.App.Core.ViewModels;
using Ivy.Core.Storage;

namespace Ivy.App.Core;

/// <summary>
/// One command from the Mac as the Transfers page lists it. Built from the command poller's activity lines
/// (<c>commands</c> collector): <c>command_received "{type} {id}"</c>, <c>command_completed "{id} {status}"</c> and
/// <c>command_rejected "{key}: {reason}"</c> (Ivy.Core/Commands/CommandPoller.cs).
/// </summary>
public sealed class CommandItem : ObservableObject
{
    private string _status;
    private string _statusText;
    private UiSeverity _severity;
    private DateTimeOffset _time;

    public CommandItem(string id, string type, DateTimeOffset received, string status = "running", string? detail = null)
    {
        Id = id;
        Type = type;
        TypeText = CommandHistory.TypeName(type);
        _time = received;
        _status = status;
        _statusText = CommandHistory.StatusName(status, detail);
        _severity = CommandHistory.SeverityOf(status);
    }

    public string Id { get; }
    public string Type { get; }
    /// <summary>"File request", "Rescan", "Collector settings", "Rejected command".</summary>
    public string TypeText { get; }
    /// <summary>Short id for the list (first 8 characters).</summary>
    public string ShortId => Id.Length > 8 ? Id[..8] : Id;
    public string Status => _status;
    public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }
    public UiSeverity Severity { get => _severity; private set => Set(ref _severity, value); }
    public DateTimeOffset Time { get => _time; private set { if (Set(ref _time, value)) Raise(nameof(TimeText)); } }
    public string TimeText => Fmt.Clock(_time);

    internal void Complete(string status, DateTimeOffset at)
    {
        _status = status;
        Raise(nameof(Status));
        StatusText = CommandHistory.StatusName(status, null);
        Severity = CommandHistory.SeverityOf(status);
        Time = at;
    }
}

/// <summary>
/// Recent commands, newest first, bounded. UI thread only (fed from the activity feed's flush and seed). Status values
/// are <c>CommandStatusValues</c> (Ivy.Core/Records/Records.cs).
/// </summary>
public sealed class CommandHistory
{
    public const string Collector = "commands";
    public const int DefaultCapacity = 50;
    private readonly int _capacity;

    public CommandHistory(int capacity = DefaultCapacity) => _capacity = capacity > 0 ? capacity : DefaultCapacity;

    public ObservableCollection<CommandItem> Items { get; } = new();

    /// <summary>Feed one activity line (oldest first). Lines from other collectors are ignored.</summary>
    public void Observe(FeedEntry e)
    {
        if (!string.Equals(e.Collector, Collector, StringComparison.Ordinal)) return;
        var detail = (e.Detail ?? "").Trim();
        switch (e.Event)
        {
            case ActivityEvents.CommandReceived:
            {
                // "{type} {commandId}"
                var sp = detail.LastIndexOf(' ');
                if (sp <= 0) return;
                var type = detail[..sp];
                var id = detail[(sp + 1)..];
                if (Find(id) is not null) return;
                Insert(new CommandItem(id, type, e.Time));
                break;
            }
            case ActivityEvents.CommandCompleted:
            {
                // "{commandId} {status}"
                var sp = detail.IndexOf(' ');
                if (sp <= 0) return;
                var id = detail[..sp];
                var status = detail[(sp + 1)..].Trim();
                if (Find(id) is { } item) item.Complete(status, e.Time);
                else Insert(new CommandItem(id, "", e.Time, status)); // received line fell out of the seed window
                break;
            }
            case ActivityEvents.CommandRejected:
            {
                // "{key}: {reason}"
                var colon = detail.IndexOf(": ", StringComparison.Ordinal);
                var key = colon > 0 ? detail[..colon] : detail;
                var reason = colon > 0 ? detail[(colon + 2)..] : null;
                var id = key.Contains('/') ? key[(key.LastIndexOf('/') + 1)..] : key;
                Insert(new CommandItem(id, "rejected", e.Time, "rejected", reason));
                break;
            }
        }
    }

    public void ObserveAll(IEnumerable<FeedEntry> oldestFirst)
    {
        foreach (var e in oldestFirst) Observe(e);
    }

    private CommandItem? Find(string id) => Items.FirstOrDefault(i => string.Equals(i.Id, id, StringComparison.Ordinal));

    private void Insert(CommandItem item)
    {
        Items.Insert(0, item);
        while (Items.Count > _capacity) Items.RemoveAt(Items.Count - 1);
    }

    public static string TypeName(string type) => type switch
    {
        "file_request" => "File request",
        "rescan" => "Rescan",
        "collector_config" => "Collector settings",
        "rejected" => "Rejected command",
        "" => "Command",
        _ => type,
    };

    public static string StatusName(string status, string? detail) => status switch
    {
        "running" => "In progress",
        "done" => "Done",
        "uploaded" => "Uploaded to IVY",
        "not_found" => "File not found",
        "access_denied" => "Access denied",
        "too_large" => "Too large",
        "error" => "Failed",
        "rejected" => string.IsNullOrEmpty(detail) ? "Rejected" : "Rejected: " + detail,
        _ => status.Length == 0 ? "Unknown" : char.ToUpperInvariant(status[0]) + status[1..],
    };

    public static UiSeverity SeverityOf(string status) => status switch
    {
        "error" or "rejected" => UiSeverity.Error,
        "not_found" or "access_denied" or "too_large" => UiSeverity.Warning,
        "running" => UiSeverity.Informational,
        _ => UiSeverity.Success,
    };
}
