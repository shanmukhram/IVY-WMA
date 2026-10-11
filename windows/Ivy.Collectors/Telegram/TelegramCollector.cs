using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Ivy.Collectors.Common;
using Ivy.Collectors.Telegram.Client;
using Ivy.Collectors.Telegram.TData;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Microsoft.Extensions.Logging;

namespace Ivy.Collectors.Telegram;

/// <summary>Builds the MTProto client the collector drives (the real adapter, or a scripted fake in tests).</summary>
public interface ITelegramClientFactory
{
    ITelegramClient Create();
}

/// <summary>Honest status for the Telegram row (WT3, task 4): ok / needs passcode / tdata not found / session invalid / flood-wait until T.</summary>
public enum TelegramHealth { Ok, NeedsPasscode, TdataNotFound, SessionInvalid, FloodWait, NotConfigured }

/// <summary>
/// Telegram collector (PRD WT1–WT4, PLAN task 1.11). It reuses the Telegram Desktop session already on the PC:
/// it reads the auth key from <c>tdata</c> (<see cref="TdataReader"/>), connects an MTProto client as that same
/// session (no login, WT1), walks complete cloud history per chat with per-chat cursors, then keeps up with
/// live updates — new messages, edits, deletions (WT2). It emits <c>message_batch</c> records with
/// <c>sourceSession = "windows:telegram-desktop"</c> and <c>coverage = complete</c> for cloud chats, carrying
/// a <c>chatMeta</c>. Secret chats never exist in the cloud, so they are reported as phone-only in status and
/// never as records (WT3). Attachments follow the Windows media policy: images/documents under the caps are
/// downloaded through the session and uploaded as blobs; the rest are metadata only, on request (WT4).
///
/// Everything here is driven through <see cref="ITelegramClient"/>, so it builds and is fully tested on macOS
/// with a scripted fake; the real client talks to Telegram only on the PC. No auth-key byte ever reaches the
/// sink or the queue (WX2).
/// </summary>
public sealed class TelegramCollector : Collector<TelegramSettings>
{
    private readonly Dictionary<string, string> _avatarCaptured = new(StringComparer.Ordinal); // convKey -> avatarRef captured
    public const string CollectorName = "telegram";
    public const string Platform = "telegram";

    private readonly ITelegramClientFactory? _clientFactory;
    private readonly ITelegramPasscodeStore _passcode;
    private readonly Func<string?, byte[], TdataReader.Result> _readAccounts;
    private readonly string? _portableExeDir;
    private readonly TelegramStore _store;

    private ITelegramClient? _client;
    private TelegramAccount? _account;
    private string _account0 = "";
    private bool _connected;
    private DateTimeOffset? _floodUntil;
    private IReadOnlyList<TgDialog> _dialogs = Array.Empty<TgDialog>();
    private volatile bool _resyncRequested;

    /// <summary>
    /// Ask the collector to re-walk all history on its next tick (the one-time re-sync). Existing chats then
    /// re-emit with message sides, sender names and avatars; the Mac merges by platform message id.
    /// </summary>
    public void RequestResync() => _resyncRequested = true;

    public TelegramCollector(
        CollectorContext context,
        TelegramSettings? settings = null,
        ITelegramClientFactory? clientFactory = null,
        ITelegramPasscodeStore? passcode = null,
        Func<string?, byte[], TdataReader.Result>? readAccounts = null,
        string? portableExeDir = null)
        : base(CollectorName, context, settings)
    {
        _clientFactory = clientFactory;
        _passcode = passcode ?? new InMemoryTelegramPasscodeStore();
        _readAccounts = readAccounts ?? ((dir, pass) => TdataReader.ReadAccounts(dir, pass));
        _portableExeDir = portableExeDir;
        _store = new TelegramStore(context.Db);
    }

    /// <summary>Incremental poll cadence while connected; the initial backfill proceeds across ticks.</summary>
    public override TimeSpan Interval => TimeSpan.FromSeconds(30);

