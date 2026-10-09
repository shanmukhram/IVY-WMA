using System.Security.Cryptography;
using System.Text.Json;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.R2;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Core.Commands;

public sealed class CommandPollerOptions
{
    /// <summary>WU4: poll the cmd-bucket every 2 minutes.</summary>
    public TimeSpan Interval { get; init; } = TimeSpan.FromMinutes(2);
}

public sealed record PollResult(int Listed, int Executed, int Skipped, int Rejected);

/// <summary>
/// Polls <c>cmd/</c> in the cmd-bucket (read token only), decrypts commands wrapped to the device key,
/// skips anything in <c>executed_commands</c>, dispatches to the handlers, and enqueues a
/// <c>command_status</c> for the up-bucket. Commands are never deleted by the device (PLAN decision 4).
/// </summary>
public sealed class CommandPoller
{
    public const string Collector = "commands";
    private readonly ICmdBucketClient _cmd;
    private readonly IDeviceKeyStore _keys;
    private readonly ExecutedCommandStore _executed;
    private readonly RecordSink _sink;
    private readonly IFileRequestHandler _fileRequests;
    private readonly CommandPollerOptions _options;
    private readonly ActivityLog? _activity;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly SemaphoreSlim _pollLock = new(1, 1);
    private readonly SemaphoreSlim _wake = new(0);

    public CommandPoller(ICmdBucketClient cmd, IDeviceKeyStore keys, ExecutedCommandStore executed, RecordSink sink,
        IFileRequestHandler fileRequests, IRescanHandler? rescan = null, ICollectorConfigHandler? collectorConfig = null,
        CommandPollerOptions? options = null, ActivityLog? activity = null, TimeProvider? time = null, ILogger<CommandPoller>? logger = null)
    {
        _cmd = cmd;
        _keys = keys;
        _executed = executed;
        _sink = sink;
        _fileRequests = fileRequests;
        RescanHandler = rescan;
        CollectorConfigHandler = collectorConfig;
        _options = options ?? new CommandPollerOptions();
        _activity = activity;
        _time = time ?? TimeProvider.System;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    /// <summary>Set by the collectors once they exist; until then rescan commands report <c>error</c>.</summary>
    public IRescanHandler? RescanHandler { get; set; }
    public ICollectorConfigHandler? CollectorConfigHandler { get; set; }

    public DateTimeOffset? LastPollAt { get; private set; }
    public string? LastPollError { get; private set; }

    public void PollNow()
    {
        if (_wake.CurrentCount == 0) _wake.Release();
    }

    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await PollOnceAsync(ct).ConfigureAwait(false); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception e) { _logger.LogWarning("command poll failed: {Error}", e.Message); }
            try { await _wake.WaitAsync(_options.Interval, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    public async Task<PollResult> PollOnceAsync(CancellationToken ct = default)
    {
        await _pollLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            IReadOnlyList<string> keys;
            try { keys = await _cmd.ListKeysAsync(ObjectKeys.CommandPrefix, null, ct).ConfigureAwait(false); }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LastPollError = e.Message;
                throw;
            }
            LastPollAt = _time.GetUtcNow();
            LastPollError = null;
            int executed = 0, skipped = 0, rejected = 0;
            foreach (var key in keys)
            {
                ct.ThrowIfCancellationRequested();
                if (_executed.IsExecutedKey(key)) { skipped++; continue; }
                switch (await ProcessAsync(key, ct).ConfigureAwait(false))
                {
                    case ProcessResult.Executed: executed++; break;
                    case ProcessResult.Rejected: rejected++; break;
                    default: skipped++; break;
                }
            }
            return new PollResult(keys.Count, executed, skipped, rejected);
        }
        finally
        {
            _pollLock.Release();
        }
    }

    private enum ProcessResult { Executed, Skipped, Rejected }

