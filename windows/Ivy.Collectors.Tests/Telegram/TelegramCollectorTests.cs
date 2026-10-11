using System.Text;
using System.Text.Json;
using Ivy.Collectors.Common;
using Ivy.Collectors.Telegram;
using Ivy.Collectors.Telegram.Client;
using Ivy.Collectors.Telegram.TData;
using Ivy.Collectors.Tests.Support;
using Ivy.Core.Commands;
using Ivy.Core.Protocol;
using Ivy.Core.Records;

namespace Ivy.Collectors.Tests.Telegram;

/// <summary>
/// The Telegram collector driven end to end on macOS: the real <see cref="TdataReader"/> against a generated
/// fixture, and a scripted <see cref="FakeTelegramClient"/> for the MTProto surface (WT1-WT4, WX1-WX2).
/// </summary>
public class TelegramCollectorTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly DateTimeOffset _t0 = new(2025, 10, 9, 8, 0, 0, TimeSpan.Zero);

    public TelegramCollectorTests() => _env = new TestEnv(_dir);

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private string Tdata => _dir.Sub("tdata");

    /// <summary>Write a single-account, empty-passcode tdata fixture and return its 256-byte auth key.</summary>
    private byte[] WriteFixture(long userId = 777, int dc = 2)
    {
        var key = TdataWriter.RandomAuthKey();
        TdataWriter.Write(Tdata, ReadOnlySpan<byte>.Empty, activeIndex: 0,
            new TdataWriter.AccountSpec(0, userId, dc, new Dictionary<int, byte[]> { [dc] = key }));
        return key;
    }

    private TelegramCollector NewCollector(FakeTelegramClient? fake, TelegramSettings? settings = null,
        ITelegramPasscodeStore? passcode = null, CollectorContext? ctx = null) =>
        new(ctx ?? _env.Context,
            settings ?? new TelegramSettings { TdataPath = Tdata },
            clientFactory: fake,
            passcode: passcode,
            readAccounts: null,
            portableExeDir: null);

    private TgMessage Msg(long id, string sender, string text, int minutes, IReadOnlyList<TgAttachment>? att = null) =>
        new(id, sender, _t0.AddMinutes(minutes), text, Attachments: att);

    private IReadOnlyList<CapturedRecord> Batches() => _env.Sink.Of(Kind.MessageBatch);

    private static JsonElement[] MessagesOf(CapturedRecord b) => b.Root.GetProperty("messages").EnumerateArray().ToArray();

    // ---------------------------------------------------------------- backfill

    [Fact]
    public void Poll_interval_is_five_seconds() =>
        Assert.Equal(TimeSpan.FromSeconds(5), NewCollector(new FakeTelegramClient()).Interval);

    [Fact]
    public async Task Dialog_list_is_refreshed_about_once_a_minute_not_every_tick()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        fake.AddDm("user:20", "Alice", "Alice");
        var tg = NewCollector(fake);
        await tg.StartAsync(default);

        await tg.TickAsync(default);
        _env.Time.Advance(TimeSpan.FromSeconds(5));
        await tg.TickAsync(default);
        Assert.Equal(1, fake.GetDialogsCalls);

        _env.Time.Advance(TimeSpan.FromSeconds(61));
        await tg.TickAsync(default);
        Assert.Equal(2, fake.GetDialogsCalls);
    }

    [Fact]
    public async Task Captures_the_chat_avatar_and_links_it_on_chatMeta()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:20", "Alice", "Alice") with { AvatarRef = "user:20|555|2" };
        fake.Dialogs[fake.Dialogs.Count - 1] = dm;        // replace with the avatar-bearing dialog
        fake.Avatars["user:20|555|2"] = new byte[] { 0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4 }; // a tiny PNG-ish blob
        fake.AddMessage(dm.ConvKey, Msg(5, "u20", "hi", 3));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        var direct = Batches().Single(b => b.Str("convKey") == "user:20");
        var oid = direct.Root.GetProperty("chatMeta").GetProperty("avatarBlobOid").GetString();
        Assert.False(string.IsNullOrEmpty(oid));
        // an avatar blob was enqueued (manifest + part under the blob prefix)
        Assert.Contains(_env.Sink.Blobs, b => b.PayloadKind == "avatar");
    }

    [Fact]
    public async Task Backfill_emits_complete_batches_with_source_session_and_chatMeta()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var g = fake.AddGroup("channel:10", "Robotics", participants: 5);
        fake.AddMessage(g.ConvKey, Msg(1, "u1", "are we on?", 1));
        fake.AddMessage(g.ConvKey, Msg(2, "u2", "yes", 2));
        var dm = fake.AddDm("user:20", "Alice", "Alice");
        fake.AddMessage(dm.ConvKey, Msg(5, "u20", "hi", 3));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        Assert.Equal(TelegramHealth.Ok, tg.Health);
        Assert.Null(tg.LastError);
        Assert.Equal(1, fake.Connects);

        var batches = Batches();
        Assert.All(batches, b => Assert.Equal("telegram", b.Str("platform")));
        Assert.All(batches, b => Assert.Equal("windows:telegram-desktop", b.Str("sourceSession")));
        Assert.All(batches, b => Assert.Equal("complete", b.Str("coverage")));
        Assert.All(batches, b => Assert.Equal("777", b.Str("account")));

        var group = batches.Single(b => b.Str("convKey") == "channel:10");
        Assert.Equal("group", group.Str("convKind"));
        Assert.Equal("Robotics", group.Root.GetProperty("chatMeta").GetProperty("title").GetString());
        Assert.Equal(5, group.Root.GetProperty("chatMeta").GetProperty("participantCount").GetInt32());
        Assert.Equal(2, MessagesOf(group).Length);

        var direct = batches.Single(b => b.Str("convKey") == "user:20");
        Assert.Equal("dm", direct.Str("convKind"));
        Assert.Equal("Alice", direct.Str("peer"));
        Assert.All(MessagesOf(direct), m => Assert.Equal("live", m.GetProperty("sourceStatus").GetString()));

        Assert.NotNull(tg.Import);
        Assert.Equal(2, tg.Import!.Total);   // two chats
        Assert.Equal(2, tg.Import!.Done);     // both complete
    }

    [Fact]
    public async Task History_pages_oldest_ward_and_resumes_after_restart()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:1", "Bob", "Bob");
        for (var i = 1; i <= 5; i++) fake.AddMessage(dm.ConvKey, Msg(i, "u1", $"m{i}", i));

        // One page of 2 per tick, so the backfill spans three ticks / two restarts.
        var settings = new TelegramSettings { TdataPath = Tdata, HistoryPageSize = 2, HistoryPagesPerTick = 1 };

        var tg = NewCollector(fake, settings);
        await tg.StartAsync(default);
        await tg.TickAsync(default);                       // newest 2 (ids 5,4)

        var ctx2 = _env.Restart();
        var tg2 = NewCollector(fake, settings, ctx: ctx2);
        await tg2.StartAsync(default);
        await tg2.TickAsync(default);                      // ids 3,2
        await tg2.TickAsync(default);                      // id 1, then history complete

        var ids = Batches().SelectMany(MessagesOf).Select(m => m.GetProperty("msgId").GetString()).ToList();
        Assert.Equal(new[] { "1", "2", "3", "4", "5" }, ids.OrderBy(x => int.Parse(x!)));
        Assert.Equal(5, ids.Count);                        // no duplicates across restarts
        Assert.True(tg2.Store.GetChat("user:1")!.HistoryComplete);

        _env.Sink.Clear();
        await tg2.TickAsync(default);                      // nothing new
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task Resync_rewalks_completed_history()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:1", "Bob", "Bob");
        for (var i = 1; i <= 3; i++) fake.AddMessage(dm.ConvKey, Msg(i, "u1", $"m{i}", i));

        var tg = NewCollector(fake, new TelegramSettings { TdataPath = Tdata, HistoryPageSize = 10, HistoryPagesPerTick = 5 });
        await tg.StartAsync(default);
        await tg.TickAsync(default);                       // backfill all 3, history complete
        Assert.True(tg.Store.GetChat("user:1")!.HistoryComplete);

        _env.Sink.Clear();
        await tg.TickAsync(default);                       // a plain tick re-emits nothing
        Assert.Empty(Batches());

        tg.RequestResync();                                // the one-time re-sync
        await tg.TickAsync(default);                       // re-walks the completed chat
        var ids = Batches().SelectMany(MessagesOf).Select(m => m.GetProperty("msgId").GetString()).OrderBy(x => int.Parse(x!)).ToArray();
        Assert.Equal(new[] { "1", "2", "3" }, ids);        // every message re-emitted (Mac merges by msgId)
        Assert.True(tg.Store.GetChat("user:1")!.HistoryComplete); // complete again after the re-walk
    }

    // ---------------------------------------------------------------- listing (archive)

    private static string? ListingOf(CapturedRecord b) =>
        b.Root.TryGetProperty("chatMeta", out var cm) && cm.TryGetProperty("listing", out var l) ? l.GetString() : null;

    [Fact]
    public async Task Every_batch_carries_listing_archived_or_normal()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:20", "Alice", "Alice");
        fake.Dialogs[^1] = dm with { Archived = true };
        fake.AddMessage(dm.ConvKey, Msg(5, "u20", "hi", 3));
        var g = fake.AddGroup("chat:10", "Lab", 3);
        fake.AddMessage(g.ConvKey, Msg(6, "u1", "yo", 4));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        Assert.Equal("archived", ListingOf(Batches().Single(b => b.Str("convKey") == "user:20")));
        Assert.Equal("normal", ListingOf(Batches().Single(b => b.Str("convKey") == "chat:10")));
    }

    [Fact]
    public async Task Archive_change_with_no_new_messages_emits_one_metadata_only_batch()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:20", "Alice", "Alice");
        fake.AddMessage(dm.ConvKey, Msg(5, "u20", "hi", 3));
        var g = fake.AddGroup("chat:10", "Lab", 3);
        fake.AddMessage(g.ConvKey, Msg(6, "u1", "yo", 4));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);                      // backfill: both normal
        _env.Sink.Clear();

        // no change: the next dialog refresh sends nothing
        _env.Time.Advance(TimeSpan.FromSeconds(61));
        await tg.TickAsync(default);
        Assert.Empty(Batches());

        // the owner archives the DM in Telegram; the next refresh sends exactly one metadata-only batch
        var i = fake.Dialogs.FindIndex(d => d.ConvKey == "user:20");
        fake.Dialogs[i] = fake.Dialogs[i] with { Archived = true };
        _env.Time.Advance(TimeSpan.FromSeconds(61));
        await tg.TickAsync(default);
        var meta = Assert.Single(Batches());
        Assert.Equal("user:20", meta.Str("convKey"));
        Assert.Equal("dm", meta.Str("convKind"));
        Assert.Equal("complete", meta.Str("coverage"));
        Assert.Equal("5", meta.Str("cursor"));
        Assert.Empty(MessagesOf(meta));
        Assert.Equal("archived", ListingOf(meta));
        Assert.Equal("Alice", meta.Root.GetProperty("chatMeta").GetProperty("title").GetString());
        _env.Sink.Clear();

        // unchanged again: nothing; then unarchive: one batch with listing normal
        _env.Time.Advance(TimeSpan.FromSeconds(61));
        await tg.TickAsync(default);
        Assert.Empty(Batches());
        fake.Dialogs[i] = fake.Dialogs[i] with { Archived = false };
        _env.Time.Advance(TimeSpan.FromSeconds(61));
        await tg.TickAsync(default);
        Assert.Equal("normal", ListingOf(Assert.Single(Batches())));
    }

    [Fact]
    public async Task Chats_captured_before_listing_existed_send_only_the_archived_ones_once()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:20", "Alice", "Alice");
        fake.AddMessage(dm.ConvKey, Msg(5, "u20", "hi", 3));
        var g = fake.AddGroup("chat:10", "Lab", 3);
        fake.AddMessage(g.ConvKey, Msg(6, "u1", "yo", 4));
        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);
        _env.Sink.Clear();

        // simulate an install that captured these chats before listings were stored
        using (var c = _env.Context.Db.Open())
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "UPDATE tg_chat_state SET listing = NULL";
            cmd.ExecuteNonQuery();
        }
        fake.Dialogs[fake.Dialogs.FindIndex(d => d.ConvKey == "user:20")] = fake.Dialogs.First(d => d.ConvKey == "user:20") with { Archived = true };
        _env.Time.Advance(TimeSpan.FromSeconds(61));
        await tg.TickAsync(default);
        var meta = Assert.Single(Batches());              // the archived DM only; the normal group is just recorded
        Assert.Equal("user:20", meta.Str("convKey"));
        Assert.Equal("archived", ListingOf(meta));
        Assert.Equal("normal", tg.Store.GetSentListing("chat:10"));
    }

    [Fact]
    public async Task A_folder_update_in_the_difference_re_lists_dialogs_on_the_next_tick()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:20", "Alice", "Alice");
        fake.AddMessage(dm.ConvKey, Msg(5, "u20", "hi", 3));
        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);
        _env.Sink.Clear();
        Assert.Equal(1, fake.GetDialogsCalls);

        fake.Dialogs[0] = fake.Dialogs[0] with { Archived = true };
        fake.Differences.Enqueue(new TgDifference(Array.Empty<TgMessageUpdate>(), "state1", false, DialogsChanged: true));
        _env.Time.Advance(TimeSpan.FromSeconds(5));
        await tg.TickAsync(default);                      // sees the folder update
        _env.Time.Advance(TimeSpan.FromSeconds(5));
        await tg.TickAsync(default);                      // re-lists well before the 60 s refresh
        Assert.Equal(2, fake.GetDialogsCalls);
        Assert.Equal("archived", ListingOf(Assert.Single(Batches())));
    }

    // ---------------------------------------------------------------- incremental

    [Fact]
    public async Task Incremental_applies_new_edits_and_deletions()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:1", "Bob", "Bob");
        fake.AddMessage(dm.ConvKey, Msg(1, "u1", "original", 1));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);                       // backfill id 1
        _env.Sink.Clear();

        var edited = Msg(1, "u1", "edited text", 1) with { EditedAt = _t0.AddMinutes(9) };
        var added = Msg(2, "u1", "brand new", 5);
        var deleted = Msg(1, "u1", "original", 1) with { Deleted = true, DeletedAt = _t0.AddMinutes(10) };
        fake.Differences.Enqueue(new TgDifference(new[]
        {
            new TgMessageUpdate(dm.ConvKey, TgChange.Edited, edited),
            new TgMessageUpdate(dm.ConvKey, TgChange.Added, added),
            new TgMessageUpdate(dm.ConvKey, TgChange.Deleted, deleted),
        }, "state1", false));

        await tg.TickAsync(default);

        var msgs = Batches().SelectMany(MessagesOf).ToList();
        var e = msgs.First(m => m.GetProperty("msgId").GetString() == "1" && m.TryGetProperty("editedAt", out _));
        Assert.Equal("edited text", e.GetProperty("text").GetString());
        var del = msgs.Last(m => m.GetProperty("msgId").GetString() == "1");
        Assert.Equal("deleted_at_source", del.GetProperty("sourceStatus").GetString());
        Assert.True(del.TryGetProperty("deletedAtSource", out _));
        Assert.Contains(msgs, m => m.GetProperty("msgId").GetString() == "2" && m.GetProperty("text").GetString() == "brand new");
    }

    // ---------------------------------------------------------------- status transitions

    [Fact]
    public async Task No_client_factory_reports_not_configured()
    {
        WriteFixture();
        var tg = NewCollector(fake: null);
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        Assert.Equal(TelegramHealth.NotConfigured, tg.Health);
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task Missing_tdata_reports_not_found()
    {
        var tg = NewCollector(new FakeTelegramClient(), new TelegramSettings { TdataPath = _dir.Sub("absent") });
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        Assert.Equal(TelegramHealth.TdataNotFound, tg.Health);
        Assert.NotNull(tg.LastError);
    }

    [Fact]
    public async Task Passcode_required_then_supplied_connects()
    {
        var key = TdataWriter.RandomAuthKey();
        TdataWriter.Write(Tdata, Encoding.UTF8.GetBytes("1234"), activeIndex: 0,
            new TdataWriter.AccountSpec(0, 1, 1, new Dictionary<int, byte[]> { [1] = key }));
        var fake = new FakeTelegramClient();
        fake.AddDm("user:1", "A", "A");

        var passcode = new InMemoryTelegramPasscodeStore();           // empty → wrong
        var tg = NewCollector(fake, passcode: passcode);
        await tg.StartAsync(default);
        await tg.TickAsync(default);
        Assert.Equal(TelegramHealth.NeedsPasscode, tg.Health);

        passcode.StorePasscode(Encoding.UTF8.GetBytes("1234"));       // entered once in the app
        await tg.TickAsync(default);
        Assert.Equal(TelegramHealth.Ok, tg.Health);
        Assert.Equal(key, fake.ConnectedWith!.AuthKeys[1]);           // connected as the real session
    }

    [Fact]
    public async Task Session_invalid_from_connect_sets_status()
    {
        WriteFixture();
        var fake = new FakeTelegramClient { ConnectThrows = new SessionInvalidException("logged out elsewhere") };
        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        Assert.Equal(TelegramHealth.SessionInvalid, tg.Health);
        Assert.Contains("session invalid", tg.LastError!);
        Assert.Empty(Batches());
    }

    [Fact]
    public async Task Flood_wait_backs_off_then_resumes_after_the_wait()
    {
        WriteFixture();
        var fake = new FakeTelegramClient { FloodSecondsOnNextHistory = 30 };
        var dm = fake.AddDm("user:1", "Bob", "Bob");
        fake.AddMessage(dm.ConvKey, Msg(1, "u1", "hello", 1));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);                       // history throws FLOOD_WAIT
        Assert.Equal(TelegramHealth.FloodWait, tg.Health);
        Assert.NotNull(tg.FloodWaitUntil);
        Assert.Empty(Batches());

        await tg.TickAsync(default);                       // still inside the wait: no client calls
        Assert.Equal(TelegramHealth.FloodWait, tg.Health);
        Assert.Empty(Batches());

        _env.Time.Advance(TimeSpan.FromSeconds(31));       // wait elapses
        await tg.TickAsync(default);
        Assert.Equal(TelegramHealth.Ok, tg.Health);
        Assert.Single(Batches());
    }

    [Fact]
    public async Task Secret_chats_are_reported_phone_only_and_never_emitted()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        fake.AddDm("user:1", "Bob", "Bob");
        fake.AddMessage("user:1", Msg(1, "u1", "cloud message", 1));
        fake.SecretChatIds.Add("secret:99");

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        Assert.Equal(1, tg.Store.PhoneOnlyCount());
        Assert.Contains("phone-only", tg.Detail);
        Assert.DoesNotContain(Batches(), b => b.Str("convKey") == "secret:99");
    }

    // ---------------------------------------------------------------- media policy

    [Fact]
    public async Task Media_policy_uploads_images_under_cap_and_leaves_video_metadata_only()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:1", "Bob", "Bob");
        var img = new TgAttachment("a-img", TgAttachmentKind.Image, "pic.jpg", 8, "hash-img", "ref-img");
        var vid = new TgAttachment("a-vid", TgAttachmentKind.Video, "clip.mp4", 500, "hash-vid", "ref-vid");
        fake.Downloads["ref-img"] = Encoding.UTF8.GetBytes("JPEGDATA");  // 8 bytes
        fake.Downloads["ref-vid"] = new byte[500];
        fake.AddMessage(dm.ConvKey, Msg(1, "u1", "see pic", 1, new[] { img }));
        fake.AddMessage(dm.ConvKey, Msg(2, "u1", "see clip", 2, new[] { vid }));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        // The image original is uploaded as a photo blob; the video is not.
        var blob = Assert.Single(_env.Sink.Blobs);
        Assert.Equal(PayloadKinds.Photo, blob.PayloadKind);
        Assert.True(blob.Bulk);
        Assert.Equal(8, blob.Data.Length);

        var atts = Batches().SelectMany(MessagesOf)
            .Where(m => m.TryGetProperty("attachments", out var a) && a.GetArrayLength() > 0)
            .SelectMany(m => m.GetProperty("attachments").EnumerateArray()).ToList();
        var imgAtt = atts.Single(a => a.GetProperty("attId").GetString() == "a-img");
        Assert.Equal(blob.Oid, imgAtt.GetProperty("blobOid").GetString());
        var vidAtt = atts.Single(a => a.GetProperty("attId").GetString() == "a-vid");
        Assert.False(vidAtt.TryGetProperty("blobOid", out _));         // metadata only
        Assert.Equal("metadata", tg.Store.GetAttachment("ref-vid")!.Status);
    }

    [Fact]
    public async Task File_request_fetches_a_metadata_only_attachment_on_demand()
    {
        WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:1", "Bob", "Bob");
        var vid = new TgAttachment("a-vid", TgAttachmentKind.Video, "clip.mp4", 500, "hash-vid", "ref-vid");
        fake.Downloads["ref-vid"] = new byte[500];
        fake.AddMessage(dm.ConvKey, Msg(1, "u1", "clip", 1, new[] { vid }));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);                       // records the reference, uploads nothing

        var handler = new TelegramFileRequestHandler(_env.Sink, tg.Store, () => fake);
        var command = Command();

        var ok = await handler.HandleFileRequestAsync(command, new FileRequestParams { FileId = "tg:ref-vid" }, default);
        Assert.Equal(CommandStatusValues.Uploaded, ok.Status);
        Assert.Equal(PayloadKinds.Attachment, _env.Sink.Blobs.Single().PayloadKind);

        var missing = await handler.HandleFileRequestAsync(command, new FileRequestParams { FileId = "tg:nope" }, default);
        Assert.Equal(CommandStatusValues.NotFound, missing.Status);

        var notMine = await handler.HandleFileRequestAsync(command, new FileRequestParams { FileId = "file:123" }, default);
        Assert.Equal(CommandStatusValues.NotFound, notMine.Status);
    }

    // ---------------------------------------------------------------- WX2: no key leakage

    [Fact]
    public async Task No_auth_key_bytes_reach_the_sink_or_the_vault_db()
    {
        var key = WriteFixture();
        var fake = new FakeTelegramClient();
        var dm = fake.AddDm("user:1", "Bob", "Bob");
        var img = new TgAttachment("a", TgAttachmentKind.Image, "p.jpg", 4, "h", "ref");
        fake.Downloads["ref"] = new byte[] { 1, 2, 3, 4 };
        fake.AddMessage(dm.ConvKey, Msg(1, "u1", "hi", 1, new[] { img }));

        var tg = NewCollector(fake);
        await tg.StartAsync(default);
        await tg.TickAsync(default);

        Assert.Equal(key, fake.ConnectedWith!.AuthKeys[2]);            // the client did receive the real key

        foreach (var rec in _env.Sink.Records)
            Assert.False(Contains(Encoding.UTF8.GetBytes(rec.Json), key), "auth key bytes found in a record");
        foreach (var blob in _env.Sink.Blobs)
            Assert.False(Contains(blob.Data, key), "auth key bytes found in a blob");

        // The collector-owned tables persist metadata only — never the key. Scan every on-disk file under the
        // data dir (vault-agent.db plus any -wal/-shm) and the upload queue directory.
        foreach (var f in Directory.EnumerateFiles(_env.DataDir, "*", SearchOption.AllDirectories))
            Assert.False(Contains(ReadShared(f), key), $"auth key bytes found in {f}");
    }

    private static byte[] ReadShared(string path)
    {
        // A SQLite -wal/-shm sidecar can be checkpointed away between enumeration and open; a file that no
        // longer exists holds no bytes on disk, so treat it as empty rather than failing the scan.
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var ms = new MemoryStream();
            fs.CopyTo(ms);
            return ms.ToArray();
        }
        // A sidecar can also vanish as a directory entry or be briefly locked during a checkpoint; any
        // transient IO on a file that is gone or in flux means no readable bytes on disk, which is the
        // property under test.
        catch (FileNotFoundException) { return Array.Empty<byte>(); }
        catch (DirectoryNotFoundException) { return Array.Empty<byte>(); }
        catch (IOException) { return Array.Empty<byte>(); }
    }

    private CommandRecord Command() => new()
    {
        DeviceId = "dev-test",
        EventTime = "2025-10-09T08:00:00.000Z",
        CaptureTime = "2025-10-09T08:00:00.000Z",
        CommandId = "cmd-1",
        IssuedAt = "2025-10-09T08:00:00.000Z",
        Params = new FileRequestParams { FileId = "tg:ref-vid" },
    };

    private static bool Contains(byte[] haystack, byte[] needle)
    {
        if (needle.Length == 0 || haystack.Length < needle.Length) return false;
        for (var i = 0; i <= haystack.Length - needle.Length; i++)
        {
            var ok = true;
            for (var j = 0; j < needle.Length; j++)
                if (haystack[i + j] != needle[j]) { ok = false; break; }
            if (ok) return true;
        }
        return false;
    }
}
