using System.Collections.Concurrent;
using Ivy.App.Core.Hosting;
using Ivy.Core.Agent;
using Ivy.Core.Protocol;
using Ivy.Core.R2;
using Ivy.Core.Storage;
using Ivy.Core.Upload;

namespace Ivy.App.Core.Tests;

public sealed class TempDir : IDisposable
{
    public TempDir()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ivy-app-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path);
    }

    public string Path { get; }

    public void Dispose()
    {
        try { Directory.Delete(Path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

/// <summary>Which thread ran each side effect (the off-UI-thread tests).</summary>
public sealed class ThreadLog
{
    public ConcurrentQueue<(string Op, int Thread)> Calls { get; } = new();
    public void Record(string op) => Calls.Enqueue((op, Environment.CurrentManagedThreadId));
}

public sealed class FakeAgent : IAgentView
{
    private bool _uploadsPaused;
    private long _bandwidth;
    public ThreadLog Threads { get; } = new();
    public bool IsPaired { get; set; }
    public string? DeviceFingerprint { get; set; }
    public string? MacFingerprint { get; set; }
    public Func<string, PairingResult>? OnPair { get; set; }
    public List<ActivityEntry> History { get; } = new();
    public AgentSnapshot NextSnapshot { get; set; } = new();
    public bool UploadsPaused
    {
        get => _uploadsPaused;
        set
        {
            Threads.Record("agent.UploadsPaused");
            _uploadsPaused = value;
        }
    }
    public long BandwidthBytesPerSecond
    {
        get => _bandwidth;
        set
        {
            Threads.Record("agent.BandwidthBytesPerSecond");
            _bandwidth = value;
        }
    }
    public int SyncCalls { get; private set; }
    public Exception? SyncError { get; set; }
    public Dictionary<string, string> Settings { get; } = new();

    public event EventHandler<string>? DeviceFingerprintAvailable;
    public event EventHandler<ActivityEntry>? ActivityAppended;
    public event EventHandler<UploadProgress>? UploadProgress;

    public Task<PairingResult> PairAsync(string pairingString, CancellationToken ct = default)
    {
        var r = OnPair?.Invoke(pairingString) ?? throw new PairingException("no pairing configured");
        DeviceFingerprintAvailable?.Invoke(this, r.DeviceFingerprint);
        IsPaired = true;
        DeviceFingerprint = r.DeviceFingerprint;
        MacFingerprint = r.MacFingerprint;
        return Task.FromResult(r);
    }

    public int Unpairs { get; private set; }
    public Task UnpairAsync()
    {
        Threads.Record("agent.UnpairAsync");
        Unpairs++;
        IsPaired = false;
        DeviceFingerprint = null;
        MacFingerprint = null;
        return Task.CompletedTask;
    }

    public IReadOnlyList<ActivityEntry> RecentActivity(int limit) => History.OrderByDescending(e => e.Id).Take(limit).ToList();
    public AgentSnapshot Snapshot() => NextSnapshot;

    public Task SyncNowAsync(CancellationToken ct = default)
    {
        SyncCalls++;
        return SyncError is null ? Task.CompletedTask : Task.FromException(SyncError);
    }

    public string? GetSetting(string key) => Settings.TryGetValue(key, out var v) ? v : null;
    public void SetSetting(string key, string value)
    {
        Threads.Record("agent.SetSetting");
        Settings[key] = value;
    }

    public void RaiseActivity(ActivityEntry e) => ActivityAppended?.Invoke(this, e);
    public void RaiseProgress(UploadProgress p) => UploadProgress?.Invoke(this, p);
}

public sealed class FakeHost : ICollectorHostView
{
    public List<CollectorInfo> Infos { get; } = new();
    public List<(string, bool)> EnabledCalls { get; } = new();
    public List<CollectorSettings> Applied { get; } = new();
    public CollectorSettings Settings { get; set; } = new();
    public bool Paused { get; private set; }
    public FileImportProgress? FileImport { get; set; }
    public int Starts { get; private set; }
    public bool Disposed { get; private set; }
    public ThreadLog Threads { get; } = new();

    public IReadOnlyList<CollectorInfo> Collectors() => Infos.ToList();
    public Task SetEnabledAsync(string name, bool enabled)
    {
        Threads.Record("host.SetEnabledAsync");
        EnabledCalls.Add((name, enabled));
        return Task.CompletedTask;
    }

    public Task PauseAsync()
    {
        Threads.Record("host.PauseAsync");
        Paused = true;
        return Task.CompletedTask;
    }

    public Task ResumeAsync()
    {
        Threads.Record("host.ResumeAsync");
        Paused = false;
        return Task.CompletedTask;
    }

    public CollectorSettings GetSettings() => Settings;

    public Task ApplySettingsAsync(CollectorSettings settings)
    {
        Threads.Record("host.ApplySettingsAsync");
        Applied.Add(settings);
        Settings = settings;
        return Task.CompletedTask;
    }

    public Task StartAsync(CancellationToken ct = default)
    {
        Threads.Record("host.StartAsync");
        Starts++;
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }

    // Conversation controls (task 1.13 part 2).
    public List<string> Passcodes { get; } = new();
    public bool IncludeChannels { get; set; } = true;
    public int ProbeRuns { get; private set; }
    public string? ReportPath { get; set; }

    public Task ApplyTelegramPasscodeAsync(string passcode) { Passcodes.Add(passcode); return Task.CompletedTask; }
    public bool TelegramIncludeChannels => IncludeChannels;
    public Task SetTelegramIncludeChannelsAsync(bool include) { IncludeChannels = include; return Task.CompletedTask; }
    public Task RunLineProbeAsync() { ProbeRuns++; ReportPath ??= @"C:\IVY\line-probe-26.3.json"; return Task.CompletedTask; }
    public string? LineReportPath => ReportPath;
}

public sealed class FakeStartup : IStartupRegistration
{
    public ThreadLog Threads { get; } = new();
    public string? Command { get; set; }
    public string? RegisteredCommand() => Command;
    public void Register(string command)
    {
        Threads.Record("startup.Register");
        Command = command;
    }
    public void Unregister()
    {
        Threads.Record("startup.Unregister");
        Command = null;
    }
}

/// <summary>In-memory up/cmd buckets for driving a real <see cref="VaultAgent"/>.</summary>
public sealed class MemoryR2 : IR2ClientFactory
{
    public ConcurrentDictionary<string, byte[]> Up { get; } = new();
    public ConcurrentDictionary<string, byte[]> Cmd { get; } = new();
    public IUpBucketClient CreateUpClient(R2Endpoint endpoint, string bucket, ScopedToken writeToken) => new UpClient(this, bucket);
    public ICmdBucketClient CreateCmdClient(R2Endpoint endpoint, string bucket, ScopedToken readToken) => new CmdClient(this, bucket);

    private sealed class UpClient(MemoryR2 r2, string bucket) : IUpBucketClient
    {
        public string Bucket => bucket;

        public async Task PutAsync(string key, Stream content, long length, CancellationToken ct = default)
        {
            using var ms = new MemoryStream();
            await content.CopyToAsync(ms, ct);
            r2.Up[key] = ms.ToArray();
        }

        public Task<string> CreateMultipartAsync(string key, CancellationToken ct = default) => throw new NotSupportedException();
        public Task<string> UploadPartAsync(string key, string uploadId, int partNumber, Stream content, long length, CancellationToken ct = default) => throw new NotSupportedException();
        public Task CompleteMultipartAsync(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default) => throw new NotSupportedException();
        public Task AbortMultipartAsync(string key, string uploadId, CancellationToken ct = default) => Task.CompletedTask;
    }

    private sealed class CmdClient(MemoryR2 r2, string bucket) : ICmdBucketClient
    {
        public string Bucket => bucket;

        public Task<IReadOnlyList<string>> ListKeysAsync(string prefix, string? startAfter = null, CancellationToken ct = default) =>
            Task.FromResult((IReadOnlyList<string>)r2.Cmd.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).OrderBy(k => k, StringComparer.Ordinal).ToList());

        public Task<byte[]?> GetAsync(string key, CancellationToken ct = default) => Task.FromResult(r2.Cmd.TryGetValue(key, out var b) ? b : null);
    }

    /// <summary>What the Mac does before showing the pairing string (PROTOCOL.md §7). Returns the string and the Mac fingerprint.</summary>
    public (string PairingString, string MacFingerprint) MacPrepares(DateTimeOffset now)
    {
        var (_, macPk) = X25519.GenerateKeyPair();
        var secret = SystemRandomSource.Instance.Bytes(32);
        var pairingId = Bytes.ToHex(SystemRandomSource.Instance.Bytes(16));
        var sealedBootstrap = PairingCodec.SealBootstrap(new BootstrapPayload { UpBucket = "ivy-up-windows", UpWriteToken = "up-key:up-secret", PairingId = pairingId }, secret);
        Cmd[ObjectKeys.PairingBootstrap(pairingId)] = IvyJson.SerializeToUtf8(sealedBootstrap);
        var fp = Fingerprint.Of(macPk);
        var payload = new PairingPayload
        {
            R2Endpoint = "http://127.0.0.1:1", Role = "windows", CmdBucket = "ivy-cmd-windows", UpBucket = "ivy-up-windows",
            CmdReadToken = "cmd-key:cmd-secret", MacPublicKey = Bytes.ToBase64(macPk), MacFingerprint = fp,
            PairingId = pairingId, Secret = Bytes.ToBase64(secret), Exp = now.AddMinutes(10).ToUnixTimeMilliseconds(),
        };
        return (PairingCodec.Encode(payload), fp);
    }
}