    public TelegramHealth Health { get; private set; } = TelegramHealth.Ok;
    public DateTimeOffset? FloodWaitUntil => _floodUntil;
    public TelegramStore Store => _store;

    /// <summary>True when a Telegram Desktop local passcode has been stored (so the UI knows it is set, WX2).</summary>
    public bool HasPasscode => _passcode.HasPasscode;

    /// <summary>
    /// Store the Telegram Desktop local passcode (entered once in the IVY window) and drop the connection so the
    /// next tick re-resolves tdata with it. The caller zeroes <paramref name="passcode"/> after this returns.
    /// </summary>
    public void SetPasscode(ReadOnlySpan<byte> passcode)
    {
        _passcode.StorePasscode(passcode);
        ResetConnection();
    }

    protected override void Validate(TelegramSettings s)
    {
        if (s.HistoryPageSize is < 1 or > 100) throw new ArgumentException("historyPageSize must be between 1 and 100");
        if (s.HistoryPagesPerTick < 1) throw new ArgumentException("historyPagesPerTick must be >= 1");
        if (s.ImageCapMB < 0 || s.DocumentCapMB < 0) throw new ArgumentException("media caps must be >= 0");
        if (s.OriginalsBytesPerTick < 0) throw new ArgumentException("originalsBytesPerTick must be >= 0");
    }

    protected override void OnSettingsChanged(TelegramSettings previous, TelegramSettings current)
    {
        // A changed tdata path means a different session: drop the connection so the next tick re-resolves it.
        if (!string.Equals(previous.TdataPath, current.TdataPath, StringComparison.Ordinal))
            ResetConnection();
    }

    public override Task StartAsync(CancellationToken ct)
    {
        ResetConnection();
        return Task.CompletedTask;
    }

    public override async Task StopAsync()
    {
        if (_client is not null)
        {
            try { await _client.DisposeAsync().ConfigureAwait(false); }
            catch (Exception e) { Logger.LogDebug(e, "disposing telegram client"); }
        }
        ResetConnection();
    }

    private void ResetConnection()
    {
        _client = null;
        _account = null;
        _connected = false;
        _dialogs = Array.Empty<TgDialog>();
    }

    public override async Task TickAsync(CancellationToken ct)
    {
        var sink = Sink;
        if (sink is null) return; // not paired; host also guards this

        if (_floodUntil is { } until && Now < until)
        {
            Health = TelegramHealth.FloodWait;
            Detail = $"flood-wait until {IvyTime.Format(until)}";
            SetError(Detail);
            return;
        }
        _floodUntil = null;

        if (!await EnsureConnectedAsync(ct).ConfigureAwait(false)) return;

        try
        {
            await RefreshDialogsAsync(ct).ConfigureAwait(false);
            if (_resyncRequested)
            {
                _resyncRequested = false;
                var n = _store.ResetHistory();
                _avatarCaptured.Clear(); // in-memory; cleared so avatars re-download on the re-walk
                Activity(CollectorActivity.ScanStarted, $"re-sync: re-walking all history for {n} chats");
            }
            var budget = new TickBudget(Settings.HistoryPagesPerTick, Settings.OriginalsBytesPerTick);
            await BackfillAsync(sink, budget, ct).ConfigureAwait(false);
            await IncrementalAsync(sink, budget, ct).ConfigureAwait(false);
            Health = TelegramHealth.Ok;
            UpdateProgress();
        }
        catch (FloodWaitException fw)
        {
            EnterFloodWait(fw);
        }
        catch (SessionInvalidException e)
        {
            Health = TelegramHealth.SessionInvalid;
            ResetConnection();
            SetError($"session invalid: {e.Message}");
        }
    }

    // ------------------------------------------------------------------ connect

