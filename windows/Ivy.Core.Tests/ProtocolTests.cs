using System.Text.Json;
using System.Text.Json.Nodes;
using Ivy.Core.Protocol;
using Ivy.Core.Records;

namespace Ivy.Core.Tests;

public class OidAndKeyTests
{
    [Fact]
    public void Crockford_round_trip_and_ordering()
    {
        for (var i = 0; i < 200; i++)
        {
            var b = new byte[16];
            Random.Shared.NextBytes(b);
            var s = Crockford.Encode(b);
            Assert.Equal(26, s.Length);
            Assert.Equal(b, Crockford.Decode(s, 16));
        }
        Assert.Throws<FormatException>(() => Crockford.Decode("0000000000000000000000000U", 16));
        Assert.Throws<FormatException>(() => Crockford.Decode("00000000000000000000000001", 16)); // non-zero pad bits
    }

    [Fact]
    public void Oids_sort_by_time()
    {
        var r = new byte[10];
        var early = Oids.Make(1_000_000_000_000, r);
        var late = Oids.Make(2_000_000_000_000, r);
        Assert.True(Oids.After(late, early));
        Assert.False(Oids.After(early, late));
        Assert.Equal(1_000_000_000_000, Oids.TimestampMs(early));
        var a = Oids.New();
        Assert.True(Oids.IsValid(a));
        Assert.Equal(Oids.Length, a.Length);
        Assert.False(Oids.IsValid("short"));
    }

    [Fact]
    public void Kind_table_matches_protocol()
    {
        var expected = new (string Name, byte Id, string Prefix)[]
        {
            ("file_meta", 1, "file"), ("screenshot", 2, "scr"), ("usage_event", 3, "usg"), ("windows_notification", 4, "wnotif"),
            ("android_notification", 5, "anotif"), ("call", 6, "call"), ("message_batch", 7, "msg"), ("manifest", 8, "blob"),
            ("blob_chunk", 9, "blob"), ("command", 0x0a, "cmd"), ("command_status", 0x0b, "cstat"), ("device_report", 0x0c, "status"),
            ("pairing_device", 0x0d, "pair"),
            ("line_account", 0x0e, "lineacct"),
        };
        foreach (var (name, id, prefix) in expected)
        {
            var k = Kinds.FromWireName(name);
            Assert.Equal(id, k.Id());
            Assert.Equal(prefix, k.Prefix());
            Assert.Equal(k, Kinds.FromId(id));
        }
        Assert.Equal(expected.Length, Enum.GetValues<Kind>().Length);
        Assert.Throws<IvyCryptoException>(() => Kinds.FromId(0x7f));
    }

    [Fact]
    public void Key_builders_and_parser()
    {
        const string oid = "01HZZZ0000000000000000000A";
        Assert.Equal("up/file/" + oid, ObjectKeys.Up(Kind.FileMeta, oid));
        Assert.Equal("up/scr/" + oid, ObjectKeys.Up(Kind.Screenshot, oid));
        Assert.Equal("up/blob/" + oid + "/manifest", ObjectKeys.BlobManifest(oid));
        Assert.Equal("up/blob/" + oid + "/p/00000042", ObjectKeys.BlobChunk(oid, 42));
        Assert.Equal("up/cstat/x", ObjectKeys.CommandStatus("x"));
        Assert.Equal("up/status/x", ObjectKeys.DeviceReport("x"));
        Assert.Equal("cmd/x", ObjectKeys.Command("x"));
        Assert.Equal("pair/pid", ObjectKeys.PairingBootstrap("pid"));
        Assert.Equal("pair/pid/device", ObjectKeys.PairingDevice("pid"));
        Assert.Throws<ArgumentException>(() => ObjectKeys.Up(Kind.Manifest, oid));
        Assert.Throws<ArgumentException>(() => ObjectKeys.Up(Kind.PairingDevice, oid));

        Assert.Equal(new ParsedKey(KeyArea.Up, Kind.FileMeta, oid), ObjectKeys.Parse("up/file/" + oid));
        Assert.Equal(new ParsedKey(KeyArea.Up, Kind.Manifest, oid, IsManifest: true), ObjectKeys.Parse(ObjectKeys.BlobManifest(oid)));
        Assert.Equal(new ParsedKey(KeyArea.Up, Kind.BlobChunk, oid, ChunkIndex: 42), ObjectKeys.Parse(ObjectKeys.BlobChunk(oid, 42)));
        Assert.Equal(new ParsedKey(KeyArea.Up, Kind.CommandStatus, "x"), ObjectKeys.Parse("up/cstat/x"));
        Assert.Equal(new ParsedKey(KeyArea.Up, Kind.DeviceReport, "x"), ObjectKeys.Parse("up/status/x"));
        Assert.Equal(new ParsedKey(KeyArea.Cmd, Kind.Command, oid), ObjectKeys.Parse("cmd/" + oid));
        Assert.Equal(new ParsedKey(KeyArea.Pair, PairingId: "pid"), ObjectKeys.Parse("pair/pid"));
        Assert.Equal(new ParsedKey(KeyArea.Pair, Kind.PairingDevice, PairingId: "pid"), ObjectKeys.Parse("pair/pid/device"));
        foreach (var bad in new[] { "nope/x", "up/zzz/x", "up/blob/x/q", "cmd/", "pair/a/b", "up/file/x/y" })
            Assert.Throws<FormatException>(() => ObjectKeys.Parse(bad));
    }

