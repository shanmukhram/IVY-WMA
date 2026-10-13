using Ivy.Core.Commands;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.R2;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Ivy.Core.Upload;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Core.Agent;

public sealed class VaultAgentOptions
{
    /// <summary>Directory holding <c>vault-agent.db</c> and <c>queue/</c>.</summary>
    public required string DataDirectory { get; init; }
    public UploaderOptions Uploader { get; init; } = new();
    public RecordSinkOptions Sink { get; init; } = new();
    public CommandPollerOptions Poller { get; init; } = new();
    public DeviceReporterOptions Reporter { get; init; } = new();
    public FileRequestOptions FileRequests { get; init; } = new();
    public BackoffPolicy Backoff { get; init; } = new();
}

/// <summary>
/// Composition root the WinUI app hosts: opens the database and queue, reconciles the queue, and — once
/// paired — runs the uploader, command poller and device reporter in the background.
/// </summary>
public sealed class VaultAgent : IAsyncDisposable, IUnpairHandler
{
    /// <summary>How long the uploader and reporter wait for the first command poll before starting anyway.</summary>
    public static readonly TimeSpan FirstPollTimeout = TimeSpan.FromSeconds(10);
    /// <summary>Upper bound for <see cref="StopCollectors"/> during an unpair command.</summary>
    public static readonly TimeSpan StopCollectorsTimeout = TimeSpan.FromSeconds(10);
    /// <summary>How long an unpair command waits for its <c>done</c> status to reach the up-bucket.</summary>
    public static readonly TimeSpan UnpairStatusDrainTimeout = TimeSpan.FromSeconds(20);

    private readonly VaultAgentOptions _options;
    private readonly IR2ClientFactory _factory;
    private readonly ILoggerFactory _loggers;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private CancellationTokenSource? _cts;
    private readonly List<Task> _loops = new();
    private readonly SemaphoreSlim _stopLock = new(1, 1);
    private int _unpairing;
    private Task? _pendingReset;

    public VaultAgent(VaultAgentOptions options, IDeviceKeyStore keys, IR2ClientFactory? factory = null, ILoggerFactory? loggers = null, TimeProvider? time = null)
    {
        _options = options;
        Keys = keys;
        _factory = factory ?? new S3R2ClientFactory();
        _loggers = loggers ?? NullLoggerFactory.Instance;
        _logger = _loggers.CreateLogger<VaultAgent>();
        _time = time ?? TimeProvider.System;
        Directory.CreateDirectory(options.DataDirectory);
        Db = new VaultDb(Path.Combine(options.DataDirectory, VaultDb.FileName));
        Activity = new ActivityLog(Db, _time);
        Queue = new UploadQueue(Db, Path.Combine(options.DataDirectory, "queue"), options.Backoff, _time, Activity, _loggers.CreateLogger<UploadQueue>());
        Collectors = new CollectorStateStore(Db);
        FileCache = new FileCacheStore(Db);
        ExecutedCommands = new ExecutedCommandStore(Db, _time);
        Pairing = new PairingService(keys, _factory, _time, activity: Activity, logger: _loggers.CreateLogger<PairingService>());
    }

    public IDeviceKeyStore Keys { get; }
    public VaultDb Db { get; }
    public ActivityLog Activity { get; }
    public UploadQueue Queue { get; }
    public CollectorStateStore Collectors { get; }
    public FileCacheStore FileCache { get; }
    public ExecutedCommandStore ExecutedCommands { get; }
    public PairingService Pairing { get; }

    public RecordSink? Sink { get; private set; }
    public Uploader? Uploader { get; private set; }
    public CommandPoller? Poller { get; private set; }
    public DeviceReporter? Reporter { get; private set; }
    public PairingState? PairingState { get; private set; }

    private IRescanHandler? _rescan;
    private ICollectorConfigHandler? _collectorConfig;
    private readonly List<IDisposable> _clients = new();

