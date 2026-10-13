using System.Text;
using System.Text.Json;
using Ivy.Core.Agent;
using Ivy.Core.Commands;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.R2;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;
using Ivy.Core.Upload;

namespace Ivy.Core.Tests;

/// <summary>The <c>unpair</c> command: parsing, poller sequencing, and the full reset through <see cref="VaultAgent"/>.</summary>
public class UnpairCommandTests : IDisposable
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(30);
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    private readonly FakeBucketServer _server = new();
    public void Dispose() => _dir.Dispose();

    // ---- parsing ----

    [Fact]
    public void Unpair_params_parse_and_round_trip()
    {
        var p = JsonSerializer.Deserialize<CommandParams>("""{ "type": "unpair" }""", IvyJson.Options);
        var u = Assert.IsType<UnpairParams>(p);
        Assert.Equal("unpair", u.Type);
        Assert.Equal(UnpairParams.TypeName, u.Type);

        var now = IvyTime.Now();
        var cmd = new CommandRecord { DeviceId = "dev-1", EventTime = now, CaptureTime = now, CommandId = "c-1", IssuedAt = now, Params = new UnpairParams() };
        var json = IvyJson.SerializeToUtf8(cmd);
        using (var doc = JsonDocument.Parse(json))
        {
            var ps = doc.RootElement.GetProperty("params");
            Assert.Equal("unpair", ps.GetProperty("type").GetString());
            Assert.Single(ps.EnumerateObject()); // no other fields
        }
        var back = RecordJson.Parse<CommandRecord>(json);
        Assert.IsType<UnpairParams>(back.Params);
        Assert.Equal("c-1", back.CommandId);
    }

    [Fact]
    public void Unknown_type_still_throws()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<CommandParams>("""{ "type": "self_destruct" }""", IvyJson.Options));
    }

    // ---- poller sequencing (fake handler) ----

    private sealed class PollerRig : IDisposable
    {
        public PollerRig(TempDir dir, MacSim mac, FakeBucketServer server, IUnpairHandler? handler)
        {
            Keys = new FileKeyStore(dir.Sub("keys"));
            var (sk, pk) = X25519.GenerateKeyPair();
            Keys.StoreSecretKey(sk);
            DevicePub = pk;
            P = new AgentProcess(dir.Sub("data"));
            Sink = new RecordSink(P.Queue, mac.PublicKey, "dev-1", P.Activity);
            Executed = new ExecutedCommandStore(P.Db);
            var files = new FileRequestHandler(Sink, new FileCacheLocator(new FileCacheStore(P.Db)));
            Poller = new CommandPoller(new FakeCmdClient(server), Keys, Executed, Sink, files, activity: P.Activity) { UnpairHandler = handler };
        }
        public FileKeyStore Keys { get; }
        public byte[] DevicePub { get; }
        public AgentProcess P { get; }
        public RecordSink Sink { get; }
        public ExecutedCommandStore Executed { get; }
        public CommandPoller Poller { get; }
        public void Dispose() => P.Dispose();
    }

    private static string PutCommand(FakeBucketServer server, byte[] devicePub, CommandParams ps, string deviceId = "dev-1", string? key = null)
    {
        key ??= ObjectKeys.Command(Oids.New());
        var now = IvyTime.Now();
        var cmd = new CommandRecord { DeviceId = deviceId, EventTime = now, CaptureTime = now, CommandId = Guid.NewGuid().ToString(), IssuedAt = now, Params = ps };
        server.Cmd[key] = Envelope.Encrypt(devicePub, Kind.Command, key, IvyJson.SerializeToUtf8(cmd));
        return cmd.CommandId;
    }

    private List<CommandStatusRecord> QueuedStatuses(UploadQueue q) => q.All()
        .Where(i => i.Kind == "command_status")
        .Select(i => RecordJson.Parse<CommandStatusRecord>(_mac.Open(i.ObjectKey, File.ReadAllBytes(q.FullPathOf(i)), Kind.CommandStatus)))
        .ToList();

    private sealed class CheckingUnpairHandler : IUnpairHandler
    {
        public Func<CommandRecord, bool>? Check { get; set; }
        public List<(string CommandId, bool StatusWasQueued)> Calls { get; } = new();
        public Exception? Throw { get; set; }
        public Task HandleUnpairAsync(CommandRecord command, CancellationToken ct)
        {
            Calls.Add((command.CommandId, Check!(command)));
            if (Throw is not null) throw Throw;
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task Poller_enqueues_done_status_before_calling_the_handler()
    {
        var handler = new CheckingUnpairHandler();
        using var rig = new PollerRig(_dir, _mac, _server, handler);
        handler.Check = c =>
            QueuedStatuses(rig.P.Queue).Any(s => s.CommandId == c.CommandId && s.Status == CommandStatusValues.Done)
            && rig.Executed.IsExecutedCommandId(c.CommandId);
        var id = PutCommand(_server, rig.DevicePub, new UnpairParams());

        var r = await rig.Poller.PollOnceAsync();

        Assert.Equal(1, r.Executed);
        var call = Assert.Single(handler.Calls);
        Assert.Equal(id, call.CommandId);
        Assert.True(call.StatusWasQueued, "the done status must be queued (and the command recorded) before the handler runs");
        var st = Assert.Single(QueuedStatuses(rig.P.Queue));
        Assert.Equal(CommandStatusValues.Done, st.Status);
        Assert.Equal("unpaired by the Mac", st.Detail);

        // the same object is not run again
        Assert.Equal(new PollResult(1, 0, 1, 0), await rig.Poller.PollOnceAsync());
        Assert.Single(handler.Calls);
    }

    [Fact]
    public async Task Poller_swallows_handler_failure_and_reports_once()
    {
        var handler = new CheckingUnpairHandler { Check = _ => true, Throw = new InvalidOperationException("boom") };
        using var rig = new PollerRig(_dir, _mac, _server, handler);
        PutCommand(_server, rig.DevicePub, new UnpairParams());
        var r = await rig.Poller.PollOnceAsync();
        Assert.Equal(1, r.Executed);
        Assert.Equal(CommandStatusValues.Done, Assert.Single(QueuedStatuses(rig.P.Queue)).Status);
    }

    [Fact]
    public async Task Poller_without_unpair_handler_reports_error_once()
    {
        using var rig = new PollerRig(_dir, _mac, _server, handler: null);
        var id = PutCommand(_server, rig.DevicePub, new UnpairParams());
        await rig.Poller.PollOnceAsync();
        var st = Assert.Single(QueuedStatuses(rig.P.Queue));
        Assert.Equal(id, st.CommandId);
        Assert.Equal(CommandStatusValues.Error, st.Status);
        Assert.Contains("no handler", st.Detail);
    }

    [Fact]
    public async Task Poller_stops_processing_further_commands_after_unpair()
    {
        var handler = new CheckingUnpairHandler { Check = _ => true };
        using var rig = new PollerRig(_dir, _mac, _server, handler);
        // keys are listed in order: the unpair sorts first, a file request after it
        var a = ObjectKeys.Command(Oids.New());
        var b = ObjectKeys.Command(Oids.New());
        var (unpairKey, laterKey) = string.CompareOrdinal(a, b) < 0 ? (a, b) : (b, a);
        PutCommand(_server, rig.DevicePub, new UnpairParams(), key: unpairKey);
        PutCommand(_server, rig.DevicePub, new FileRequestParams { Path = "/nope" }, key: laterKey);

        var r = await rig.Poller.PollOnceAsync();

        Assert.Equal(1, r.Executed);
        Assert.Single(QueuedStatuses(rig.P.Queue));
        Assert.True(rig.Executed.IsExecutedKey(unpairKey));
        Assert.False(rig.Executed.IsExecutedKey(laterKey));
    }

    [Fact]
    public async Task Unknown_command_type_still_reports_error()
    {
        using var rig = new PollerRig(_dir, _mac, _server, new CheckingUnpairHandler { Check = _ => true });
        var key = ObjectKeys.Command(Oids.New());
        var now = IvyTime.Now();
        var cmd = new CommandRecord { DeviceId = "dev-1", EventTime = now, CaptureTime = now, CommandId = "c-unknown", IssuedAt = now, Params = new RescanParams { Collector = "files" } };
        var json = Encoding.UTF8.GetString(IvyJson.SerializeToUtf8(cmd));
        Assert.Contains("\"type\":\"rescan\"", json);
        json = json.Replace("\"type\":\"rescan\"", "\"type\":\"wipe_everything\"");
        _server.Cmd[key] = Envelope.Encrypt(rig.DevicePub, Kind.Command, key, Encoding.UTF8.GetBytes(json));

        var r = await rig.Poller.PollOnceAsync();

        Assert.Equal(1, r.Rejected);
        var st = Assert.Single(QueuedStatuses(rig.P.Queue));
        Assert.Equal("c-unknown", st.CommandId);
        Assert.Equal(CommandStatusValues.Error, st.Status);
        Assert.Contains("unknown command type", st.Detail);
    }

    // ---- full path through VaultAgent ----

    /// <summary>Up-client hooks: runs <see cref="BeforePut"/> before every put (may throw to fail it).</summary>
    private sealed class HookedFactory : IR2ClientFactory
    {
        private readonly FakeBucketServer _server;
        public HookedFactory(FakeBucketServer server) => _server = server;
        public Action<string>? BeforePut { get; set; }
        public IUpBucketClient CreateUpClient(R2Endpoint endpoint, string bucket, ScopedToken writeToken) =>
            new FakeUpClient(_server) { BeforePut = k => BeforePut?.Invoke(k) };
        public ICmdBucketClient CreateCmdClient(R2Endpoint endpoint, string bucket, ScopedToken readToken) => new FakeCmdClient(_server);
    }

    private string MacPrepares()
    {
        var secret = SystemRandomSource.Instance.Bytes(32);
        var pairingId = Bytes.ToHex(SystemRandomSource.Instance.Bytes(16));
        var sealedBootstrap = PairingCodec.SealBootstrap(new BootstrapPayload { UpBucket = "ivy-up-windows", UpWriteToken = "up-key:up-secret", PairingId = pairingId }, secret);
        _server.Cmd[ObjectKeys.PairingBootstrap(pairingId)] = IvyJson.SerializeToUtf8(sealedBootstrap);
        return PairingCodec.Encode(new PairingPayload
        {
            R2Endpoint = "http://127.0.0.1:1", Role = "windows", CmdBucket = "ivy-cmd-windows", UpBucket = "ivy-up-windows",
            CmdReadToken = "cmd-key:cmd-secret", MacPublicKey = _mac.PublicKeyB64, MacFingerprint = _mac.Fingerprint,
            PairingId = pairingId, Secret = Bytes.ToBase64(secret), Exp = DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeMilliseconds(),
        });
    }

    private VaultAgent NewAgent(IR2ClientFactory factory) => new(new VaultAgentOptions
    {
        DataDirectory = _dir.Sub("agent"),
        Poller = new CommandPollerOptions { Interval = TimeSpan.FromHours(1) },
        Reporter = new DeviceReporterOptions { Interval = TimeSpan.FromHours(1), AppVersion = "test" },
        Uploader = new UploaderOptions { IdlePoll = TimeSpan.FromMilliseconds(100) },
        Backoff = new BackoffPolicy { BaseDelay = TimeSpan.FromHours(1) },
    }, new FileKeyStore(_dir.Sub("agent-keys")), factory);

    private string PutUnpair(PairingState device) => PutCommand(_server, Bytes.FromBase64(device.DevicePublicKey), new UnpairParams(), device.DeviceId);

    private WindowsNotificationRecord Notification(string deviceId)
    {
        var now = IvyTime.Now();
        return new WindowsNotificationRecord { DeviceId = deviceId, EventTime = now, CaptureTime = now, App = "app", Title = "backlog", Text = "backlog", PostedAt = now };
    }

    private List<CommandStatusRecord> UploadedStatuses() => _server.Up
        .Where(kv => kv.Key.StartsWith("up/cstat/", StringComparison.Ordinal))
        .Select(kv => RecordJson.Parse<CommandStatusRecord>(_mac.Open(kv.Key, kv.Value, Kind.CommandStatus)))
        .ToList();

    private static void SeedLocalState(VaultAgent agent)
    {
        agent.Collectors.SetEnabled("files", false);
        agent.Collectors.RecordRun("files", DateTimeOffset.UtcNow, "cursor-1", new ImportProgress(10, 5, "scanning"));
        agent.Collectors.RecordRun("usage", DateTimeOffset.UtcNow, "cursor-2");
        agent.FileCache.Upsert(new FileCacheRow(@"C:\a.txt", "q", "t", "t", "FILE-1"));
    }

    private static void AssertReset(VaultAgent agent)
    {
        Assert.False(agent.Keys.HasSecretKey);
        Assert.Null(agent.Keys.LoadCredentials());
        Assert.Null(agent.Keys.LoadPairingState());
        Assert.False(agent.Pairing.IsPaired);
        Assert.Null(agent.PairingState);
        Assert.Null(agent.Sink);
        Assert.Null(agent.Uploader);
        Assert.Null(agent.Poller);
        Assert.Null(agent.Reporter);
        Assert.False(agent.IsRunning);
        Assert.Empty(agent.Queue.All());
        Assert.Empty(Directory.EnumerateFiles(agent.Queue.QueueDirectory));
        foreach (var row in agent.Collectors.All())
        {
            Assert.Null(row.Cursor);
            Assert.Null(row.LastRunAt);
            Assert.Null(row.Import);
        }
        Assert.False(agent.Collectors.Get("files")!.Enabled); // the enabled flag is kept
        Assert.Equal(0, agent.FileCache.Count());
        Assert.True(agent.FirstPollCompleted.IsCompleted);
        Assert.Contains(agent.Activity.Recent(), e => e.Event == ActivityEvents.Unpaired);
    }

    [Fact]
    public async Task Unpair_command_resets_the_running_agent()
    {
        var factory = new HookedFactory(_server);
        await using var agent = NewAgent(factory);
        await agent.StartAsync();
        var first = await agent.PairAsync(MacPrepares());
        await agent.FirstPollCompleted.WaitAsync(Wait);
        var device = agent.PairingState!;
        SeedLocalState(agent);

        // A backlog record whose first upload attempt fails, so it sits in the queue (1 h backoff) when the unpair arrives.
        var failedOnce = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopCalled = false;
        var stopCalledBeforeStatusPut = false;
        string? backlogKey = null;
        var backlogGoneBeforeStatusPut = false;
        factory.BeforePut = k =>
        {
            if (k.StartsWith("up/wnotif/", StringComparison.Ordinal) && !failedOnce.Task.IsCompleted)
            {
                failedOnce.TrySetResult();
                throw new IOException("network down");
            }
            if (k.StartsWith("up/cstat/", StringComparison.Ordinal))
            {
                stopCalledBeforeStatusPut = stopCalled;
                backlogGoneBeforeStatusPut = backlogKey is not null && !agent.Queue.Contains(backlogKey);
            }
        };
        backlogKey = agent.Sink!.Enqueue(Notification(device.DeviceId), "notifications").ObjectKey;
        await failedOnce.Task.WaitAsync(Wait);
        Assert.True(agent.Queue.Contains(backlogKey));

        agent.StopCollectors = _ => { stopCalled = true; return Task.CompletedTask; };
        var unpaired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        agent.Unpaired += (_, _) => unpaired.TrySetResult();

        var id = PutUnpair(device);
        agent.Poller!.PollNow();
        await unpaired.Task.WaitAsync(Wait);

        Assert.True(stopCalled);
        Assert.True(stopCalledBeforeStatusPut, "collectors must be stopped before the status uploads");
        Assert.True(backlogGoneBeforeStatusPut, "the backlog must be dropped before the status uploads");
        var st = Assert.Single(UploadedStatuses(), s => s.CommandId == id);
        Assert.Equal(CommandStatusValues.Done, st.Status);
        Assert.Equal(device.DeviceId, st.DeviceId);
        Assert.DoesNotContain(_server.Up.Keys, k => k == backlogKey);
        Assert.DoesNotContain(_server.Up.Keys, k => k.StartsWith("up/wnotif/", StringComparison.Ordinal));
        AssertReset(agent);
        Assert.True(agent.ExecutedCommands.IsExecutedCommandId(id)); // kept, so the object is never re-run

        // re-pairing mints a new device id; the old unpair object is skipped, the agent stays paired
        factory.BeforePut = null;
        var again = await agent.PairAsync(MacPrepares());
        await agent.FirstPollCompleted.WaitAsync(Wait);
        Assert.NotEqual(first.DeviceId, again.DeviceId);
        Assert.True(agent.Pairing.IsPaired);
        Assert.Single(UploadedStatuses(), s => s.CommandId == id);
    }

    [Fact]
    public async Task Pending_unpair_at_start_is_handled_before_anything_uploads()
    {
        var factory = new HookedFactory(_server);
        string firstDeviceId;
        await using (var agent = NewAgent(factory))
        {
            await agent.StartAsync();
            firstDeviceId = (await agent.PairAsync(MacPrepares())).DeviceId;
            await agent.FirstPollCompleted.WaitAsync(Wait);
            SeedLocalState(agent);
        }

        // Offline: the app is closed, a backlog builds up, and the Mac writes the unpair command meanwhile.
        string backlogKey;
        string id;
        await using (var agent = NewAgent(factory))
        {
            var device = agent.Keys.LoadPairingState()!;
            var sink = new RecordSink(agent.Queue, device.MacPublicKeyBytes, device.DeviceId, agent.Activity);
            backlogKey = sink.Enqueue(Notification(device.DeviceId), "notifications").ObjectKey;
            id = PutUnpair(device);
            var putsBefore = _server.Up.Count;

            var stopCalled = false;
            agent.StopCollectors = _ => { stopCalled = true; return Task.CompletedTask; };
            var unpaired = false;
            agent.Unpaired += (_, _) => unpaired = true;

            await agent.StartAsync();
            await agent.FirstPollCompleted.WaitAsync(Wait);

            Assert.True(unpaired);
            Assert.True(stopCalled);
            Assert.DoesNotContain(_server.Up.Keys, k => k == backlogKey);
            Assert.DoesNotContain(_server.Up.Keys, k => k.StartsWith("up/wnotif/", StringComparison.Ordinal));
            Assert.Equal(CommandStatusValues.Done, Assert.Single(UploadedStatuses(), s => s.CommandId == id).Status);
            Assert.Equal(putsBefore + 1, _server.Up.Count); // only the status went out
            AssertReset(agent);

            // a second StartAsync while unpaired runs nothing
            await agent.StartAsync();
            Assert.False(agent.IsRunning);
            Assert.True(agent.FirstPollCompleted.IsCompleted);

            var again = await agent.PairAsync(MacPrepares());
            await agent.FirstPollCompleted.WaitAsync(Wait);
            Assert.NotEqual(firstDeviceId, again.DeviceId);
            Assert.True(agent.Pairing.IsPaired);
        }
    }
}