    [Fact]
    public void Base64url_matches_node()
    {
        Assert.Equal("-_8", Bytes.ToBase64Url(new byte[] { 0xfb, 0xff }));
        Assert.Equal(new byte[] { 0xfb, 0xff }, Bytes.FromBase64Url("-_8"));
        Assert.Equal(new byte[] { 0xfb, 0xff }, Bytes.FromBase64Url("-_8="));
    }

    [Fact]
    public void Iso_time_matches_toISOString()
    {
        Assert.Equal("2026-10-10T03:04:05.006Z", IvyTime.Format(new DateTimeOffset(2026, 10, 10, 5, 4, 5, 6, TimeSpan.FromHours(2))));
    }
}

public class RecordTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void File_meta_field_names_order_and_optional_omission()
    {
        var r = new FileMetaRecord
        {
            DeviceId = "dev", EventTime = "2026-10-10T00:00:00.000Z", CaptureTime = "2026-10-10T00:00:01.000Z",
            Path = @"C:\Users\b\a.pdf", Name = "a.pdf", Size = 12, Ext = "pdf", Mtime = "2026-10-09T00:00:00.000Z", QuickHash = "abc",
        };
        r.Validate();
        var json = IvyJson.Serialize(r);
        Assert.StartsWith("{\"v\":1,\"kind\":\"file_meta\",\"deviceId\":\"dev\",\"eventTime\":", json);
        var o = Obj(json);
        Assert.Equal(new[] { "v", "kind", "deviceId", "eventTime", "captureTime", "path", "name", "size", "ext", "mtime", "quickHash" }, o.Select(p => p.Key));
        Assert.NotEqual(o["eventTime"]!.GetValue<string>(), o["captureTime"]!.GetValue<string>());
        var back = RecordJson.Parse<FileMetaRecord>(Bytes.Utf8.GetBytes(json));
        Assert.Equal(r, back);
    }

    [Fact]
    public void File_meta_deletion_omits_size_mtime_quickhash_and_sets_deleted()
    {
        const string t = "2026-10-10T00:00:00.000Z";
        var del = new FileMetaRecord { DeviceId = "d", EventTime = t, CaptureTime = t, Path = @"C:\a.pdf", Name = "a.pdf", Ext = "pdf", Deleted = true };
        del.Validate();
        var o = Obj(IvyJson.Serialize(del));
        Assert.True(o["deleted"]!.GetValue<bool>());
        Assert.False(o.ContainsKey("size"));
        Assert.False(o.ContainsKey("mtime"));
        Assert.False(o.ContainsKey("quickHash"));
        Assert.Equal(del, RecordJson.Parse<FileMetaRecord>(Bytes.Utf8.GetBytes(IvyJson.Serialize(del))));

        // A live record must still carry size/mtime/quickHash.
        Assert.Throws<RecordValidationException>(() =>
            new FileMetaRecord { DeviceId = "d", EventTime = t, CaptureTime = t, Path = "p", Name = "n", Ext = "x" }.Validate());
        // A live record never writes the deleted flag.
        var live = new FileMetaRecord { DeviceId = "d", EventTime = t, CaptureTime = t, Path = "p", Name = "n", Ext = "x", Size = 1, Mtime = t, QuickHash = "q" };
        Assert.False(Obj(IvyJson.Serialize(live)).ContainsKey("deleted"));
    }

    [Fact]
    public void Usage_event_title_is_string_null_or_absent()
    {
        const string t = "2026-10-10T00:00:00.000Z";
        UsageEventRecord Make() => new() { DeviceId = "d", EventTime = t, CaptureTime = t, App = "a", StartedAt = t, EndedAt = t };

        var captured = Make() with { Title = "Report" };
        Assert.Equal("Report", Obj(IvyJson.Serialize(captured))["title"]!.GetValue<string>());

        var excluded = Make() with { TitleCaptured = true }; // captured but excluded → null
        var ox = Obj(IvyJson.Serialize(excluded));
        Assert.True(ox.ContainsKey("title"));
        Assert.Null(ox["title"]);

        var absent = Make(); // not captured → omitted
        Assert.False(Obj(IvyJson.Serialize(absent)).ContainsKey("title"));

        // Round-trips preserve the distinction.
        Assert.True(RecordJson.Parse<UsageEventRecord>(Bytes.Utf8.GetBytes(IvyJson.Serialize(excluded))).TitleCaptured);
        Assert.False(RecordJson.Parse<UsageEventRecord>(Bytes.Utf8.GetBytes(IvyJson.Serialize(absent))).TitleCaptured);
    }

    [Fact]
    public void Every_schema_serializes_with_ts_field_names()
    {
        const string t = "2026-10-10T00:00:00.000Z";
        IvyRecord[] records =
        {
            new ScreenshotRecord { DeviceId = "d", EventTime = t, CaptureTime = t, SourcePath = "p", Width = 10, Height = 20, Sha256 = "h", BlobOid = "o", TakenAt = t, SavedAt = t },
            new UsageEventRecord { DeviceId = "d", EventTime = t, CaptureTime = t, App = "a", Exe = "e", Title = "ti", StartedAt = t, EndedAt = t },
            new WindowsNotificationRecord { DeviceId = "d", EventTime = t, CaptureTime = t, App = "a", Title = "ti", Text = "x", Sender = "s", PostedAt = t },
            new CommandStatusRecord { DeviceId = "d", EventTime = t, CaptureTime = t, CommandId = "c", Status = "too_large", Detail = "x", ResultOid = "o", ReportedAt = t },
            new DeviceReportRecord { DeviceId = "d", EventTime = t, CaptureTime = t, Role = "windows", AppVersion = "1", QueueDepthTotal = 3, ReportedAt = t,
                Collectors = new[] { new CollectorStateRecord { Name = "files", Enabled = true, LastRunAt = t, Cursor = "c", QueueDepth = 3 } } },
            new PairingDeviceRecord { DeviceId = "d", EventTime = t, CaptureTime = t, Role = "windows", PairingId = "p", PublicKey = "k", Fingerprint = "f" },
        };
        var expectedFields = new Dictionary<string, string[]>
        {
            ["screenshot"] = new[] { "sourcePath", "width", "height", "sha256", "blobOid", "takenAt", "savedAt" },
            ["usage_event"] = new[] { "app", "exe", "title", "startedAt", "endedAt" },
            ["windows_notification"] = new[] { "app", "title", "text", "sender", "postedAt" },
            ["command_status"] = new[] { "commandId", "status", "detail", "resultOid", "reportedAt" },
            ["device_report"] = new[] { "role", "appVersion", "queueDepthTotal", "collectors", "reportedAt" },
            ["pairing_device"] = new[] { "role", "pairingId", "publicKey", "fingerprint" },
        };
        foreach (var r in records)
        {
            r.Validate();
            var o = Obj(IvyJson.Serialize<object>(r));
            Assert.Equal(new[] { "v", "kind", "deviceId", "eventTime", "captureTime" }.Concat(expectedFields[r.Kind]), o.Select(p => p.Key));
        }
        var report = Obj(IvyJson.Serialize(records[4]));
        Assert.Equal(new[] { "name", "enabled", "lastRunAt", "cursor", "queueDepth" }, report["collectors"]![0]!.AsObject().Select(p => p.Key));
    }

    [Fact]
    public void Command_params_union_reads_type_anywhere()
    {
        const string json = """
            {"captureTime":"t","params":{"path":"C:\\a.pdf","type":"file_request"},"v":1,"kind":"command","deviceId":"mac","eventTime":"t","commandId":"c1","issuedAt":"t"}
            """;
        var c = RecordJson.Parse<CommandRecord>(Bytes.Utf8.GetBytes(json));
        var f = Assert.IsType<FileRequestParams>(c.Params);
        Assert.Equal(@"C:\a.pdf", f.Path);

        var rescan = RecordJson.Parse<CommandRecord>(Bytes.Utf8.GetBytes(json.Replace("""{"path":"C:\\a.pdf","type":"file_request"}""", """{"type":"rescan","collector":"files","scope":"D:\\"}""")));
        Assert.Equal("files", Assert.IsType<RescanParams>(rescan.Params).Collector);

        var cfg = RecordJson.Parse<CommandRecord>(Bytes.Utf8.GetBytes(json.Replace("""{"path":"C:\\a.pdf","type":"file_request"}""", """{"type":"collector_config","collector":"usage","enabled":false,"settings":{"titles":false,"exclude":["x"]}}""")));
        var p = Assert.IsType<CollectorConfigParams>(cfg.Params);
        Assert.False(p.Enabled);
        Assert.Equal(JsonValueKind.Array, p.Settings!["exclude"].ValueKind);

        Assert.ThrowsAny<JsonException>(() => RecordJson.Parse<CommandRecord>(Bytes.Utf8.GetBytes(json.Replace("file_request", "format_disk"))));
        Assert.ThrowsAny<JsonException>(() => RecordJson.Parse<CommandRecord>(Bytes.Utf8.GetBytes(json.Replace(",\"commandId\":\"c1\"", ""))));

        var round = IvyJson.Serialize(c);
        Assert.Contains("\"params\":{\"type\":\"file_request\",\"path\":", round);
    }

    [Fact]
    public void Validation_rejects_bad_records()
    {
        const string t = "x";
        Assert.Throws<RecordValidationException>(() => new CommandStatusRecord { DeviceId = "d", EventTime = t, CaptureTime = t, CommandId = "c", Status = "maybe", ReportedAt = t }.Validate());
        Assert.Throws<RecordValidationException>(() => new FileMetaRecord { DeviceId = "", EventTime = t, CaptureTime = t, Path = "p", Name = "n", Size = 1, Ext = "", Mtime = t, QuickHash = "q" }.Validate());
        Assert.Throws<RecordValidationException>(() => new FileMetaRecord { DeviceId = "d", EventTime = t, CaptureTime = t, Path = "p", Name = "n", Size = -1, Ext = "", Mtime = t, QuickHash = "q" }.Validate());
        Assert.Throws<RecordValidationException>(() => (new FileMetaRecord { DeviceId = "d", EventTime = t, CaptureTime = t, Path = "p", Name = "n", Size = 1, Ext = "", Mtime = t, QuickHash = "q" } with { Kind = "screenshot" }).Validate());
        Assert.Throws<RecordValidationException>(() => new DeviceReportRecord { DeviceId = "d", EventTime = t, CaptureTime = t, Role = "mac", QueueDepthTotal = 0, ReportedAt = t, Collectors = Array.Empty<CollectorStateRecord>() }.Validate());
    }
}