    /// <summary>Set by the collectors, before or after <see cref="StartAsync"/>; a running poller picks it up.</summary>
    public IRescanHandler? RescanHandler
    {
        get => _rescan;
        set { _rescan = value; if (Poller is not null) Poller.RescanHandler = value; }
    }

    /// <summary>Set by the collectors, before or after <see cref="StartAsync"/>; a running poller picks it up.</summary>
    public ICollectorConfigHandler? CollectorConfigHandler
    {
        get => _collectorConfig;
        set { _collectorConfig = value; if (Poller is not null) Poller.CollectorConfigHandler = value; }
    }

    /// <summary>
    /// Set by the app to stop every collector (called when the Mac sends <c>unpair</c>, bounded to
    /// <see cref="StopCollectorsTimeout"/>). Null means there is nothing to stop.
    /// </summary>
    public Func<CancellationToken, Task>? StopCollectors { get; set; }

    /// <summary>Raised on a worker thread after an <c>unpair</c> command has finished resetting the pairing.</summary>
    public event EventHandler? Unpaired;

    /// <summary>
    /// Completes after the command poller's first poll attempt following the start of the workers (success or
    /// failure), or after <see cref="FirstPollTimeout"/>, whichever comes first. If that first poll handled an
    /// <c>unpair</c>, it also waits for the pairing reset to finish, so afterwards <see cref="PairingService.IsPaired"/>
    /// is current. Already completed when not paired. Uploads (and device reports) are held back until the first
    /// poll; the app should await this before starting collectors.
    /// </summary>
    public Task FirstPollCompleted { get; private set; } = Task.CompletedTask;

    public bool IsRunning => _cts is not null;

    /// <summary>Reconcile the queue and, if paired, start the background workers.</summary>
    public Task StartAsync()
    {
        Queue.Reconcile();
        if (Pairing.IsPaired) StartWorkers();
        return Task.CompletedTask;
    }

    /// <summary>Pair, then start the workers. Returns fingerprints for the UI.</summary>
    public async Task<PairingResult> PairAsync(string pairingString, CancellationToken ct = default)
    {
        var r = await Pairing.PairAsync(pairingString, ct).ConfigureAwait(false);
        await StopWorkersAsync().ConfigureAwait(false);
        StartWorkers();
        return r;
    }

    /// <summary>Old name of <see cref="ResetPairingAsync"/>; kept until the app's callers are gone.</summary>
    public Task UnpairAsync() => ResetPairingAsync();

    /// <summary>
    /// Forget the pairing and everything tied to it: stop the workers; clear the device key, tokens and pairing state
    /// from the key store; drop the sink, uploader, poller and reporter (collectors then idle in "waiting for
    /// pairing"); empty the upload queue and its directory; clear every collector's cursor, last run and import
    /// progress (the collector rows and their enabled flag stay); clear <c>file_cache</c>. Kept: <c>executed_commands</c>
    /// (so the same unpair object is not run again; PLAN decision 4), the activity log and <c>agent_settings</c>.
    /// The next <see cref="PairAsync"/> mints a new device id.
    /// </summary>
    public async Task ResetPairingAsync()
    {
        await StopWorkersAsync().ConfigureAwait(false);
        Keys.Clear();
        PairingState = null;
        Sink = null;
        Uploader = null;
        Poller = null;
        Reporter = null;
        FirstPollCompleted = Task.CompletedTask;
        var dropped = Queue.PurgeAll();
        Collectors.ClearProgress();
        FileCache.Clear();
        Activity.Append(null, ActivityEvents.Unpaired, $"queue cleared ({dropped} items)");
    }