    private async Task<bool> EnsureConnectedAsync(CancellationToken ct)
    {
        if (_connected && _client is not null) return true;

        if (_clientFactory is null)
        {
            Health = TelegramHealth.NotConfigured;
            SetError("telegram client not configured for this build");
            return false;
        }

        var tdataDir = TdataLayout.Resolve(Settings.TdataPath, _portableExeDir);
        var passBytes = _passcode.HasPasscode ? _passcode.LoadPasscode() : Array.Empty<byte>();
        TdataReader.Result result;
        try { result = _readAccounts(tdataDir, passBytes); }
        finally { if (passBytes.Length > 0) CryptographicOperations.ZeroMemory(passBytes); }

        switch (result.Failure)
        {
            case TdataReader.Failure.NotFound:
                Health = TelegramHealth.TdataNotFound;
                SetError(result.Detail ?? "tdata not found");
                return false;
            case TdataReader.Failure.NeedsPasscode:
                Health = TelegramHealth.NeedsPasscode;
                SetError("Telegram Desktop local passcode required (enter it once in the IVY window)");
                return false;
            case TdataReader.Failure.Invalid:
                Health = TelegramHealth.SessionInvalid;
                SetError(result.Detail ?? "tdata unreadable");
                return false;
        }

        var account = result.Accounts!.Active;
        _account = account;
        _account0 = account.UserId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var session = new TelegramSession(account.UserId, account.MainDcId, account.AuthKeys);

        var client = _clientFactory.Create();
        try
        {
            await client.ConnectAsync(session, ct).ConfigureAwait(false);
        }
        catch (SessionInvalidException e)
        {
            Health = TelegramHealth.SessionInvalid;
            await client.DisposeAsync().ConfigureAwait(false);
            SetError($"session invalid: {e.Message}");
            return false;
        }
        _client = client;
        _connected = true;
        Activity(CollectorActivity.Started, $"connected as user {account.UserId} on dc {account.MainDcId}");
        return true;
    }

    // ------------------------------------------------------------------ dialogs

    private async Task RefreshDialogsAsync(CancellationToken ct)
    {
        _dialogs = await _client!.GetDialogsAsync(Settings.IncludeChannels, ct).ConfigureAwait(false);
        foreach (var d in _dialogs) _store.UpsertDialog(_account0, d);
        foreach (var secret in _client.SecretChats) _store.MarkPhoneOnly(secret, "secret chat — phone-only (not in the cloud)");
    }

    // ------------------------------------------------------------------ backfill (complete history)

    private async Task BackfillAsync(IRecordSink sink, TickBudget budget, CancellationToken ct)
    {
        foreach (var dialog in _dialogs)
        {
            if (budget.Pages <= 0) return;
            var state = _store.GetChat(dialog.ConvKey);
            if (state is { HistoryComplete: true }) continue;

            // Page from the oldest message already fetched toward the start of the chat (0 = from latest).
            var offsetId = state?.OldestFetchedId ?? 0;
            while (budget.Pages > 0)
            {
                ct.ThrowIfCancellationRequested();
                var page = await _client!.GetHistoryAsync(dialog, offsetId, Settings.HistoryPageSize, ct).ConfigureAwait(false);
                budget.Pages--;
                if (page.Messages.Count == 0)
                {
                    _store.UpdateCursors(dialog.ConvKey, oldestFetchedId: offsetId, newestSeenId: dialog.TopMessageId, historyComplete: true, 0);
                    break;
                }

                var minId = page.Messages.Min(m => m.MsgId);
                var maxId = page.Messages.Max(m => m.MsgId);
                await EmitBatchAsync(sink, dialog, page.Messages, MessageCoverage.Complete, cursor: minId.ToString(System.Globalization.CultureInfo.InvariantCulture), budget, ct)
                    .ConfigureAwait(false);
                _store.UpdateCursors(dialog.ConvKey, oldestFetchedId: minId, newestSeenId: maxId, historyComplete: !page.HasMore, page.Messages.Count);
                offsetId = minId;
                if (!page.HasMore)
                {
                    Activity(CollectorActivity.ScanCompleted, $"history complete for {dialog.ConvKey}");
                    break;
                }
            }
        }
    }

