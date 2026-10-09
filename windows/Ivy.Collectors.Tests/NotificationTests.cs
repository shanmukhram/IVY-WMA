using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Notifications;
using Ivy.Collectors.Tests.Support;
using Ivy.Core.Protocol;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Tests;

/// <summary>
/// A wpndatabase.db fixture with the real table and column names (Windows 10/11): Notification
/// (Id, HandlerId, ActivityId, Type, Payload BLOB, Tag, "Group", ExpiryTime, ArrivalTime FILETIME,
/// DataVersion, PayloadType, BootId, ExpiresOnReboot) and NotificationHandler (RecordId, PrimaryId,
/// HandlerType, ...). Kept open in WAL mode while the collector reads, like the live database.
/// </summary>
public sealed class WpnFixture : IDisposable
{
    private readonly SqliteConnection _c;
    public WpnFixture(string path)
    {
        Path = path;
        _c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        _c.Open();
        Exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
        Exec("""
            CREATE TABLE NotificationHandler (
                RecordId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                PrimaryId TEXT NOT NULL,
                HandlerType TEXT NOT NULL DEFAULT 'app:desktop',
                CreatedTime INTEGER NOT NULL DEFAULT 0,
                ModifiedTime INTEGER NOT NULL DEFAULT 0,
                WNSId TEXT, WNFEventName INTEGER, SystemDataPropertySet BLOB, PartyId TEXT);
            CREATE TABLE Notification (
                Id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                HandlerId INTEGER NOT NULL,
                ActivityId TEXT,
                Type TEXT NOT NULL,
                Payload BLOB,
                Tag TEXT,
                "Group" TEXT,
                ExpiryTime INTEGER NOT NULL DEFAULT 0,
                ArrivalTime INTEGER NOT NULL,
                DataVersion INTEGER, PayloadType TEXT, BootId INTEGER, ExpiresOnReboot INTEGER,
                FOREIGN KEY(HandlerId) REFERENCES NotificationHandler(RecordId) ON DELETE CASCADE);
            """);
    }

    public string Path { get; }

    public long Handler(string primaryId)
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = "INSERT INTO NotificationHandler(PrimaryId) VALUES ($p); SELECT last_insert_rowid();";
        cmd.Parameters.AddWithValue("$p", primaryId);
        return (long)cmd.ExecuteScalar()!;
    }

    public long Add(long handler, string type, string? payload, DateTimeOffset arrival)
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = "INSERT INTO Notification(HandlerId, Type, Payload, ArrivalTime, PayloadType) VALUES ($h, $t, $p, $a, 'Xml'); SELECT last_insert_rowid();";
        cmd.Parameters.AddWithValue("$h", handler);
        cmd.Parameters.AddWithValue("$t", type);
        cmd.Parameters.AddWithValue("$p", payload is null ? DBNull.Value : System.Text.Encoding.UTF8.GetBytes(payload));
        cmd.Parameters.AddWithValue("$a", arrival.ToFileTime());
        return (long)cmd.ExecuteScalar()!;
    }

    private void Exec(string sql)
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    public void Dispose() => _c.Dispose();
}