    /// <summary>
    /// The Mac sent <c>unpair</c>. The poller has already enqueued the <c>done</c> status. Here: stop the collectors,
    /// drop every queued item except command statuses, give the uploader up to <see cref="UnpairStatusDrainTimeout"/>
    /// to deliver the status, then reset the pairing and raise <see cref="Unpaired"/>.
    /// </summary>
    public async Task HandleUnpairAsync(CommandRecord command, CancellationToken ct)
    {
        if (!Pairing.IsPaired) return;
        if (Interlocked.Exchange(ref _unpairing, 1) == 1) return;
        try
        {
            _logger.LogInformation("unpair command {CommandId}: stopping collectors and dropping the unsent backlog", command.CommandId);

            if (StopCollectors is { } stop)
            {
                using var bound = CancellationTokenSource.CreateLinkedTokenSource(ct);
                bound.CancelAfter(StopCollectorsTimeout);
                try { await stop(bound.Token).WaitAsync(bound.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { _logger.LogWarning("unpair: collectors did not stop within {Timeout}", StopCollectorsTimeout); }
                catch (Exception e) { _logger.LogWarning(e, "unpair: stopping collectors failed"); }
            }

            var dropped = Queue.PurgeAllExcept(Kind.CommandStatus);
            Activity.Append(CommandPoller.Collector, ActivityEvents.Unpaired, $"unpair {command.CommandId}: {dropped} unsent items dropped");

            if (Uploader is { } uploader)
            {
                using var bound = CancellationTokenSource.CreateLinkedTokenSource(ct);
                bound.CancelAfter(UnpairStatusDrainTimeout);
                try
                {
                    // A status under a backoff gate is not due yet, so keep draining until none is left or time runs out.
                    while (HasQueued(Kind.CommandStatus))
                    {
                        await uploader.DrainAsync(bound.Token).ConfigureAwait(false);
                        if (!HasQueued(Kind.CommandStatus)) break;
                        await Task.Delay(TimeSpan.FromMilliseconds(200), bound.Token).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) { _logger.LogWarning("unpair: the status did not upload within {Timeout}; it is dropped with the queue", UnpairStatusDrainTimeout); }
                catch (Exception e) { _logger.LogWarning(e, "unpair: draining the status failed"); }
            }
        }
        catch (Exception e)
        {
            // The done status is already recorded, so the poller will not run this command again: reset regardless.
            _logger.LogError(e, "unpair: preparing the reset failed; resetting anyway");
        }

        // This method runs on the command poller's own loop task. ResetPairingAsync stops the workers, which awaits
        // that loop, so awaiting the reset here would deadlock. The reset therefore runs on its own task: this method
        // returns, the poller stops processing further commands (it breaks after an unpair), its loop ends when the
        // reset cancels it, and the reset continues. DisposeAsync and FirstPollCompleted await this task.
        _pendingReset = Task.Run(async () =>
        {
            try
            {
                await ResetPairingAsync().ConfigureAwait(false);
            }
            catch (Exception e)
            {
                _logger.LogError(e, "unpair: resetting the pairing failed");
                return;
            }
            finally
            {
                Interlocked.Exchange(ref _unpairing, 0);
            }
            try { Unpaired?.Invoke(this, EventArgs.Empty); }
            catch (Exception e) { _logger.LogWarning(e, "Unpaired handler threw"); }
        });
    }

    private bool HasQueued(Kind kind)
    {
        var wire = kind.WireName();
        return Queue.All().Any(i => i.Kind == wire);
    }

    private void StartWorkers()
    {
        var state = Keys.LoadPairingState() ?? throw new InvalidOperationException("not paired");
        var creds = Keys.LoadCredentials() ?? throw new InvalidOperationException("missing credentials");
        PairingState = state;
        var endpoint = new R2Endpoint(state.R2Endpoint);
        // Token separation: each client receives exactly one token.
        var up = _factory.CreateUpClient(endpoint, state.UpBucket, ScopedToken.Parse(creds.UpWriteToken));
        var cmd = _factory.CreateCmdClient(endpoint, state.CmdBucket, ScopedToken.Parse(creds.CmdReadToken));
        if (up is IDisposable du) _clients.Add(du);
        if (cmd is IDisposable dc) _clients.Add(dc);

        Sink = new RecordSink(Queue, state.MacPublicKeyBytes, state.DeviceId, Activity, _options.Sink, _time, logger: _loggers.CreateLogger<RecordSink>());
        Uploader = new Uploader(Queue, up, _options.Uploader, Activity, Db, _time, _loggers.CreateLogger<Uploader>());
        var files = new FileRequestHandler(Sink, new FileCacheLocator(FileCache), _options.FileRequests, _loggers.CreateLogger<FileRequestHandler>());
        var poller = new CommandPoller(cmd, Keys, ExecutedCommands, Sink, files, RescanHandler, CollectorConfigHandler, _options.Poller, Activity, _time,
            _loggers.CreateLogger<CommandPoller>()) { UnpairHandler = this };
        Poller = poller;
        Reporter = new DeviceReporter(Sink, Collectors, Queue, _options.Reporter, Activity, _time, _loggers.CreateLogger<DeviceReporter>());

        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        var uploader = Uploader;
        var reporter = Reporter;
        // Nothing is uploaded (and no device report is made) until the first command poll has run or timed out, so a
        // pending unpair is handled before anything goes out under the old pairing.
        var gate = FirstPollOrTimeoutAsync(poller.FirstPoll, ct);
        FirstPollCompleted = FirstPollThenPendingResetAsync(gate);
        _loops.Add(Task.Run(async () => { if (await PassFirstPollGateAsync(gate).ConfigureAwait(false)) await uploader.RunAsync(ct).ConfigureAwait(false); }, ct));
        _loops.Add(Task.Run(() => poller.RunAsync(ct), ct));
        _loops.Add(Task.Run(async () => { if (await PassFirstPollGateAsync(gate).ConfigureAwait(false)) await reporter.RunAsync(ct).ConfigureAwait(false); }, ct));
    }

    /// <summary>
    /// Waits for the first-poll gate. False when that poll handled an unpair: the reset is about to stop the workers,
    /// so the uploader and reporter must not start (nothing more goes out under the old pairing).
    /// </summary>
    private async Task<bool> PassFirstPollGateAsync(Task gate)
    {
        await gate.ConfigureAwait(false);
        return Volatile.Read(ref _unpairing) == 0;
    }

    /// <summary>Completes (never faults) when the first poll finished, after <see cref="FirstPollTimeout"/>, or on stop.</summary>
    private static async Task FirstPollOrTimeoutAsync(Task firstPoll, CancellationToken ct)
    {
        try { await firstPoll.WaitAsync(FirstPollTimeout, ct).ConfigureAwait(false); }
        catch (TimeoutException) { }
        catch (OperationCanceledException) { }
    }

    private async Task FirstPollThenPendingResetAsync(Task gate)
    {
        await gate.ConfigureAwait(false);
        // An unpair handled during the first poll scheduled the reset before the poll finished.
        if (Volatile.Read(ref _pendingReset) is { } reset)
        {
            try { await reset.ConfigureAwait(false); }
            catch (Exception) { /* logged by the reset task */ }
        }
    }

    /// <summary>"Sync now": poll commands, send a device report, and drain the queue.</summary>
    public async Task SyncNowAsync(CancellationToken ct = default)
    {
        if (Poller is null || Uploader is null || Reporter is null) throw new InvalidOperationException("not paired");
        await Poller.PollOnceAsync(ct).ConfigureAwait(false);
        Reporter.ReportNow();
        await Uploader.DrainAsync(ct).ConfigureAwait(false);
    }

    private async Task StopWorkersAsync()
    {
        // Serialized: DisposeAsync and an unpair's reset task can both get here at once.
        await _stopLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_cts is null) return;
            await _cts.CancelAsync().ConfigureAwait(false);
            try { await Task.WhenAll(_loops).ConfigureAwait(false); }
            catch (OperationCanceledException) { }
            _loops.Clear();
            _cts.Dispose();
            _cts = null;
            foreach (var c in _clients) c.Dispose();
            _clients.Clear();
        }
        finally
        {
            _stopLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopWorkersAsync().ConfigureAwait(false);
        if (Volatile.Read(ref _pendingReset) is { } reset)
        {
            try { await reset.ConfigureAwait(false); }
            catch (Exception) { /* logged by the reset task */ }
        }
        Db.Dispose();
    }
}