    private async Task<ProcessResult> ProcessAsync(string key, CancellationToken ct)
    {
        ParsedKey parsed;
        try { parsed = ObjectKeys.Parse(key); }
        catch (FormatException) { return Reject(key, null, "unrecognised key"); }
        if (parsed.Kind != Kind.Command || !Oids.IsValid(parsed.Oid)) return Reject(key, null, "unrecognised key");

        var bytes = await _cmd.GetAsync(key, ct).ConfigureAwait(false);
        if (bytes is null) return ProcessResult.Skipped; // deleted between list and get

        byte[] plaintext;
        var sk = _keys.LoadSecretKey();
        try { plaintext = Envelope.Decrypt(sk, key, bytes, Kind.Command).Plaintext; }
        catch (IvyCryptoException e) { return Reject(key, null, $"undecryptable: {e.Message}"); }
        finally { CryptographicOperations.ZeroMemory(sk); }

        CommandRecord command;
        string? commandId = null;
        try
        {
            commandId = PeekCommandId(plaintext);
            command = RecordJson.Parse<CommandRecord>(plaintext);
        }
        catch (Exception e) when (e is JsonException or RecordValidationException)
        {
            if (commandId is not null && !_executed.IsExecutedCommandId(commandId))
            {
                Report(key, commandId, CommandOutcome.Error($"invalid command: {e.Message}"));
                return ProcessResult.Rejected;
            }
            return Reject(key, commandId, $"invalid command: {e.Message}");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }

        if (_executed.IsExecutedCommandId(command.CommandId))
        {
            _executed.Record(key, command.CommandId, "duplicate");
            return ProcessResult.Skipped;
        }

        if (!string.Equals(command.DeviceId, _sink.DeviceId, StringComparison.Ordinal))
        {
            // Addressed to another device: never execute; report error and mark executed.
            Report(key, command.CommandId, CommandOutcome.Error("command is addressed to a different device"));
            return ProcessResult.Executed;
        }

        _activity?.Append(Collector, ActivityEvents.CommandReceived, $"{command.Params.Type} {command.CommandId}");
        CommandOutcome outcome;
        try
        {
            outcome = command.Params switch
            {
                FileRequestParams f => await _fileRequests.HandleFileRequestAsync(command, f, ct).ConfigureAwait(false),
                RescanParams r when RescanHandler is { } h => await h.HandleRescanAsync(command, r, ct).ConfigureAwait(false),
                CollectorConfigParams c when CollectorConfigHandler is { } h => await h.HandleCollectorConfigAsync(command, c, ct).ConfigureAwait(false),
                _ => CommandOutcome.Error($"no handler for '{command.Params.Type}' on this device"),
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception e)
        {
            _logger.LogError(e, "command {CommandId} handler failed", command.CommandId);
            outcome = CommandOutcome.Error("handler failed");
        }
        if (!CommandStatusValues.IsValid(outcome.Status)) outcome = CommandOutcome.Error($"handler returned invalid status '{outcome.Status}'");
        Report(key, command.CommandId, outcome);
        return ProcessResult.Executed;
    }

    private void Report(string key, string commandId, CommandOutcome outcome)
    {
        var now = IvyTime.Now(_time);
        var status = new CommandStatusRecord
        {
            DeviceId = _sink.DeviceId,
            EventTime = now,
            CaptureTime = now,
            CommandId = commandId,
            Status = outcome.Status,
            Detail = outcome.Detail,
            ResultOid = outcome.ResultOid,
            ReportedAt = now,
        };
        _sink.EnqueueRecord(status, Collector, outcome.OrderAfterGroup);
        _executed.Record(key, commandId, outcome.Status);
        _activity?.Append(Collector, ActivityEvents.CommandCompleted, $"{commandId} {outcome.Status}");
    }

    private ProcessResult Reject(string key, string? commandId, string reason)
    {
        _executed.Record(key, commandId, "rejected");
        _logger.LogWarning("command {Key} rejected: {Reason}", key, reason);
        _activity?.Append(Collector, ActivityEvents.CommandRejected, $"{key}: {reason}");
        return ProcessResult.Rejected;
    }

    private static string? PeekCommandId(byte[] json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("commandId", out var c) && c.ValueKind == JsonValueKind.String
                ? c.GetString()
                : null;
        }
        catch (JsonException) { return null; }
    }
}