public class ProtocolAdditionsTests
{
    // packages/protocol encryptChunkedObject({ objectId: 0x00*16, payloadKind: "file_original", plaintext: 0x00*10,
    // chunkSize: 8, commandId: "cmd-1", options: { contentKey: 0x00*32 } }).manifest, JSON.stringify'd.
    private const string TsManifestWithCommandId =
        """{"v":1,"objectId":"00000000000000000000000000000000","payloadKind":"file_original","totalSize":10,"chunkSize":8,"totalChunks":2,"cek":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","chunks":[{"index":0,"ctLen":56,"sha256":"14fbf7e709fa08a849f6f3a92feff3ed078d8336f1835c053500dba638ac7566"},{"index":1,"ctLen":50,"sha256":"156c28c54b0b3a4c6091ac3646f22388692c64b969678f480e87bc7a0c0d0feb"}],"commandId":"cmd-1"}""";

    [Fact]
    public void Manifest_commandId_serializes_like_the_reference_and_is_omitted_when_null()
    {
        var (_, pub) = X25519.GenerateKeyPair();
        ManifestRecord Build(string? commandId)
        {
            using var enc = new ChunkedEncryptor(pub, "01HZZZCHUNKED000000000000B", new byte[16], PayloadKinds.FileOriginal, 10, 8,
                new ChunkedTestInputs(ContentKey: new byte[32])) { CommandId = commandId };
            enc.EncryptChunk(0, new byte[8]);
            enc.EncryptChunk(1, new byte[2]);
            return enc.Finish().Manifest;
        }
        Assert.Equal(TsManifestWithCommandId, IvyJson.Serialize(Build("cmd-1")));
        var without = IvyJson.Serialize(Build(null));
        Assert.DoesNotContain("commandId", without);
        Assert.Equal(TsManifestWithCommandId.Replace(",\"commandId\":\"cmd-1\"", ""), without);
        Assert.Equal("cmd-1", IvyJson.Deserialize<ManifestRecord>(TsManifestWithCommandId).CommandId);
        Assert.Throws<ArgumentException>(() => new ChunkedEncryptor(pub, "01HZZZCHUNKED000000000000B", new byte[16], PayloadKinds.FileOriginal, 10, 8) { CommandId = "" });
    }

