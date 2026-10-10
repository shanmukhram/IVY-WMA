using Ivy.Core.Commands;
using Ivy.Core.KeyStore;
using Ivy.Core.R2;
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
public sealed class VaultAgent : IAsyncDisposable
{
    private readonly VaultAgentOptions _options;
    private readonly IR2ClientFactory _factory;
    private readonly ILoggerFactory _loggers;
    private readonly TimeProvider _time;
    private CancellationTokenSource? _cts;
    private readonly List<Task> _loops = new();

    public VaultAgent(VaultAgentOptions options, IDeviceKeyStore keys, IR2ClientFactory? factory = null, ILoggerFactory? loggers = null, TimeProvider? time = null)
    {
        _options = options;
        Keys = keys;
        _factory = factory ?? new S3R2ClientFactory();
        _loggers = loggers ?? NullLoggerFactory.Instance;
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

    /// <summary>
    /// Unpair (Windows app, Settings > Advanced): stop the workers, forget the device key, tokens and pairing state,
    /// and drop the sink so collectors idle in "waiting for pairing". The queue is kept: it is ciphertext only, sealed
    /// to the Mac's key, and re-pairing with the same Mac (or one restored from the same passphrase) uploads it.
    /// </summary>
    public async Task UnpairAsync()
    {
        await StopWorkersAsync().ConfigureAwait(false);
        Keys.Clear();
        PairingState = null;
        Sink = null;
        Uploader = null;
        Poller = null;
        Reporter = null;
        Activity.Append(null, ActivityEvents.Unpaired);
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
        Poller = new CommandPoller(cmd, Keys, ExecutedCommands, Sink, files, RescanHandler, CollectorConfigHandler, _options.Poller, Activity, _time,
            _loggers.CreateLogger<CommandPoller>());
        Reporter = new DeviceReporter(Sink, Collectors, Queue, _options.Reporter, Activity, _time, _loggers.CreateLogger<DeviceReporter>());

        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        _loops.Add(Task.Run(() => Uploader.RunAsync(ct), ct));
        _loops.Add(Task.Run(() => Poller.RunAsync(ct), ct));
        _loops.Add(Task.Run(() => Reporter.RunAsync(ct), ct));
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

    public async ValueTask DisposeAsync()
    {
        await StopWorkersAsync().ConfigureAwait(false);
        Db.Dispose();
    }
}
