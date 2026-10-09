using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Core.Commands;

/// <summary>
/// Result of executing a command; becomes a <c>command_status</c>. <paramref name="OrderAfterGroup"/>
/// (internal use) makes the status upload only after that queue group (e.g. the requested blob).
/// </summary>
public sealed record CommandOutcome(string Status, string? Detail = null, string? ResultOid = null, string? OrderAfterGroup = null)
{
    public static CommandOutcome Uploaded(string resultOid, string? detail = null) => new(CommandStatusValues.Uploaded, detail, resultOid, resultOid);
    public static CommandOutcome NotFound(string? detail = null) => new(CommandStatusValues.NotFound, detail);
    public static CommandOutcome AccessDenied(string? detail = null) => new(CommandStatusValues.AccessDenied, detail);
    public static CommandOutcome TooLarge(string? detail = null) => new(CommandStatusValues.TooLarge, detail);
    public static CommandOutcome Error(string? detail = null) => new(CommandStatusValues.Error, detail);
    /// <summary>Success for commands that do not upload a result object (rescan, collector_config).</summary>
    public static CommandOutcome Done(string? detail = null) => new(CommandStatusValues.Uploaded, detail);
}

/// <summary>Handles <c>file_request</c> (WR1/WR2).</summary>
public interface IFileRequestHandler
{
    Task<CommandOutcome> HandleFileRequestAsync(CommandRecord command, FileRequestParams p, CancellationToken ct);
}

/// <summary>Handles <c>rescan</c> (WR3). Implemented by the collectors.</summary>
public interface IRescanHandler
{
    Task<CommandOutcome> HandleRescanAsync(CommandRecord command, RescanParams p, CancellationToken ct);
}

/// <summary>Handles <c>collector_config</c> (WR3). Implemented by the collectors.</summary>
public interface ICollectorConfigHandler
{
    Task<CommandOutcome> HandleCollectorConfigAsync(CommandRecord command, CollectorConfigParams p, CancellationToken ct);
}

/// <summary>Resolves a file_request to a local path (path, or fileId via <c>file_cache</c>).</summary>
public interface IFileLocator
{
    string? Resolve(FileRequestParams p);
}

public sealed class FileCacheLocator : IFileLocator
{
    private readonly FileCacheStore? _cache;
    public FileCacheLocator(FileCacheStore? cache) => _cache = cache;

    public string? Resolve(FileRequestParams p)
    {
        if (!string.IsNullOrEmpty(p.FileId) && _cache?.GetByFileId(p.FileId) is { } row) return row.Path;
        return string.IsNullOrEmpty(p.Path) ? null : p.Path;
    }
}

public sealed class FileRequestOptions
{
    /// <summary>Largest original served (bytes); bigger files report <c>too_large</c>.</summary>
    public long MaxBytes { get; init; } = 2L * 1024 * 1024 * 1024;
    /// <summary>When set, only paths under one of these roots are served; others report <c>access_denied</c>.</summary>
    public IReadOnlyList<string>? AllowedRoots { get; init; }
}

/// <summary>
/// End-to-end <c>file_request</c>: locate, enforce the size limit, encrypt as a chunked blob (manifest
/// first, then parts) through the record sink, and report uploaded / not_found / access_denied / too_large.
/// The status is ordered after the blob in the queue, so the Mac only sees "uploaded" once the parts are up.
/// </summary>
public sealed class FileRequestHandler : IFileRequestHandler
{
    public const string Collector = "files";
    private readonly IRecordSink _sink;
    private readonly IFileLocator _locator;
    private readonly FileRequestOptions _options;
    private readonly ILogger _logger;

    public FileRequestHandler(IRecordSink sink, IFileLocator locator, FileRequestOptions? options = null, ILogger<FileRequestHandler>? logger = null)
    {
        _sink = sink;
        _locator = locator;
        _options = options ?? new FileRequestOptions();
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    public Task<CommandOutcome> HandleFileRequestAsync(CommandRecord command, FileRequestParams p, CancellationToken ct)
    {
        var path = _locator.Resolve(p);
        if (path is null) return Task.FromResult(CommandOutcome.NotFound("no path or known fileId"));
        string full;
        try { full = Path.GetFullPath(path); }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { return Task.FromResult(CommandOutcome.NotFound("invalid path")); }

        if (_options.AllowedRoots is { } roots && !roots.Any(r => IsUnder(full, r)))
            return Task.FromResult(CommandOutcome.AccessDenied("path outside the selected folders"));

        try
        {
            var info = new FileInfo(full);
            if (!info.Exists) return Task.FromResult(CommandOutcome.NotFound());
            if (info.Length > _options.MaxBytes) return Task.FromResult(CommandOutcome.TooLarge($"{info.Length} bytes exceeds limit {_options.MaxBytes}"));
            using var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.SequentialScan);
            var length = fs.Length;
            if (length > _options.MaxBytes) return Task.FromResult(CommandOutcome.TooLarge($"{length} bytes exceeds limit {_options.MaxBytes}"));
            var blob = _sink.EnqueueBlob(fs, Kind.FileMeta, Collector, length);
            return Task.FromResult(CommandOutcome.Uploaded(blob.Oid, $"{length} bytes in {blob.TotalChunks} chunks"));
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return Task.FromResult(CommandOutcome.NotFound());
        }
        catch (UnauthorizedAccessException)
        {
            return Task.FromResult(CommandOutcome.AccessDenied());
        }
        catch (System.Security.SecurityException)
        {
            return Task.FromResult(CommandOutcome.AccessDenied());
        }
        catch (IOException e)
        {
            _logger.LogWarning("file_request {CommandId} failed: {Error}", command.CommandId, e.Message);
            return Task.FromResult(CommandOutcome.Error("file could not be read (in use or changed while reading)"));
        }
    }

    private static bool IsUnder(string full, string root)
    {
        var r = Path.GetFullPath(root);
        if (!r.EndsWith(Path.DirectorySeparatorChar)) r += Path.DirectorySeparatorChar;
        var cmp = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return full.StartsWith(r, cmp);
    }
}