    [Fact]
    public void Device_report_import_progress_fields_and_validation()
    {
        const string t = "2026-10-10T08:00:00.000Z";
        DeviceReportRecord Report(params CollectorStateRecord[] c) => new() { DeviceId = "d", EventTime = t, CaptureTime = t, Role = "windows", QueueDepthTotal = 0, ReportedAt = t, Collectors = c };
        var r = Report(
            new CollectorStateRecord { Name = "files", Enabled = true, QueueDepth = 0, ImportTotal = 1200, ImportDone = 300, Phase = ImportPhases.Initial },
            new CollectorStateRecord { Name = "usage", Enabled = true, QueueDepth = 0 });
        r.Validate();
        var json = IvyJson.Serialize(r);
        Assert.Contains("""{"name":"files","enabled":true,"queueDepth":0,"importTotal":1200,"importDone":300,"phase":"initial"}""", json);
        Assert.Contains("""{"name":"usage","enabled":true,"queueDepth":0}""", json); // absent when unknown
        var back = RecordJson.Parse<DeviceReportRecord>(Bytes.Utf8.GetBytes(json));
        Assert.Equal(300, back.Collectors[0].ImportDone);
        Assert.Equal("initial", back.Collectors[0].Phase);
        Assert.Throws<RecordValidationException>(() => Report(new CollectorStateRecord { Name = "files", Enabled = true, QueueDepth = 0, Phase = "bulk" }).Validate());
        Assert.Throws<RecordValidationException>(() => Report(new CollectorStateRecord { Name = "files", Enabled = true, QueueDepth = 0, ImportTotal = -1 }).Validate());
        Assert.Throws<RecordValidationException>(() => Report(new CollectorStateRecord { Name = "files", Enabled = true, QueueDepth = 0, ImportDone = -1 }).Validate());
        Assert.All(new[] { "initial", "incremental", "rescan" }, p => Assert.True(ImportPhases.IsValid(p)));
    }
}