    // ------------------------------------------------------------------ incremental (updates, edits, deletions)

    private async Task IncrementalAsync(IRecordSink sink, TickBudget budget, CancellationToken ct)
    {
        // Only run incremental once the first dialog pass exists; new chats still get their own backfill above.
        var stateToken = Context.Settings.LoadJson(CollectorName, "diffState")?.GetValue<string>();
        var rounds = 0;
        while (budget.Pages > 0 && rounds++ < Settings.HistoryPagesPerTick)
        {
            ct.ThrowIfCancellationRequested();
            var diff = await _client!.GetDifferenceAsync(stateToken, ct).ConfigureAwait(false);
            budget.Pages--;
            foreach (var group in diff.Updates.GroupBy(u => u.ConvKey))
            {
                var dialog = _dialogs.FirstOrDefault(d => d.ConvKey == group.Key);
                var messages = group.Select(ToUpdatedMessage).ToList();
                if (messages.Count == 0) continue;
                var maxId = messages.Max(m => m.MsgId);
                await EmitBatchAsync(sink, dialog, messages, MessageCoverage.Complete,
                    cursor: maxId.ToString(System.Globalization.CultureInfo.InvariantCulture), budget, ct, convKeyOverride: group.Key)
                    .ConfigureAwait(false);
                _store.UpdateCursors(group.Key, oldestFetchedId: null, newestSeenId: maxId, historyComplete: false, group.Count(u => u.Change == TgChange.Added));
            }
            stateToken = diff.NewState;
            Context.Settings.SaveJson(CollectorName, "diffState", JsonValue.Create(stateToken));
            if (!diff.More) break;
        }
    }

    private static TgMessage ToUpdatedMessage(TgMessageUpdate u) => u.Change == TgChange.Deleted
        ? u.Message with { Deleted = true, DeletedAt = u.Message.DeletedAt ?? u.Message.SentAt }
        : u.Message;

    // ------------------------------------------------------------------ emit

    private async Task EmitBatchAsync(IRecordSink sink, TgDialog? dialog, IReadOnlyList<TgMessage> messages, string coverage,
        string cursor, TickBudget budget, CancellationToken ct, string? convKeyOverride = null)
    {
        var nowStr = IvyTime.Format(Now);
        var convKey = convKeyOverride ?? dialog?.ConvKey ?? "unknown";
        var convKind = dialog?.ConvKind == TgConvKind.Group ? "group" : "dm";
        var eventTime = messages.Count > 0 ? IvyTime.Format(messages.Max(m => m.SentAt)) : nowStr;

        var chatMessages = new List<ChatMessage>(messages.Count);
        foreach (var m in messages)
        {
            var attachments = await MapAttachmentsAsync(sink, convKey, m, budget, ct).ConfigureAwait(false);
            chatMessages.Add(new ChatMessage
            {
                MsgId = m.MsgId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Sender = m.Sender,
                FromMe = m.FromMe,
                SenderName = m.FromMe ? "You" : (string.IsNullOrEmpty(m.SenderName) ? null : m.SenderName),
                SentAt = IvyTime.Format(m.SentAt),
                Text = m.Text,
                ReplyTo = m.ReplyTo?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                EditedAt = m.EditedAt is { } e ? IvyTime.Format(e) : null,
                SourceStatus = m.Deleted ? MessageSourceStatus.DeletedAtSource : MessageSourceStatus.Live,
                ForwardedFrom = m.ForwardedFrom,
                MediaKind = m.MediaKind,
                DeletedAtSource = m.Deleted ? IvyTime.Format(m.DeletedAt ?? Now) : null,
                Attachments = attachments,
            });
        }

        string? avatarOid = null;
        if (dialog?.AvatarRef is { } aref && _avatarCaptured.GetValueOrDefault(dialog.ConvKey) != aref)
        {
            try
            {
                using var astream = await _client!.DownloadAvatarAsync(aref, ct).ConfigureAwait(false);
                if (astream is not null)
                {
                    using var ms = new MemoryStream();
                    await astream.CopyToAsync(ms, ct).ConfigureAwait(false);
                    if (ms.Length > 0)
                    {
                        ms.Position = 0;
                        // avatars are small and drive the UI, so they ride the normal lane (with records), not the bulk lane behind big originals
                        avatarOid = sink.EnqueueBlob(ms, PayloadKinds.Avatar, CollectorName, ms.Length, bulk: false).Oid;
                        _avatarCaptured[dialog.ConvKey] = aref; // don't re-download until the photo changes
                    }
                }
            }
            catch { /* avatar is best-effort; never block message capture */ }
        }

        var batch = new MessageBatchRecord
        {
            DeviceId = DeviceId(sink),
            EventTime = eventTime,
            CaptureTime = nowStr,
            Platform = MessagePlatforms.Telegram,
            Account = _account0,
            ConvKey = convKey,
            Peer = dialog?.Peer,
            ConvKind = convKind,
            SourceSession = SourceSessions.WindowsTelegramDesktop,
            Coverage = coverage,
            ChatMeta = dialog is null ? null : new ChatMeta
            {
                Title = dialog.Meta.Title,
                ParticipantCount = dialog.Meta.ParticipantCount,
                ChatType = dialog.Meta.ChatType,
                AvatarBlobOid = avatarOid,
            },
            Messages = chatMessages,
            Cursor = cursor,
        };

        // Typed record path: the sink validates MessageBatchRecord (PROTOCOL.md §6) and encrypts it.
        Emit(sink, batch);
        Activity(CollectorActivity.Captured, $"{Kind.MessageBatch.WireName()} {convKey} ({chatMessages.Count} msgs)");
    }

