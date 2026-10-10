using System.Text.Json;
using System.Text.Json.Nodes;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Collectors.Files;
using Ivy.Collectors.Line;
using Ivy.Collectors.Notifications;
using Ivy.Collectors.Screenshots;
using Ivy.Collectors.Thumbnails;
using Ivy.Collectors.Usage;
using Ivy.Core.Agent;
using Ivy.Core.Commands;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;

namespace Ivy.Collectors.Host;

/// <summary>Overrides for the platform services the default collectors use (tests inject fakes here).</summary>
public sealed class CollectorHostOptions
{
    public IFileSystemSource? FileSystem { get; init; }
    public IFileChangeSourceFactory? ChangeSources { get; init; }
    /// <summary>Null = the platform default (Windows USN journal on Windows, none elsewhere).</summary>
    public IUsnJournal? UsnJournal { get; init; }
    /// <summary>Null = the platform default (Win32 probe on Windows, none elsewhere).</summary>
    public IForegroundWindowProbe? ForegroundProbe { get; init; }
    public Func<NotificationSettings, INotificationDbReader>? NotificationReader { get; init; }
    public IThumbnailGenerator? Thumbnails { get; init; }
    /// <summary>Null = no Telegram MTProto client (the collector reports "not configured"); tests inject a fake, the app the real adapter.</summary>
    public Telegram.ITelegramClientFactory? TelegramClientFactory { get; init; }
    /// <summary>False: do not fall back to platform implementations for null services (tests).</summary>
    public bool UsePlatformDefaults { get; init; } = true;
    public TimeProvider? Time { get; init; }
    public ILoggerFactory? Loggers { get; init; }
}

/// <summary>
/// Owns every collector: start/stop/pause each, persists settings (agent_settings) and the enabled flag
/// (collector_state), applies <c>collector_config</c> and <c>rescan</c> commands (WR3) as the agent's
/// <see cref="IRescanHandler"/>/<see cref="ICollectorConfigHandler"/>, records runs and cursors in
/// <c>collector_state</c> for the device report, and exposes <see cref="CollectorStatus"/> for the UI.
/// Captures reach <c>activity_log</c> through the sink (encrypted/queued) and the collectors (captured).
/// </summary>
public sealed class CollectorHost : IRescanHandler, ICollectorConfigHandler, IAsyncDisposable
{
    private sealed class Slot
    {
        public required CollectorBase Collector { get; init; }
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public CancellationTokenSource? Cts { get; set; }
        public Task? Loop { get; set; }
        public bool Running { get; set; }
        public bool Paused { get; set; }
        public DateTimeOffset LastRecorded { get; set; } = DateTimeOffset.MinValue;
        public string? LastRecordedCursor { get; set; }
        public ImportProgress? LastRecordedImport { get; set; }
    }

    private readonly CollectorContext _ctx;
    private readonly Dictionary<string, Slot> _slots = new(StringComparer.Ordinal);
    private readonly ILogger _logger;

    public CollectorHost(CollectorContext context, IEnumerable<CollectorBase> collectors)
    {
        _ctx = context;
        _logger = context.Loggers.CreateLogger<CollectorHost>();
        foreach (var c in collectors) _slots.Add(c.Name, new Slot { Collector = c });
    }

    /// <summary>The four Windows collectors with platform services (USN + foreground probe on Windows).</summary>
    public static CollectorHost Create(CollectorContext context, CollectorHostOptions? options = null)
    {
        var o = options ?? new CollectorHostOptions();
        var fs = o.FileSystem ?? PhysicalFileSystemSource.Instance;
        var changes = o.ChangeSources ?? FileSystemWatcherChangeSourceFactory.Instance;
        var usn = o.UsnJournal ?? (o.UsePlatformDefaults ? PlatformServices.CreateUsnJournal() : null);
        var probe = o.ForegroundProbe ?? (o.UsePlatformDefaults ? PlatformServices.CreateForegroundProbe() : null);
        var thumbs = o.Thumbnails ?? ThumbnailGenerator.CreateDefault();
        return new CollectorHost(context, new CollectorBase[]
        {
            new FileIndexCollector(context, fs, changes, usn, thumbs),
            new ScreenshotCollector(context, fs, changes),
            new UsageCollector(context, probe),
            new NotificationCollector(context, o.NotificationReader),
            new LineDesktopCollector(context),
            new Telegram.TelegramCollector(context, clientFactory: o.TelegramClientFactory),
        });
    }

