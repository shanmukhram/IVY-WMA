using Ivy.Core.Storage;
using Ivy.Core.Upload;

namespace Ivy.App.Core.Tests;

public class ActivityFeedTests
{
    private static ActivityEntry E(long id, string evt = "queued") => new(id, "2026-10-10T12:00:00.000Z", "files", evt, "up/x" + id);

    [Fact]
    public void Newest_first_and_bounded()
    {
        var f = new ActivityFeed();
        for (var i = 1; i <= 600; i++) f.Add(E(i));
        Assert.Equal(ActivityFeed.DefaultCapacity, f.Items.Count);
        Assert.Equal(600, f.Items[0].ActivityId);
        Assert.Equal(101, f.Items[^1].ActivityId);
    }

    [Fact]
    public void Seed_then_live_events_are_deduplicated()
    {
        var f = new ActivityFeed();
        f.Add(E(11));                                    // live event raced ahead of the history read
        f.Seed(new[] { E(11), E(10), E(9) });            // Recent() is newest first
        f.Add(E(10));
        Assert.Equal(new long?[] { 11, 10, 9 }, f.Items.Select(i => i.ActivityId).ToArray());
    }

    [Fact]
    public void Large_batches_keep_only_the_newest()
    {
        var f = new ActivityFeed(capacity: 3);
        f.Add(E(1));
        f.AddRange(Enumerable.Range(2, 1000).Select(i => FeedEntry.FromActivity(E(i))).ToList());
        Assert.Equal(new long?[] { 1001, 1000, 999 }, f.Items.Select(i => i.ActivityId).ToArray());
    }

    [Fact]
    public void Seed_respects_capacity()
    {
        var f = new ActivityFeed(capacity: 3);
        f.Seed(Enumerable.Range(1, 10).Reverse().Select(i => E(i)));
        Assert.Equal(new long?[] { 10, 9, 8 }, f.Items.Select(i => i.ActivityId).ToArray());
    }

    [Fact]
    public void Scroll_pause_holds_entries_until_cleared()
    {
        var f = new ActivityFeed();
        f.Add(E(1));
        f.ScrollPaused = true;
        f.Add(E(2));
        f.Add(E(3));
        Assert.Single(f.Items);
        Assert.Equal(2, f.HeldCount);
        Assert.Equal("2 new while paused", f.HeldText);
        f.ScrollPaused = false;
        Assert.Equal(new long?[] { 3, 2, 1 }, f.Items.Select(i => i.ActivityId).ToArray());
        Assert.Equal(0, f.HeldCount);
        Assert.Equal("", f.HeldText);
    }

    [Fact]
    public void Held_entries_are_bounded_too()
    {
        var f = new ActivityFeed(capacity: 5);
        f.ScrollPaused = true;
        for (var i = 1; i <= 20; i++) f.Add(E(i));
        Assert.Equal(5, f.HeldCount);
        f.ScrollPaused = false;
        Assert.Equal(new long?[] { 20, 19, 18, 17, 16 }, f.Items.Select(i => i.ActivityId).ToArray());
        f.Add(E(3)); // id 3 was dropped from the held list, so it is no longer considered a duplicate
        Assert.Equal(3, f.Items[0].ActivityId);
    }

    [Fact]
    public void Only_upload_started_progress_becomes_a_line()
    {
        var now = DateTimeOffset.Parse("2026-10-10T12:00:00Z");
        var started = FeedEntry.FromProgress(new UploadProgress("up/k", "files", 0, 100, UploadPhase.Started), now);
        Assert.NotNull(started);
        Assert.Equal(ActivityEvents.UploadStarted, started!.Event);
        Assert.Equal("up/k 100 bytes", started.DetailText);
        Assert.Null(started.ActivityId);
        Assert.Null(FeedEntry.FromProgress(new UploadProgress("up/k", "files", 50, 100, UploadPhase.Progress), now));
        Assert.Null(FeedEntry.FromProgress(new UploadProgress("up/k", "files", 100, 100, UploadPhase.Completed), now));
        Assert.Null(FeedEntry.FromProgress(new UploadProgress("up/k", "files", 0, 100, UploadPhase.Failed, "x"), now));
    }

    [Fact]
    public void Entries_without_ids_are_never_deduplicated()
    {
        var f = new ActivityFeed();
        var e = new FeedEntry(null, DateTimeOffset.UnixEpoch, null, "upload_started", "k");
        f.Add(e);
        f.Add(e);
        Assert.Equal(2, f.Items.Count);
        Assert.Equal("-", f.Items[0].CollectorText);
    }

    [Fact]
    public void Bad_timestamps_do_not_throw()
    {
        var entry = FeedEntry.FromActivity(new ActivityEntry(1, "garbage", null, "x", null));
        Assert.Equal(DateTimeOffset.UnixEpoch, entry.Time);
    }
}