    // ------------------------------------------------------------------ attachments / media policy

    private async Task<IReadOnlyList<MessageAttachment>> MapAttachmentsAsync(IRecordSink sink, string convKey, TgMessage m, TickBudget budget, CancellationToken ct)
    {
        if (m.Files.Count == 0) return Array.Empty<MessageAttachment>();
        var list = new List<MessageAttachment>(m.Files.Count);
        foreach (var a in m.Files)
        {
            var blobOid = await UploadIfPolicyAsync(sink, convKey, m.MsgId, a, budget, ct).ConfigureAwait(false);
            list.Add(new MessageAttachment
            {
                AttId = a.AttId,
                Kind = a.Kind.ToString().ToLowerInvariant(),
                Filename = a.Filename,
                Size = a.Size,
                OriginHash = a.OriginHash,
                BlobOid = blobOid,
            });
        }
        return list;
    }

    /// <summary>
    /// Apply the media policy to one attachment: images/documents under the caps are downloaded through the
    /// session and uploaded as a blob (dedupe by content), returning the oid for <c>attachments[].blobOid</c>.
    /// Everything else (video/audio, over cap, auto-upload off, or over the per-tick byte budget) stays
    /// metadata-only and is available on request via <see cref="TelegramFileRequestHandler"/>.
    /// </summary>
    private async Task<string?> UploadIfPolicyAsync(IRecordSink sink, string convKey, long msgId, TgAttachment a, TickBudget budget, CancellationToken ct)
    {
        // Record the reference so an on-request file_request can resolve it, whatever we decide below.
        var existing = _store.GetAttachment(a.FileRef);
        if (existing?.BlobOid is { } already) return already; // uploaded before (dedupe by ref)
        if (a.OriginHash is { } h && _store.OidForHash(h) is { } byHash)
        {
            _store.UpsertAttachment(new TelegramStore.AttachmentRow(a.FileRef, convKey, msgId, a.Kind.ToString().ToLowerInvariant(), a.Filename, a.Size, a.OriginHash, byHash, "uploaded"));
            return byHash; // identical content already uploaded
        }
        _store.UpsertAttachment(new TelegramStore.AttachmentRow(a.FileRef, convKey, msgId, a.Kind.ToString().ToLowerInvariant(), a.Filename, a.Size, a.OriginHash, null, "metadata"));

        var payloadKind = PolicyPayloadKind(a);
        if (payloadKind is null) return null;                 // not an auto-upload type
        if (a.Size <= 0) return null;                         // empty
        if (budget.OriginalBytes < a.Size) return null;       // over the per-tick byte budget; try next tick/rescan

        Stream? stream;
        try { stream = await _client!.DownloadAsync(a.FileRef, ct).ConfigureAwait(false); }
        catch (Exception e) when (e is IOException or InvalidOperationException)
        {
            Activity(CollectorActivity.OriginalFailed, $"attachment {a.AttId} not downloaded ({e.Message}); metadata kept, available on request");
            return null;
        }
        if (stream is null)
        {
            Activity(CollectorActivity.OriginalFailed, $"attachment {a.AttId} gone from source; metadata kept, available on request");
            return null;
        }

        using var ms = new MemoryStream();
        using (stream) await stream.CopyToAsync(ms, ct).ConfigureAwait(false);
        if (ms.Length == 0 || ms.Length > CapFor(a)) return null;
        ms.Position = 0;
        budget.OriginalBytes -= ms.Length;

        var oid = Oids.New(Time);
        var blob = sink.EnqueueBlob(ms, payloadKind, CollectorName, ms.Length, oid: oid, bulk: true);
        Activity(CollectorActivity.Captured, $"blob {blob.Oid} {payloadKind} {blob.TotalSize} bytes");
        _store.UpsertAttachment(new TelegramStore.AttachmentRow(a.FileRef, convKey, msgId, a.Kind.ToString().ToLowerInvariant(), a.Filename, a.Size, a.OriginHash, blob.Oid, "uploaded"));
        return blob.Oid;
    }

