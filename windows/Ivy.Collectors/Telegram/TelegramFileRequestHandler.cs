using Ivy.Collectors.Telegram.Client;
using Ivy.Core.Commands;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;

namespace Ivy.Collectors.Telegram;

/// <summary>
/// Serves a <c>file_request</c> that names a Telegram attachment (WT4): the Mac sends
/// <c>fileId = "tg:&lt;attachmentRef&gt;"</c>, this handler resolves the reference from
/// <see cref="TelegramStore"/>, fetches the original through the same session, encrypts it as a chunked blob
/// tied to the command, and reports <c>uploaded</c> / <c>not_found</c> / <c>too_large</c> / <c>error</c>.
/// Attachments that were not auto-uploaded by the media policy (video, audio, over the caps) are retrieved
/// this way, on demand.
/// </summary>
public sealed class TelegramFileRequestHandler : IFileRequestHandler
{
    public const string RefPrefix = "tg:";

    private readonly IRecordSink _sink;
    private readonly TelegramStore _store;
    private readonly Func<ITelegramClient?> _client;
    private readonly long _maxBytes;

    public TelegramFileRequestHandler(IRecordSink sink, TelegramStore store, Func<ITelegramClient?> client, long maxBytes = 2L * 1024 * 1024 * 1024)
    {
        _sink = sink;
        _store = store;
        _client = client;
        _maxBytes = maxBytes;
    }

    /// <summary>True when this request targets a Telegram attachment (so a composite router can dispatch here).</summary>
    public static bool Handles(FileRequestParams p) => p.FileId is { } id && id.StartsWith(RefPrefix, StringComparison.Ordinal);

    public async Task<CommandOutcome> HandleFileRequestAsync(CommandRecord command, FileRequestParams p, CancellationToken ct)
    {
        if (!Handles(p)) return CommandOutcome.NotFound("not a telegram attachment reference");
        var attRef = p.FileId![RefPrefix.Length..];
        if (attRef.Length == 0) return CommandOutcome.NotFound("empty telegram attachment reference");

        var row = _store.GetAttachment(attRef);
        if (row is null) return CommandOutcome.NotFound("unknown telegram attachment");

        var client = _client();
        if (client is null) return CommandOutcome.Error("telegram session not connected");

        Stream? stream;
        try { stream = await client.DownloadAsync(attRef, ct).ConfigureAwait(false); }
        catch (Exception e) when (e is IOException or InvalidOperationException)
        {
            return CommandOutcome.Error($"attachment could not be fetched: {e.Message}");
        }
        if (stream is null) return CommandOutcome.NotFound("attachment is gone from the source");

        using var ms = new MemoryStream();
        using (stream) await stream.CopyToAsync(ms, ct).ConfigureAwait(false);
        if (ms.Length > _maxBytes) return CommandOutcome.TooLarge($"{ms.Length} bytes exceeds limit {_maxBytes}");
        ms.Position = 0;

        // The manifest names the command, so the Mac shows the transfer before command_status arrives (§2.2).
        var blob = _sink.EnqueueBlob(ms, PayloadKinds.Attachment, TelegramCollector.CollectorName, ms.Length, command.CommandId);
        return CommandOutcome.Uploaded(blob.Oid, $"{ms.Length} bytes in {blob.TotalChunks} chunks");
    }
}

/// <summary>
/// Routes a <c>file_request</c> to the first handler that claims it, else to a fallback (the files handler).
/// The app composition root (task 1.13) wires this so a single <see cref="IFileRequestHandler"/> serves both
/// local files and Telegram attachments without changing <c>CommandPoller</c>.
/// </summary>
public sealed class CompositeFileRequestHandler : IFileRequestHandler
{
    private readonly IReadOnlyList<(Func<FileRequestParams, bool> Claims, IFileRequestHandler Handler)> _routes;
    private readonly IFileRequestHandler _fallback;

    public CompositeFileRequestHandler(IFileRequestHandler fallback, params (Func<FileRequestParams, bool>, IFileRequestHandler)[] routes)
    {
        _fallback = fallback;
        _routes = routes;
    }

    public Task<CommandOutcome> HandleFileRequestAsync(CommandRecord command, FileRequestParams p, CancellationToken ct)
    {
        foreach (var (claims, handler) in _routes)
            if (claims(p)) return handler.HandleFileRequestAsync(command, p, ct);
        return _fallback.HandleFileRequestAsync(command, p, ct);
    }
}