public class NotificationTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly WpnFixture _db;

    public NotificationTests()
    {
        _env = new TestEnv(_dir);
        Directory.CreateDirectory(_dir.Sub("Notifications"));
        _db = new WpnFixture(_dir.Sub("Notifications", "wpndatabase.db"));
    }

    public void Dispose()
    {
        _db.Dispose();
        _env.Dispose();
        _dir.Dispose();
    }

    private const string Generic = """
        <toast launch="action=openThread&amp;id=42"><visual><binding template="ToastGeneric">
          <text>Alice Chen</text><text>Are we still on for the robotics demo?</text><text>Reply by Friday</text>
          <text placement="attribution">via Teams</text>
          <image placement="appLogoOverride" src="file:///C:/x.png"/></binding></visual>
          <actions><input id="r" type="text"/></actions></toast>
        """;

    private const string Legacy = """<toast><visual><binding template="ToastText02"><text id="1">Download complete</text><text id="2">invoice.pdf</text></binding></visual></toast>""";

    private NotificationCollector NewCollector(Common.CollectorContext? ctx = null, string? path = null) =>
        new(ctx ?? _env.Context, s => new WpnDatabaseReader(path ?? _db.Path, _dir.Sub("wpn-tmp")),
            new NotificationSettings { DatabasePath = path ?? _db.Path });

    [Fact]
    public async Task Toasts_are_read_from_a_snapshot_and_the_cursor_advances()
    {
        var teams = _db.Handler("MSTeams_8wekyb3d8bbwe!MSTeams");
        var edge = _db.Handler("MSEdge");
        var t1 = new DateTimeOffset(2026, 10, 9, 21, 15, 3, 120, TimeSpan.Zero);
        _db.Add(teams, "toast", Generic, t1);
        _db.Add(edge, "tile", "<tile><visual/></tile>", t1);
        var id3 = _db.Add(edge, "toast", Legacy, t1.AddMinutes(5));

        Assert.True(new FileInfo(_db.Path + "-wal").Length > 0);   // rows still only in the WAL, as on a live system
        var c = NewCollector();
        await c.StartAsync(default);
        await c.TickAsync(default);

        var recs = _env.Sink.Of(Kind.WindowsNotification);
        Assert.Equal(2, recs.Count);
        Assert.Equal("MSTeams_8wekyb3d8bbwe!MSTeams", recs[0].Str("app"));
        Assert.Equal("Alice Chen", recs[0].Str("title"));
        Assert.Equal("Are we still on for the robotics demo?\nReply by Friday", recs[0].Str("text"));
        Assert.Equal("via Teams", recs[0].Str("sender"));
        Assert.Equal("2026-10-09T21:15:03.120Z", recs[0].Str("postedAt"));
        Assert.Equal(recs[0].Str("postedAt"), recs[0].Str("eventTime"));
        Assert.Equal(("MSEdge", "Download complete", "invoice.pdf"), (recs[1].Str("app"), recs[1].Str("title"), recs[1].Str("text")));
        Assert.False(recs[1].Has("sender"));
        Assert.Equal(id3.ToString(System.Globalization.CultureInfo.InvariantCulture), c.Cursor);
        Assert.Equal(c.Cursor, _env.States.Get("notifications")!.Cursor);
        Assert.Null(c.LastError);
        Assert.False(Directory.EnumerateFileSystemEntries(_dir.Sub("wpn-tmp")).Any());   // snapshot removed

        // Only new rows next time; a restarted collector continues from collector_state.
        _db.Add(teams, "toast", Generic.Replace("Alice Chen", "Bob"), t1.AddHours(1));
        await c.TickAsync(default);
        Assert.Equal("Bob", _env.Sink.Of(Kind.WindowsNotification).Last().Str("title"));
        Assert.Equal(3, _env.Sink.Of(Kind.WindowsNotification).Count);
        var c2 = NewCollector(_env.Restart());
        await c2.StartAsync(default);
        await c2.TickAsync(default);
        Assert.Equal(3, _env.Sink.Of(Kind.WindowsNotification).Count);
    }

    [Fact]
    public async Task Unreadable_database_is_an_error_state_not_silence()
    {
        var c = NewCollector(path: _dir.Sub("nope", "wpndatabase.db"));
        await c.StartAsync(default);
        await c.TickAsync(default);
        Assert.Contains("not found", c.LastError);
        Assert.Empty(_env.Sink.Records);

        var garbage = _dir.Write("bad/wpndatabase.db", "this is not sqlite");
        var c2 = NewCollector(path: garbage);
        await c2.TickAsync(default);
        Assert.Contains("could not be queried", c2.LastError);
    }

    [Fact]
    public async Task Excluded_apps_are_skipped_but_advance_the_cursor()
    {
        var h = _db.Handler("Spotify.exe");
        var id = _db.Add(h, "toast", Legacy, DateTimeOffset.UnixEpoch.AddYears(56));
        var c = new NotificationCollector(_env.Context, s => new WpnDatabaseReader(_db.Path, _dir.Sub("t")),
            new NotificationSettings { ExcludedApps = new[] { "spotify" } });
        await c.StartAsync(default);
        await c.TickAsync(default);
        Assert.Empty(_env.Sink.Records);
        Assert.Equal(id, c.LastId);
    }

    [Fact]
    public void Reader_rows()
    {
        var h = _db.Handler("Spotify.exe");
        _db.Add(h, "toast", Legacy, DateTimeOffset.UnixEpoch.AddYears(56));
        var rows = new WpnDatabaseReader(_db.Path, _dir.Sub("t")).ReadAfter(0, 10);
        var r = Assert.Single(rows);
        Assert.Equal("Spotify.exe", r.HandlerPrimaryId);
        Assert.Equal("toast", r.Type);
        Assert.Contains("Download complete", r.PayloadXml);
        Assert.Empty(new WpnDatabaseReader(_db.Path, _dir.Sub("t")).ReadAfter(r.Id, 10));
    }

    [Fact]
    public void Toast_xml_parsing()
    {
        Assert.Equal(new ToastContent("Alice Chen", "Are we still on for the robotics demo?\nReply by Friday", "via Teams"), ToastXml.Parse(Generic));
        Assert.Equal(new ToastContent("Download complete", "invoice.pdf", null), ToastXml.Parse("\uFEFF" + Legacy));
        Assert.Equal(new ToastContent("", "", null), ToastXml.Parse("<toast><visual><binding template=\"ToastGeneric\"/></visual></toast>"));
        Assert.Null(ToastXml.Parse("<tile/>"));
        Assert.Null(ToastXml.Parse("not xml"));
        Assert.Null(ToastXml.Parse(null));
        // DTDs (XXE) are refused.
        Assert.Null(ToastXml.Parse("""<!DOCTYPE toast [<!ENTITY x SYSTEM "file:///etc/passwd">]><toast><visual><binding><text>&x;</text></binding></visual></toast>"""));
    }
}
