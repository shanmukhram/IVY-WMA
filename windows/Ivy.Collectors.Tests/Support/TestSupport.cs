using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Ivy.Collectors.Abstractions;
using Ivy.Collectors.Common;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Microsoft.Extensions.Time.Testing;

namespace Ivy.Collectors.Tests.Support;

public sealed class TempDir : IDisposable
{
    public TempDir()
    {
        // Resolve symlinks (/var -> /private/var on macOS) so paths compare equal to what the FS reports.
        var root = new DirectoryInfo(System.IO.Path.GetTempPath()).ResolveLinkTarget(true)?.FullName ?? System.IO.Path.GetTempPath();
        // On Windows %TEMP% is %LOCALAPPDATA%\Temp, which the files collector excludes by default
        // (**/AppData/Local/Temp), so test trees there would never be indexed. Use a sibling folder instead.
        if (OperatingSystem.IsWindows())
            root = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ivy-tests");
        Path = System.IO.Path.Combine(System.IO.Path.GetFullPath(root), "ivy-coll-" + Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(Path);
        Path = new DirectoryInfo(Path).FullName;
    }

    public string Path { get; }
    public string Sub(params string[] parts) => System.IO.Path.Combine(new[] { Path }.Concat(parts).ToArray());

    public string Write(string relative, string content, DateTimeOffset? mtime = null)
    {
        var full = Sub(relative.Split('/'));
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);
        File.WriteAllText(full, content);
        if (mtime is { } m) File.SetLastWriteTimeUtc(full, m.UtcDateTime);
        // Dot files are hidden by convention on macOS only; on Windows set the attribute so the tests mean the same thing.
        if (OperatingSystem.IsWindows() && System.IO.Path.GetFileName(full).StartsWith('.'))
            File.SetAttributes(full, File.GetAttributes(full) | FileAttributes.Hidden);
        return full;
    }

