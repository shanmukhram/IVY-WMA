using System.Text.Json;
using System.Text.Json.Nodes;
using Ivy.Core.Commands;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Microsoft.Extensions.Logging;

namespace Ivy.Collectors.Common;

/// <summary>
/// Base for every collector. The <see cref="Host.CollectorHost"/> owns the loop: it calls
/// <see cref="StartAsync"/>, then <see cref="TickAsync"/> every <see cref="Interval"/> while running and not
/// paused, and <see cref="StopAsync"/> on stop. Ticks never overlap with settings changes or rescans
/// (the host serializes them per collector), so collectors need no locking of their own except for
/// watcher callbacks.
/// </summary>
public abstract class CollectorBase
{
    protected CollectorBase(string name, CollectorContext context)
    {
        Name = name;
        Context = context;
        Logger = context.Loggers.CreateLogger("Ivy.Collectors." + name);
    }

    public string Name { get; }
    protected CollectorContext Context { get; }
    protected ILogger Logger { get; }
    protected TimeProvider Time => Context.Time;
    protected DateTimeOffset Now => Context.Time.GetUtcNow();

    /// <summary>How often the host calls <see cref="TickAsync"/>.</summary>
    public abstract TimeSpan Interval { get; }

    /// <summary>Progress marker persisted to <c>collector_state.cursor</c> (USN, max notification id, ...).</summary>
    public string? Cursor { get; protected set; }

    /// <summary>
    /// Import progress of the current (or last) bulk pass, reported in <c>device_report</c> as
    /// <c>importTotal</c>/<c>importDone</c>/<c>phase</c> (PROTOCOL.md §6). Null: the collector has no bulk pass.
    /// </summary>
    public ImportProgress? Import { get; protected set; }

    /// <summary>One human-readable status line (scan progress, fallback notes).</summary>
    public string? Detail { get; protected set; }

    /// <summary>Last error. Cleared by the host before each tick; a collector that cannot capture sets it every tick.</summary>
    public string? LastError { get; internal set; }

    public DateTimeOffset? LastRunAt { get; internal set; }
    public DateTimeOffset? LastCaptureAt { get; protected set; }
    public long Captures { get; private set; }

    /// <summary>Null when this collector can run on this machine; otherwise why not (shown as <c>Unsupported</c>).</summary>
    public virtual string? UnsupportedReason => null;

    public abstract JsonObject GetSettingsJson();

    /// <summary>Validate and apply a full settings object. Throws <see cref="ArgumentException"/> on invalid input.</summary>
    public abstract void ApplySettings(JsonObject settings);

    public virtual Task StartAsync(CancellationToken ct) => Task.CompletedTask;
    public virtual Task StopAsync() => Task.CompletedTask;

    /// <summary>
    /// Forget capture progress that is kept outside <c>collector_state</c> (sync tokens, baselines, per-chat and
    /// per-account cursors, scan checkpoints, dedupe tables) so that, once the device is paired again, this
    /// collector captures from the beginning. Never touches user settings (roots, exclusions, caps, enabled,
    /// paused, include-channels, keys). The collector must be stopped first; the default does nothing.
    /// </summary>
    public virtual Task ClearProgressAsync() => Task.CompletedTask;

    /// <summary>Called when the collector is paused (e.g. usage closes its open interval).</summary>
    public virtual Task OnPauseAsync() => Task.CompletedTask;
    public abstract Task TickAsync(CancellationToken ct);

    /// <summary><c>rescan</c> command (WR3). Default: not supported.</summary>
    public virtual Task<CommandOutcome> RescanAsync(string? scope, CancellationToken ct) =>
        Task.FromResult(CommandOutcome.Error($"rescan is not supported by the {Name} collector"));

    protected IRecordSink? Sink => Context.Sink();

    private string? _lastLoggedError;

    /// <summary>Set the error for this tick; logged to activity_log only when it changes.</summary>
    protected internal void SetError(string message)
    {
        if (_lastLoggedError != message)
        {
            Logger.LogWarning("{Collector}: {Error}", Name, message);
            Context.Activity?.Append(Name, CollectorActivity.Error, message);
            _lastLoggedError = message;
        }
        LastError = message;
    }

    internal void BeginTick() => LastError = null;

    internal void EndTick()
    {
        if (LastError is null) _lastLoggedError = null;
    }

    /// <summary>Validate, encrypt and enqueue one record, and log the capture (kind + oid only, no content).</summary>
    protected EnqueuedRecord Emit<T>(IRecordSink sink, T record) where T : IvyRecord
    {
        var r = sink.Enqueue(record, Name);
        Captures++;
        LastCaptureAt = Now;
        Context.Activity?.Append(Name, CollectorActivity.Captured, $"{record.RecordKind.WireName()} {r.Oid}");
        return r;
    }

    protected EnqueuedBlob EmitBlob(IRecordSink sink, Stream stream, string payloadKind, long length, string? oid = null, bool bulk = false)
    {
        var b = sink.EnqueueBlob(stream, payloadKind, Name, length, oid: oid, bulk: bulk);
        Context.Activity?.Append(Name, CollectorActivity.Captured, $"blob {b.Oid} {payloadKind} {b.TotalSize} bytes");
        return b;
    }

    protected void Activity(string evt, string? detail) => Context.Activity?.Append(Name, evt, detail);

    protected string DeviceId(IRecordSink sink) => sink switch
    {
        RecordSink rs => rs.DeviceId,
        IDeviceIdProvider p => p.DeviceId,
        _ => throw new InvalidOperationException("sink does not expose a device id"),
    };
}

/// <summary>Implemented by test sinks (the real <see cref="RecordSink"/> exposes <c>DeviceId</c> directly).</summary>
public interface IDeviceIdProvider
{
    string DeviceId { get; }
}

/// <summary>A collector with a typed, JSON-serializable settings object.</summary>
public abstract class Collector<TSettings> : CollectorBase where TSettings : class, new()
{
    protected Collector(string name, CollectorContext context, TSettings? settings = null) : base(name, context)
    {
        Settings = settings ?? new TSettings();
    }

    public TSettings Settings { get; private set; }

    public override JsonObject GetSettingsJson() =>
        JsonSerializer.SerializeToNode(Settings, SettingsJson.Options)?.AsObject() ?? new JsonObject();

    public override void ApplySettings(JsonObject settings)
    {
        TSettings next;
        try { next = settings.Deserialize<TSettings>(SettingsJson.Options) ?? throw new ArgumentException("settings must be an object"); }
        catch (JsonException e) { throw new ArgumentException($"invalid {Name} settings: {e.Message}", e); }
        Validate(next);
        var old = Settings;
        Settings = next;
        OnSettingsChanged(old, next);
    }

    /// <summary>Throw <see cref="ArgumentException"/> for out-of-range values.</summary>
    protected virtual void Validate(TSettings settings) { }

    protected virtual void OnSettingsChanged(TSettings previous, TSettings current) { }
}