    /// <summary>Build from a <see cref="VaultAgent"/> (its db, activity log, queue and — once paired — sink) and attach as its command handlers.</summary>
    public static CollectorHost CreateFor(VaultAgent agent, CollectorHostOptions? options = null)
    {
        var ctx = new CollectorContext(agent.Db, () => agent.Sink, agent.Activity, agent.Collectors, agent.Queue, options?.Time, options?.Loggers);
        var host = Create(ctx, options);
        host.AttachTo(agent);
        return host;
    }

    public void AttachTo(VaultAgent agent)
    {
        agent.RescanHandler = this;
        agent.CollectorConfigHandler = this;
    }

    public IReadOnlyList<CollectorBase> Collectors => _slots.Values.Select(s => s.Collector).ToList();

    public T Get<T>() where T : CollectorBase => _slots.Values.Select(s => s.Collector).OfType<T>().Single();

    public CollectorBase? Find(string name) => _slots.TryGetValue(name, out var s) ? s.Collector : null;

    /// <summary>Raised after every tick, start, stop, pause and config change (UI collector rows).</summary>
    public event EventHandler<CollectorStatus>? StatusChanged;

    // ------------------------------------------------------------------ lifecycle

    /// <summary>Register collector_state rows, load persisted settings and start every enabled collector.</summary>
    public async Task StartAsync(CancellationToken ct = default)
    {
        foreach (var slot in _slots.Values)
        {
            var c = slot.Collector;
            _ctx.States.Register(c.Name, enabled: true);
            if (_ctx.Settings.LoadSettings(c.Name) is { } saved)
            {
                try { c.ApplySettings(Merge(c.GetSettingsJson(), saved)); }
                catch (ArgumentException e) { _logger.LogWarning("ignoring invalid saved settings for {Collector}: {Error}", c.Name, e.Message); }
            }
            slot.Paused = _ctx.Settings.LoadJson(c.Name, "paused")?.GetValue<bool>() ?? false;
            if (IsEnabled(c.Name)) await StartSlotAsync(slot, ct).ConfigureAwait(false);
            else Raise(slot);
        }
    }

    public async Task StopAsync()
    {
        foreach (var slot in _slots.Values) await StopSlotAsync(slot).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync() => await StopAsync().ConfigureAwait(false);

    public Task StartCollectorAsync(string name, CancellationToken ct = default) => StartSlotAsync(SlotOf(name), ct);

    public Task StopCollectorAsync(string name) => StopSlotAsync(SlotOf(name));

    /// <summary>The per-collector toggle: persists the flag (collector_state.enabled) and starts/stops.</summary>
    public async Task SetEnabledAsync(string name, bool enabled, CancellationToken ct = default)
    {
        var slot = SlotOf(name);
        _ctx.States.SetEnabled(name, enabled);
        _ctx.Activity?.Append(name, CollectorActivity.Config, enabled ? "enabled" : "disabled");
        if (enabled) await StartSlotAsync(slot, ct).ConfigureAwait(false);
        else await StopSlotAsync(slot).ConfigureAwait(false);
        Raise(slot);
    }

    public async Task PauseAsync(string name)
    {
        var slot = SlotOf(name);
        if (slot.Paused) return;
        slot.Paused = true;
        _ctx.Settings.SaveJson(name, "paused", JsonValue.Create(true));
        _ctx.Activity?.Append(name, ActivityEvents.Paused, null);
        await slot.Gate.WaitAsync().ConfigureAwait(false);
        try { if (slot.Running) await slot.Collector.OnPauseAsync().ConfigureAwait(false); }
        finally { slot.Gate.Release(); }
        Raise(slot);
    }

    public void Resume(string name)
    {
        var slot = SlotOf(name);
        if (!slot.Paused) return;
        slot.Paused = false;
        _ctx.Settings.SaveJson(name, "paused", JsonValue.Create(false));
        _ctx.Activity?.Append(name, ActivityEvents.Resumed, null);
        Raise(slot);
    }

    public async Task PauseAllAsync()
    {
        foreach (var n in _slots.Keys.ToList()) await PauseAsync(n).ConfigureAwait(false);
    }

    public void ResumeAll()
    {
        foreach (var n in _slots.Keys.ToList()) Resume(n);
    }

    /// <summary>Run one tick of a started collector now (the UI's "Sync now"; also used by tests).</summary>
    public Task TickNowAsync(string name, CancellationToken ct = default) => TickAsync(SlotOf(name), ct);

    private async Task StartSlotAsync(Slot slot, CancellationToken ct)
    {
        if (slot.Running) return;
        var c = slot.Collector;
        if (c.UnsupportedReason is not null)
        {
            Raise(slot);
            return;
        }
        await slot.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await c.StartAsync(ct).ConfigureAwait(false);
            slot.Running = true;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            c.SetError($"start failed: {e.Message}");
            Raise(slot);
            return;
        }
        finally { slot.Gate.Release(); }
        _ctx.Activity?.Append(c.Name, CollectorActivity.Started, null);
        slot.Cts = new CancellationTokenSource();
        var token = slot.Cts.Token;
        slot.Loop = Task.Run(() => RunLoopAsync(slot, token), CancellationToken.None);
        Raise(slot);
    }

