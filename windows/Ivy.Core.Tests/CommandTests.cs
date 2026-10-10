using System.Text;
using Ivy.Core.Commands;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;

namespace Ivy.Core.Tests;

public class CommandPollerTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    private readonly FakeBucketServer _server = new();
    private readonly FileKeyStore _keys;
    private readonly byte[] _devicePub;
    public CommandPollerTests()
    {
        _keys = new FileKeyStore(_dir.Sub("keys"));
        var (sk, pk) = X25519.GenerateKeyPair();
        _keys.StoreSecretKey(sk);
        _devicePub = pk;
    }
    public void Dispose() => _dir.Dispose();

    private string PutCommand(CommandParams ps, string? commandId = null, byte[]? recipient = null, string? key = null, string? deviceId = null)
    {
        var oid = Oids.New();
        key ??= ObjectKeys.Command(oid);
        var cmd = new CommandRecord
        {
            DeviceId = deviceId ?? "dev-1", EventTime = IvyTime.Now(), CaptureTime = IvyTime.Now(), CommandId = commandId ?? Guid.NewGuid().ToString(),
            IssuedAt = IvyTime.Now(), Params = ps,
        };
        _server.Cmd[key] = Envelope.Encrypt(recipient ?? _devicePub, Kind.Command, key, IvyJson.SerializeToUtf8(cmd));
        return cmd.CommandId;
    }

    private FakeCmdClient? _lastCmd;

    private (CommandPoller Poller, AgentProcess P, RecordSink Sink) Make(IRescanHandler? rescan = null, FileRequestOptions? fr = null)
    {
        var p = new AgentProcess(_dir.Sub("data"));
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity, new RecordSinkOptions { ChunkSize = 1024 });
        var files = new FileRequestHandler(sink, new FileCacheLocator(new FileCacheStore(p.Db)), fr);
        _lastCmd = new FakeCmdClient(_server);
        var poller = new CommandPoller(_lastCmd, _keys, new ExecutedCommandStore(p.Db), sink, files, rescan, activity: p.Activity);
        return (poller, p, sink);
    }

    private List<CommandStatusRecord> Statuses(AgentProcess p) => p.Queue.All()
        .Where(i => i.Kind == "command_status")
        .Select(i => RecordJson.Parse<CommandStatusRecord>(_mac.Open(i.ObjectKey, File.ReadAllBytes(p.Queue.FullPathOf(i)), Kind.CommandStatus)))
        .ToList();

    [Fact]
    public async Task File_request_round_trip_and_statuses()
    {
        var file = _dir.Sub("invoice.pdf");
        var data = new byte[3000];
        Random.Shared.NextBytes(data);
        File.WriteAllBytes(file, data);
        File.WriteAllBytes(_dir.Sub("big.bin"), new byte[5000]);
        var ok = PutCommand(new FileRequestParams { Path = file });
        var missing = PutCommand(new FileRequestParams { Path = _dir.Sub("nope.pdf") });
        var big = PutCommand(new FileRequestParams { Path = _dir.Sub("big.bin") });
        var neither = PutCommand(new FileRequestParams());

        var (poller, p, _) = Make(fr: new FileRequestOptions { MaxBytes = 4000 });
        using (p)
        {
            var r = await poller.PollOnceAsync();
            Assert.Equal(new PollResult(4, 4, 0, 0), r);
            var st = Statuses(p).ToDictionary(s => s.CommandId);
            Assert.Equal(CommandStatusValues.Uploaded, st[ok].Status);
            Assert.Equal(CommandStatusValues.NotFound, st[missing].Status);
            Assert.Equal(CommandStatusValues.TooLarge, st[big].Status);
            Assert.Equal(CommandStatusValues.NotFound, st[neither].Status);
            Assert.All(st.Values, s => Assert.Equal("dev-1", s.DeviceId));

            // the uploaded status comes after its blob in the same ordering group
            var items = p.Queue.All();
            var blobOid = st[ok].ResultOid!;
            var group = items.Where(i => i.GroupKey == blobOid).ToList();
            Assert.Equal(ObjectKeys.BlobManifest(blobOid), group[0].ObjectKey);
            Assert.Equal("command_status", group[^1].Kind);
            var parts = group.Where(i => i.Kind == "blob_chunk").ToDictionary(i => ObjectKeys.Parse(i.ObjectKey).ChunkIndex!.Value, i => File.ReadAllBytes(p.Queue.FullPathOf(i)));
            var (manifest, plain) = Chunked.Decrypt(_mac.SecretKey, group[0].ObjectKey, File.ReadAllBytes(p.Queue.FullPathOf(group[0])), parts);
            Assert.Equal(data, plain);
            Assert.Equal("file_original", manifest.PayloadKind);
            Assert.Equal(ok, manifest.CommandId); // §2.2: the original names its command

            // second poll: everything already executed, nothing fetched again
            var getsBefore = _lastCmd!.Gets;
            var again = await poller.PollOnceAsync();
            Assert.Equal(new PollResult(4, 0, 4, 0), again);
            Assert.Equal(4, Statuses(p).Count);
            Assert.Equal(getsBefore, _lastCmd.Gets);
        }
    }

    [Fact]
    public async Task Executed_commands_survive_restart_and_duplicate_ids_are_ignored()
    {
        var id = PutCommand(new FileRequestParams { Path = "/nope" });
        var (poller, p, _) = Make();
        using (p) await poller.PollOnceAsync();
        PutCommand(new FileRequestParams { Path = "/nope" }, commandId: id); // same commandId under a new key
        var (poller2, p2, _) = Make();
        using (p2)
        {
            var r = await poller2.PollOnceAsync();
            Assert.Equal(new PollResult(2, 0, 2, 0), r);
            Assert.Single(Statuses(p2));
        }
    }

    [Fact]
    public async Task Undecryptable_relocated_or_foreign_commands_are_rejected_once()
    {
        var other = X25519.GenerateKeyPair();
        PutCommand(new FileRequestParams { Path = "/x" }, recipient: other.PublicKey); // not for us
        var k = ObjectKeys.Command(Oids.New());
        PutCommand(new FileRequestParams { Path = "/x" }, key: k);
        _server.Cmd[ObjectKeys.Command(Oids.New())] = _server.Cmd[k]; // copied to another key
        _server.Cmd.TryRemove(k, out _);
        _server.Cmd["cmd/garbage"] = new byte[200];
        var (poller, p, _) = Make();
        using (p)
        {
            Assert.Equal(new PollResult(3, 0, 0, 3), await poller.PollOnceAsync());
            Assert.Empty(Statuses(p));
            Assert.Equal(new PollResult(3, 0, 3, 0), await poller.PollOnceAsync());
            Assert.Contains(p.Activity.Recent(), e => e.Event == ActivityEvents.CommandRejected);
        }
    }

    private sealed class RecordingRescan : IRescanHandler
    {
        public List<RescanParams> Seen { get; } = new();
        public Task<CommandOutcome> HandleRescanAsync(CommandRecord command, RescanParams p, CancellationToken ct)
        {
            Seen.Add(p);
            return Task.FromResult(CommandOutcome.Done("rescan scheduled"));
        }
    }

    [Fact]
    public async Task Command_for_other_device_reports_error_and_is_recorded_executed()
    {
        var rescan = new RecordingRescan();
        var id = PutCommand(new RescanParams { Collector = "files" }, deviceId: "someone-else");
        var (poller, p, _) = Make(rescan);
        using (p)
        {
            var r1 = await poller.PollOnceAsync();
            Assert.Equal(1, r1.Executed);
            var st = Assert.Single(Statuses(p));
            Assert.Equal(id, st.CommandId);
            Assert.Equal(CommandStatusValues.Error, st.Status);
            Assert.Empty(rescan.Seen);
            var r2 = await poller.PollOnceAsync();
            Assert.Equal(0, r2.Executed);
            Assert.Single(Statuses(p));
        }
    }

    [Fact]
    public async Task Rescan_and_config_dispatch_or_report_missing_handler()
    {
        var rescanId = PutCommand(new RescanParams { Collector = "files", Scope = "D:\\" });
        var cfgId = PutCommand(new CollectorConfigParams { Collector = "usage", Enabled = false });
        var rescan = new RecordingRescan();
        var (poller, p, _) = Make(rescan);
        using (p)
        {
            await poller.PollOnceAsync();
            var st = Statuses(p).ToDictionary(s => s.CommandId);
            Assert.Equal(CommandStatusValues.Done, st[rescanId].Status);
            Assert.Equal("files", Assert.Single(rescan.Seen).Collector);
            Assert.Equal(CommandStatusValues.Error, st[cfgId].Status);
            Assert.Contains("no handler", st[cfgId].Detail);
        }
    }

    [Fact]
    public async Task Access_denied_is_reported()
    {
        if (OperatingSystem.IsWindows()) return; // chmod semantics; DPAPI/ACL behaviour is reviewed on Windows
        var file = _dir.Sub("secret.pdf");
        File.WriteAllBytes(file, new byte[10]);
        File.SetUnixFileMode(file, UnixFileMode.None);
        try
        {
            var id = PutCommand(new FileRequestParams { Path = file });
            var (poller, p, _) = Make();
            using (p)
            {
                await poller.PollOnceAsync();
                Assert.Equal(CommandStatusValues.AccessDenied, Statuses(p).Single(s => s.CommandId == id).Status);
            }
        }
        finally
        {
            File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    [Fact]
    public async Task File_id_resolves_through_file_cache_and_allowed_roots_are_enforced()
    {
        var file = _dir.Sub("a.txt");
        File.WriteAllText(file, "hello");
        var (poller, p, _) = Make(fr: new FileRequestOptions { AllowedRoots = new[] { _dir.Sub("allowed") } });
        using (p)
        {
            new FileCacheStore(p.Db).Upsert(new FileCacheRow(file, "q", "t", "t", "FILE-1"));
            var byId = PutCommand(new FileRequestParams { FileId = "FILE-1" });
            await poller.PollOnceAsync();
            Assert.Equal(CommandStatusValues.AccessDenied, Statuses(p).Single(s => s.CommandId == byId).Status);
        }
        var (poller2, p2, _) = Make();
        using (p2)
        {
            var byId2 = PutCommand(new FileRequestParams { FileId = "FILE-1" });
            await poller2.PollOnceAsync();
            Assert.Equal(CommandStatusValues.Uploaded, Statuses(p2).Single(s => s.CommandId == byId2).Status);
        }
    }
}

public class KeyStoreTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void File_key_store_round_trips_and_clears()
    {
        var ks = new FileKeyStore(_dir.Path);
        Assert.False(ks.HasSecretKey);
        Assert.Throws<InvalidOperationException>(() => ks.LoadSecretKey());
        var (sk, _) = X25519.GenerateKeyPair();
        ks.StoreSecretKey(sk);
        Assert.Equal(sk, new FileKeyStore(_dir.Path).LoadSecretKey());
        ks.StoreCredentials(new DeviceCredentials { CmdReadToken = "a:b", UpWriteToken = "c:d" });
        Assert.Equal("c:d", new FileKeyStore(_dir.Path).LoadCredentials()!.UpWriteToken);
        Assert.Throws<ArgumentException>(() => ks.StoreSecretKey(new byte[31]));
        ks.Clear();
        Assert.False(ks.HasSecretKey);
        Assert.Null(ks.LoadCredentials());
        Assert.Null(ks.LoadPairingState());
    }

    [Fact]
    public void Default_store_is_dpapi_on_windows_only()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.IsType<DpapiKeyStore>(DeviceKeyStores.CreateDefault(_dir.Path));
            return;
        }
        Assert.Throws<PlatformNotSupportedException>(() => DeviceKeyStores.CreateDefault(_dir.Path));
        Assert.IsType<FileKeyStore>(DeviceKeyStores.CreateDefault(_dir.Path, allowInsecureTestStore: true));
#pragma warning disable CA1416 // exercising the guard on a non-Windows host on purpose
        Assert.Throws<PlatformNotSupportedException>(() => new DpapiKeyStore(_dir.Path));
#pragma warning restore CA1416
    }
}