    public string WriteBytes(string relative, byte[] content)
    {
        var full = Sub(relative.Split('/'));
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);
        File.WriteAllBytes(full, content);
        return full;
    }

    public void Dispose()
    {
        try { Directory.Delete(Path, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

/// <summary>A vault-agent.db (in its own data dir) plus the context collectors need.</summary>
public sealed class TestEnv : IDisposable
{
    public TestEnv(TempDir dir, FakeTimeProvider? time = null, bool paired = true, string dataDirName = "agent-data")
    {
        Time = time ?? new FakeTimeProvider(new DateTimeOffset(2026, 10, 10, 12, 0, 0, TimeSpan.Zero));
        DataDir = dir.Sub(dataDirName);
        Db = new VaultDb(System.IO.Path.Combine(DataDir, VaultDb.FileName));
        Activity = new ActivityLog(Db, Time);
        States = new CollectorStateStore(Db);
        Queue = new UploadQueue(Db, System.IO.Path.Combine(DataDir, "queue"), time: Time);
        Sink = new FakeSink(Time);
        Paired = paired;
        Context = new CollectorContext(Db, () => Paired ? Sink : null, Activity, States, Queue, Time);
    }

    public FakeTimeProvider Time { get; }
    public string DataDir { get; }
    public VaultDb Db { get; }
    public ActivityLog Activity { get; }
    public CollectorStateStore States { get; }
    public UploadQueue Queue { get; }
    public FakeSink Sink { get; }
    public bool Paired { get; set; }
    public CollectorContext Context { get; }

    /// <summary>A second context on the same database (simulates a process restart).</summary>
    public CollectorContext Restart() => new(Db, () => Paired ? Sink : null, Activity, States, Queue, Time);

    public void Dispose() => Db.Dispose();
}

/// <summary>
/// Field names per kind from PROTOCOL.md §6 (and packages/protocol/src/schemas.ts). Every record the
/// collectors emit must use exactly these names: all required present, nothing unknown.
/// </summary>
public static class Schema
{
    private static readonly string[] Base = { "v", "kind", "deviceId", "eventTime", "captureTime" };

    private static readonly Dictionary<string, (string[] Required, string[] Optional)> Fields = new()
    {
        // file_meta: size/mtime/quickHash are required only for a live record; a deletion (deleted:true) may omit them.
        ["file_meta"] = (new[] { "path", "name", "ext" }, new[] { "size", "mtime", "quickHash", "thumbBlobOid", "originalBlobOid", "deleted" }),
        ["screenshot"] = (new[] { "sourcePath", "sha256", "blobOid" }, new[] { "width", "height", "takenAt", "savedAt" }),
        ["usage_event"] = (new[] { "app", "startedAt", "endedAt" }, new[] { "exe", "title" }),
        ["windows_notification"] = (new[] { "app", "title", "text", "postedAt" }, new[] { "sender" }),
        ["message_batch"] = (
            new[] { "platform", "account", "convKey", "convKind", "sourceSession", "coverage", "messages", "cursor" },
            new[] { "peer", "chatMeta" }),
    };

    /// <summary>Fields whose value is a nested object or array (validated structurally, not as a scalar string).</summary>
    private static readonly HashSet<string> Structured = new() { "messages", "chatMeta" };

    private static readonly HashSet<string> Timestamps = new() { "eventTime", "captureTime", "mtime", "takenAt", "savedAt", "startedAt", "endedAt", "postedAt" };
    private static readonly HashSet<string> Integers = new() { "size", "width", "height", "v" };
    private static readonly HashSet<string> Booleans = new() { "deleted" };
    /// <summary>Fields that may be JSON null (null carries meaning: see PROTOCOL.md §6).</summary>
    private static readonly HashSet<string> Nullable = new() { "title" };

    public static void Validate(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var kind = root.GetProperty("kind").GetString()!;
        Assert.True(Fields.ContainsKey(kind), $"unexpected kind {kind}");
        var (req, opt) = Fields[kind];
        var names = root.EnumerateObject().Select(p => p.Name).ToHashSet();
        foreach (var f in Base.Concat(req)) Assert.True(names.Contains(f), $"{kind}: missing required field '{f}' in {json}");
        // A live file_meta still carries size/mtime/quickHash; only a deletion may omit them.
        if (kind == "file_meta" && !(names.Contains("deleted") && root.GetProperty("deleted").GetBoolean()))
            foreach (var f in new[] { "size", "mtime", "quickHash" })
                Assert.True(names.Contains(f), $"file_meta: missing '{f}' on a non-deletion in {json}");
        var allowed = Base.Concat(req).Concat(opt).ToHashSet();
        foreach (var n in names) Assert.True(allowed.Contains(n), $"{kind}: unknown field '{n}' in {json}");
        Assert.Equal(1, root.GetProperty("v").GetInt32());
        foreach (var p in root.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.Null)
            {
                Assert.True(Nullable.Contains(p.Name), $"{kind}: field '{p.Name}' may not be null in {json}");
            }
            else if (Timestamps.Contains(p.Name))
            {
                Assert.Equal(JsonValueKind.String, p.Value.ValueKind);
                Assert.Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", p.Value.GetString()!);
            }
            else if (Integers.Contains(p.Name))
            {
                Assert.Equal(JsonValueKind.Number, p.Value.ValueKind);
                Assert.True(p.Value.TryGetInt64(out var n) && n >= 0, $"{p.Name} must be a non-negative integer");
            }
            else if (Booleans.Contains(p.Name))
            {
                Assert.True(p.Value.ValueKind is JsonValueKind.True or JsonValueKind.False, $"{p.Name} must be a boolean");
            }
            else if (Structured.Contains(p.Name))
            {
                Assert.True(p.Value.ValueKind is JsonValueKind.Array or JsonValueKind.Object, $"{p.Name} must be an array or object");
            }
            else
            {
                Assert.Equal(JsonValueKind.String, p.Value.ValueKind);
            }
        }
    }
}

public sealed record CapturedRecord(Kind Kind, string Oid, string Json, string? Collector)
{
    public JsonElement Root => JsonDocument.Parse(Json).RootElement;
    public string Str(string field) => Root.GetProperty(field).GetString()!;
    public bool Has(string field) => Root.TryGetProperty(field, out _);
    /// <summary>True when the field is present and JSON null (e.g. a captured-but-excluded usage title).</summary>
    public bool IsNull(string field) => Root.TryGetProperty(field, out var v) && v.ValueKind == JsonValueKind.Null;
}

public sealed record CapturedBlob(string Oid, string PayloadKind, byte[] Data, string? Collector, bool Bulk = false);

/// <summary>Captures records/blobs and validates every record against the §6 field names.</summary>
public sealed class FakeSink : IRecordSink, IDeviceIdProvider
{
    private readonly TimeProvider _time;
    public FakeSink(TimeProvider time) => _time = time;

    public string DeviceId => "dev-test";
    public ConcurrentQueue<CapturedRecord> Records { get; } = new();
    public ConcurrentQueue<CapturedBlob> Blobs { get; } = new();

    public IReadOnlyList<CapturedRecord> Of(Kind kind) => Records.Where(r => r.Kind == kind).ToList();

    public void Clear()
    {
        Records.Clear();
        Blobs.Clear();
    }

    public EnqueuedRecord Enqueue(Kind kind, string objectKeyPrefix, string recordJson, string? collector = null)
    {
        Schema.Validate(recordJson);
        var oid = Oids.New(_time);
        Records.Enqueue(new CapturedRecord(kind, oid, recordJson, collector));
        return new EnqueuedRecord(oid, ObjectKeys.Up(kind, oid), recordJson.Length);
    }

    public EnqueuedRecord Enqueue<T>(T record, string? collector = null) where T : IvyRecord
    {
        record.Validate();
        Assert.Equal(DeviceId, record.DeviceId);
        return Enqueue(record.RecordKind, ObjectKeys.UpPrefix(record.RecordKind), IvyJson.Serialize(record), collector);
    }

    public EnqueuedBlob EnqueueBlob(Stream stream, string payloadKind, string? collector = null, long? length = null, string? commandId = null,
        string? oid = null, bool bulk = false)
    {
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        var data = ms.ToArray();
        if (length is { } l && l != data.Length) throw new IOException($"stream length {data.Length} != declared {l}");
        if (oid is not null)
        {
            Assert.True(Oids.IsValid(oid), $"invalid preallocated oid {oid}");
            Assert.DoesNotContain(Blobs, b => b.Oid == oid); // a preallocated oid is enqueued at most once
        }
        oid ??= Oids.New(_time);
        Blobs.Enqueue(new CapturedBlob(oid, payloadKind, data, collector, bulk));
        return new EnqueuedBlob(oid, ObjectKeys.BlobManifest(oid), 1, data.Length, Bytes.ToHex(SHA256.HashData(data)));
    }
}

/// <summary>Change source the test drives by hand.</summary>
public sealed class ManualChangeSource : IFileChangeSource, IFileChangeSourceFactory
{
    public event Action<FileChange>? Changed;
    public event Action<string>? Overflowed;
    public List<string> Watched { get; } = new();
    public IFileChangeSource Create() => this;
    public void Watch(IReadOnlyList<string> roots, bool includeSubdirectories) => Watched.AddRange(roots);
    public void Raise(string path) => Changed?.Invoke(new FileChange(path));
    public void Overflow(string root) => Overflowed?.Invoke(root);
    public void Dispose() { }
}

/// <summary>Physical FS that records listed directories and can simulate locked files.</summary>
public sealed class RecordingFileSystem : IFileSystemSource
{
    public ConcurrentBag<string> Listed { get; } = new();
    public ConcurrentBag<string> Opened { get; } = new();
    public HashSet<string> Locked { get; } = new(StringComparer.Ordinal);

    public IEnumerable<FsEntry> EnumerateDirectory(string directory)
    {
        Listed.Add(directory);
        return PhysicalFileSystemSource.Instance.EnumerateDirectory(directory);
    }

    public FsEntry? Stat(string path) => PhysicalFileSystemSource.Instance.Stat(path);

    public Stream OpenRead(string path)
    {
        Opened.Add(path);
        return PhysicalFileSystemSource.Instance.OpenRead(path);
    }

    public bool IsReadableWithoutWriters(string path) => !Locked.Contains(path) && PhysicalFileSystemSource.Instance.IsReadableWithoutWriters(path);
}

public sealed class FakeUsnJournal : IUsnJournal
{
    public ulong JournalId { get; set; } = 7;
    public long FirstUsn { get; set; }
    public long NextUsn { get; set; } = 1000;
    public List<UsnChange> Changes { get; } = new();
    public bool Denied { get; set; }
    public List<long> ReadsFrom { get; } = new();

    public UsnJournalInfo Query(string volume)
    {
        if (Denied) throw new UnauthorizedAccessException("denied");
        return new UsnJournalInfo(JournalId, FirstUsn, NextUsn);
    }

    public UsnReadResult Read(string volume, ulong journalId, long startUsn, int maxRecords)
    {
        ReadsFrom.Add(startUsn);
        var batch = Changes.Where(c => c.Usn >= startUsn).OrderBy(c => c.Usn).Take(maxRecords).ToList();
        return new UsnReadResult(batch, batch.Count == 0 ? NextUsn : Math.Max(batch[^1].Usn + 1, batch.Count == Changes.Count(c => c.Usn >= startUsn) ? NextUsn : batch[^1].Usn + 1));
    }

    public void Add(string path, uint reason)
    {
        var usn = NextUsn;
        Changes.Add(new UsnChange(usn, reason, System.IO.Path.GetFileName(path), path, false));
        NextUsn = usn + 100;
    }
}

public sealed class FakeProbe : IForegroundWindowProbe
{
    public ForegroundSample? Current { get; set; }
    public TimeSpan Idle { get; set; }
    public ForegroundSample? Sample() => Current;
    public TimeSpan IdleTime() => Idle;
}