    private async Task StopSlotAsync(Slot slot)
    {
        if (!slot.Running) return;
        if (slot.Cts is { } cts)
        {
            await cts.CancelAsync().ConfigureAwait(false);
            try { if (slot.Loop is { } loop) await loop.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
            cts.Dispose();
        }
        slot.Cts = null;
        slot.Loop = null;
        await slot.Gate.WaitAsync().ConfigureAwait(false);
        try { await slot.Collector.StopAsync().ConfigureAwait(false); }
        catch (Exception e) { _logger.LogWarning(e, "stopping {Collector} failed", slot.Collector.Name); }
        finally
        {
            slot.Running = false;
            slot.Gate.Release();
        }
        RecordRun(slot, force: true);
        _ctx.Activity?.Append(slot.Collector.Name, CollectorActivity.Stopped, null);
        Raise(slot);
    }

    private async Task RunLoopAsync(Slot slot, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await TickAsync(slot, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            try { await Task.Delay(slot.Collector.Interval, _ctx.Time, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task TickAsync(Slot slot, CancellationToken ct)
    {
        if (!slot.Running || slot.Paused || _ctx.Sink() is null)
        {
            Raise(slot);
            return;
        }
        var c = slot.Collector;
        await slot.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            c.BeginTick();
            await c.TickAsync(ct).ConfigureAwait(false);
            c.LastRunAt = _ctx.Time.GetUtcNow();
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception e)
        {
            _logger.LogWarning(e, "{Collector} tick failed", c.Name);
            c.SetError(e.Message);
        }
        finally
        {
            c.EndTick();
            slot.Gate.Release();
        }
        RecordRun(slot, force: false);
        Raise(slot);
    }

    /// <summary>collector_state.last_run_at/cursor/import progress (device report): when the cursor or progress moves, or once a minute.</summary>
    private void RecordRun(Slot slot, bool force)
    {
        var c = slot.Collector;
        if (c.LastRunAt is not { } at) return;
        var import = c.Import;
        if (!force && c.Cursor == slot.LastRecordedCursor && import == slot.LastRecordedImport && at - slot.LastRecorded < TimeSpan.FromMinutes(1)) return;
        try
        {
            _ctx.States.RecordRun(c.Name, at, c.Cursor, import);
            slot.LastRecorded = at;
            slot.LastRecordedCursor = c.Cursor;
            slot.LastRecordedImport = import;
        }
        catch (Exception e) { _logger.LogWarning(e, "recording run for {Collector} failed", c.Name); }
    }

    // ------------------------------------------------------------------ status

    public IReadOnlyList<CollectorStatus> Statuses()
    {
        var depth = _ctx.Queue?.DepthByCollector() ?? new Dictionary<string, int>();
        return _slots.Values.Select(s => Build(s, depth)).ToList();
    }

    public CollectorStatus Status(string name) =>
        Build(SlotOf(name), _ctx.Queue?.DepthByCollector() ?? new Dictionary<string, int>());

    private CollectorStatus Build(Slot s, IReadOnlyDictionary<string, int> depth)
    {
        var c = s.Collector;
        var enabled = IsEnabled(c.Name);
        var state = !enabled ? CollectorState.Disabled
            : c.UnsupportedReason is not null ? CollectorState.Unsupported
            : !s.Running ? (c.LastError is not null ? CollectorState.Error : CollectorState.Stopped)
            : s.Paused ? CollectorState.Paused
            : _ctx.Sink() is null ? CollectorState.WaitingForPairing
            : c.LastError is not null ? CollectorState.Error
            : CollectorState.Running;
        return new CollectorStatus(
            c.Name, enabled, s.Running, s.Paused, state, c.LastRunAt, c.LastCaptureAt, c.Cursor,
            depth.TryGetValue(c.Name, out var d) ? d : 0,
            c.UnsupportedReason ?? c.LastError,
            state == CollectorState.WaitingForPairing ? "waiting for pairing" : c.Detail,
            c.Captures);
    }

    private void Raise(Slot s)
    {
        var handler = StatusChanged;
        if (handler is null) return;
        try { handler(this, Status(s.Collector.Name)); }
        catch (Exception e) { _logger.LogWarning(e, "StatusChanged handler failed"); }
    }

    private bool IsEnabled(string name) => _ctx.States.Get(name)?.Enabled ?? true;

    private Slot SlotOf(string name) =>
        _slots.TryGetValue(name, out var s) ? s : throw new ArgumentException($"unknown collector '{name}'", nameof(name));

    // ------------------------------------------------------------------ settings & commands

    /// <summary>
    /// Apply a settings patch (keys merged into the current settings) and/or the enabled flag. Persists to
    /// agent_settings and restarts the collector if it is running so watchers pick up new folders.
    /// </summary>
    public async Task<CommandOutcome> UpdateSettingsAsync(string name, bool? enabled, IReadOnlyDictionary<string, JsonElement>? settings, CancellationToken ct = default)
    {
        if (!_slots.TryGetValue(name, out var slot)) return CommandOutcome.Error($"unknown collector '{name}'");
        var applied = new List<string>();
        if (settings is { Count: > 0 })
        {
            var c = slot.Collector;
            await slot.Gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var patch = new JsonObject();
                foreach (var (k, v) in settings) patch[k] = JsonNode.Parse(v.GetRawText());
                c.ApplySettings(Merge(c.GetSettingsJson(), patch));
                _ctx.Settings.SaveSettings(name, c.GetSettingsJson());
            }
            catch (ArgumentException e) { return CommandOutcome.Error(e.Message); }
            catch (JsonException e) { return CommandOutcome.Error($"invalid settings: {e.Message}"); }
            finally { slot.Gate.Release(); }
            applied.Add("settings: " + string.Join(",", settings.Keys.OrderBy(k => k, StringComparer.Ordinal)));
            _ctx.Activity?.Append(name, CollectorActivity.Config, applied[^1]);
            if (slot.Running && (enabled ?? true))
            {
                await StopSlotAsync(slot).ConfigureAwait(false);
                await StartSlotAsync(slot, ct).ConfigureAwait(false);
            }
        }
        if (enabled is { } e2)
        {
            await SetEnabledAsync(name, e2, ct).ConfigureAwait(false);
            applied.Add(e2 ? "enabled" : "disabled");
        }
        Raise(slot);
        return CommandOutcome.Done(applied.Count == 0 ? "no changes" : string.Join("; ", applied));
    }

    public Task<CommandOutcome> HandleCollectorConfigAsync(CommandRecord command, CollectorConfigParams p, CancellationToken ct) =>
        UpdateSettingsAsync(p.Collector, p.Enabled, p.Settings, ct);

    /// <summary><c>rescan</c>: <c>files</c> (optional scope = folder path), <c>screenshots</c>, or <c>all</c>.</summary>
    public async Task<CommandOutcome> HandleRescanAsync(CommandRecord command, RescanParams p, CancellationToken ct)
    {
        if (p.Collector == "all")
        {
            var details = new List<string>();
            foreach (var name in new[] { CollectorNames.Files, CollectorNames.Screenshots })
            {
                if (!_slots.ContainsKey(name)) continue;
                var r = await RescanOneAsync(name, p.Scope, ct).ConfigureAwait(false);
                if (r.Status == CommandStatusValues.Error) return r;
                details.Add($"{name}: {r.Detail}");
            }
            return CommandOutcome.Done(string.Join("; ", details));
        }
        return await RescanOneAsync(p.Collector, p.Scope, ct).ConfigureAwait(false);
    }

    private async Task<CommandOutcome> RescanOneAsync(string name, string? scope, CancellationToken ct)
    {
        if (!_slots.TryGetValue(name, out var slot)) return CommandOutcome.Error($"unknown collector '{name}'");
        if (!IsEnabled(name)) return CommandOutcome.Error($"{name} collector is disabled");
        await slot.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var r = await slot.Collector.RescanAsync(scope, ct).ConfigureAwait(false);
            _ctx.Activity?.Append(name, CollectorActivity.Config, $"rescan: {r.Detail}");
            return r;
        }
        finally { slot.Gate.Release(); }
    }

    /// <summary>Shallow merge with case-insensitive key replacement (so "Roots" replaces "roots").</summary>
    internal static JsonObject Merge(JsonObject current, JsonObject patch)
    {
        var result = (JsonObject)current.DeepClone();
        foreach (var (k, v) in patch)
        {
            var existing = result.Select(p => p.Key).FirstOrDefault(x => string.Equals(x, k, StringComparison.OrdinalIgnoreCase));
            if (existing is not null) result.Remove(existing);
            result[existing ?? k] = v?.DeepClone();
        }
        return result;
    }
}
