using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Ivy.Core.Protocol;
using Ivy.Core.Storage;
using Ivy.Core.Upload;

namespace Ivy.App.Core;

/// <summary>One line of the live activity feed. Detail is object keys, sizes and outcomes only, never content.</summary>
public sealed record FeedEntry(long? ActivityId, DateTimeOffset Time, string? Collector, string Event, string? Detail)
{
    public string TimeText => Fmt.Clock(Time);
    public string CollectorText => Collector ?? "-";
    public string DetailText => Detail ?? "";

    public static FeedEntry FromActivity(ActivityEntry e)
    {
        DateTimeOffset t;
        try { t = IvyTime.Parse(e.Timestamp); }
        catch (FormatException) { t = DateTimeOffset.UnixEpoch; }
        return new FeedEntry(e.Id, t, e.Collector, e.Event, e.Detail);
    }

    /// <summary>
    /// Upload progress events that are not already written to activity_log. The uploader logs
    /// <c>uploaded</c> and <c>upload_failed</c> itself, so only <c>Started</c> becomes a feed line.
    /// </summary>
    public static FeedEntry? FromProgress(UploadProgress p, DateTimeOffset now) => p.Phase switch
    {
        UploadPhase.Started => new FeedEntry(null, now, p.Collector, ActivityEvents.UploadStarted, $"{p.ObjectKey} {p.TotalBytes} bytes"),
        _ => null,
    };
}

/// <summary>
/// Bounded, newest-first feed. Holds at most <see cref="Capacity"/> entries; with <see cref="ScrollPaused"/>
/// set, new entries are held back (also bounded) so the visible list stops moving, and are inserted when
/// the pause is cleared. Entries from activity_log are de-duplicated by id, so seeding history and live
/// events can overlap. Must be used from the UI thread only.
/// </summary>
public sealed class ActivityFeed : INotifyPropertyChanged
{
    public const int DefaultCapacity = 500;
    private readonly List<FeedEntry> _held = new();
    private readonly HashSet<long> _ids = new();
    private bool _scrollPaused;

    public ActivityFeed(int capacity = DefaultCapacity)
    {
        if (capacity <= 0) throw new ArgumentOutOfRangeException(nameof(capacity));
        Capacity = capacity;
    }

    public int Capacity { get; }

    /// <summary>Visible entries, index 0 is newest.</summary>
    public ObservableCollection<FeedEntry> Items { get; } = new();

    public event PropertyChangedEventHandler? PropertyChanged;

    public int HeldCount => _held.Count;

    public string HeldText => _held.Count == 0 ? "" : $"{_held.Count} new while paused";

    public bool ScrollPaused
    {
        get => _scrollPaused;
        set
        {
            if (_scrollPaused == value) return;
            _scrollPaused = value;
            if (!value) FlushHeld();
            Raise();
            RaiseHeld();
        }
    }

    /// <summary>Load history (newest first, as <see cref="ActivityLog.Recent"/> returns it) below anything already shown.</summary>
    public void Seed(IEnumerable<ActivityEntry> newestFirst)
    {
        foreach (var e in newestFirst)
        {
            if (Items.Count >= Capacity) break;
            if (!_ids.Add(e.Id)) continue;
            Items.Add(FeedEntry.FromActivity(e));
        }
    }

    public void Add(ActivityEntry e) => Add(FeedEntry.FromActivity(e));

    public void Add(FeedEntry entry)
    {
        if (entry.ActivityId is { } id && !_ids.Add(id)) return;
        if (_scrollPaused)
        {
            _held.Add(entry);
            if (_held.Count > Capacity) Forget(_held[0], fromHeld: true);
            RaiseHeld();
            return;
        }
        Items.Insert(0, entry);
        Trim();
    }

    /// <summary>
    /// Add a batch in arrival order (oldest first). Only the newest <see cref="Capacity"/> entries can survive,
    /// so older ones in a large batch are skipped without touching the list.
    /// </summary>
    public void AddRange(IReadOnlyList<FeedEntry> oldestFirst)
    {
        var start = Math.Max(0, oldestFirst.Count - Capacity);
        for (var i = start; i < oldestFirst.Count; i++) Add(oldestFirst[i]);
    }

    public void Clear()
    {
        Items.Clear();
        _held.Clear();
        _ids.Clear();
        RaiseHeld();
    }

    private void FlushHeld()
    {
        foreach (var e in _held) Items.Insert(0, e);
        _held.Clear();
        Trim();
    }

    private void Trim()
    {
        while (Items.Count > Capacity) Forget(Items[^1], fromHeld: false);
    }

    private void Forget(FeedEntry e, bool fromHeld)
    {
        if (fromHeld) _held.RemoveAt(0);
        else Items.RemoveAt(Items.Count - 1);
        if (e.ActivityId is { } id) _ids.Remove(id);
    }

    private void RaiseHeld()
    {
        Raise(nameof(HeldCount));
        Raise(nameof(HeldText));
    }

    private void Raise([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