    private string? PolicyPayloadKind(TgAttachment a) => a.Kind switch
    {
        TgAttachmentKind.Image when Settings.AutoUploadImages && a.Size <= Settings.ImageCapBytes => PayloadKinds.Photo,
        TgAttachmentKind.Doc when Settings.AutoUploadDocuments && a.Size <= Settings.DocumentCapBytes => PayloadKinds.Document,
        _ => null,
    };

    private long CapFor(TgAttachment a) => a.Kind == TgAttachmentKind.Image ? Settings.ImageCapBytes : Settings.DocumentCapBytes;

    // ------------------------------------------------------------------ status

    private void EnterFloodWait(FloodWaitException fw)
    {
        _floodUntil = Now.AddSeconds(fw.Seconds);
        Health = TelegramHealth.FloodWait;
        Detail = $"flood-wait until {IvyTime.Format(_floodUntil.Value)}";
        SetError(Detail);
    }

    private void UpdateProgress()
    {
        var chats = _store.AllChats();
        var total = chats.Count;
        var done = chats.Count(c => c.HistoryComplete);
        var msgs = chats.Sum(c => c.MessagesSeen);
        var phase = done == 0 ? ImportPhases.Initial : done < total ? ImportPhases.Rescan : ImportPhases.Incremental;
        Import = new ImportProgress(total, done, phase);

        var cursor = new JsonObject
        {
            ["chatsDone"] = done,
            ["chatsTotal"] = total,
            ["messages"] = msgs,
        };
        Cursor = cursor.ToJsonString();
        var phoneOnly = _store.PhoneOnlyCount();
        Detail = $"chats {done}/{total}, {msgs} messages" + (phoneOnly > 0 ? $", {phoneOnly} phone-only (secret)" : "");
    }

    /// <summary>Per-tick work budget: pages of history/updates and bytes of auto-downloaded originals.</summary>
    private sealed class TickBudget
    {
        public TickBudget(int pages, long originalBytes) { Pages = pages; OriginalBytes = originalBytes; }
        public int Pages;
        public long OriginalBytes;
    }
}
