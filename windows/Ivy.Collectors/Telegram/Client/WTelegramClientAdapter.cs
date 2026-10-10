using System.Globalization;
using System.Text.Json;
using TL;
using WClient = WTelegram.Client;

namespace Ivy.Collectors.Telegram.Client;

/// <summary>
/// The production <see cref="ITelegramClient"/>, driving <b>WTelegramClient</b> over the existing Telegram
/// Desktop session (WT1). It never logs in: the session is built from the raw auth key recovered from
/// <c>tdata</c> (<see cref="WTelegramSession"/>) and presented with Telegram Desktop's own
/// <c>api_id</c>/<c>api_hash</c> and a matching device/app string, so Telegram treats it as the same session.
/// All MTProto calls go through <see cref="InvokeAsync"/>, which maps <c>FLOOD_WAIT_X</c> to
/// <see cref="FloodWaitException"/> and auth-key rejection to <see cref="SessionInvalidException"/>.
///
/// This type is only exercised live on the PC; everything it maps is tested on macOS through
/// <see cref="TelegramTypeMapper"/> with hand-built TL objects, and its session construction through
/// <see cref="WTelegramSession"/>.
/// </summary>
public sealed class WTelegramClientAdapter : ITelegramClient
{
    private readonly TelegramApiCredentials _credentials;
    private readonly ITelegramSessionProtector _protector;
    private readonly string _deviceModel;
    private readonly string _appVersion;
    private readonly string _systemVersion;
    private readonly string _tempRoot;

    private WClient? _client;
    private byte[]? _sessionKey;
    private readonly Dictionary<string, InputPeer> _peers = new(StringComparer.Ordinal);
    private readonly List<string> _secretChats = new();

    public WTelegramClientAdapter(
        TelegramApiCredentials credentials,
        ITelegramSessionProtector? protector = null,
        string deviceModel = "Desktop",
        string appVersion = "Telegram Desktop",
        string? systemVersion = null,
        string? tempRoot = null)
    {
        _credentials = credentials ?? throw new ArgumentNullException(nameof(credentials));
        _protector = protector ?? new InMemorySessionProtector();
        _deviceModel = deviceModel;
        _appVersion = appVersion;
        _systemVersion = systemVersion ?? Environment.OSVersion.VersionString;
        _tempRoot = tempRoot ?? Path.Combine(Path.GetTempPath(), "ivy-telegram");
    }

    public IReadOnlyList<string> SecretChats => _secretChats;

    public async Task ConnectAsync(TelegramSession session, CancellationToken ct)
    {
        var built = WTelegramSession.Build(session, _credentials.ApiId);
        _sessionKey = built.SessionKey;
        var client = new WClient(Config, built.SessionBytes, bytes => _protector.Save(bytes))
        {
            FloodRetryThreshold = 0, // surface every FLOOD_WAIT as status instead of blocking the tick
        };
        try
        {
            await client.ConnectAsync().ConfigureAwait(false);
            // Confirm the imported auth key is still valid for this user (no login flow).
            var self = await InvokeAsync(client.Users_GetUsers(InputUser.Self), ct).ConfigureAwait(false);
            if (self is null || self.Length == 0 || self[0].ID != session.UserId)
                throw new SessionInvalidException("session did not resolve to the expected user");
        }
        catch (RpcException e) when (IsSessionInvalid(e))
        {
            await client.DisposeAsync().ConfigureAwait(false);
            throw new SessionInvalidException(e.Message);
        }
        catch
        {
            await client.DisposeAsync().ConfigureAwait(false);
            throw;
        }
        _client = client;
    }

    private string? Config(string what) => what switch
    {
        "api_id" => _credentials.ApiId.ToString(CultureInfo.InvariantCulture),
        "api_hash" => _credentials.ApiHash,
        "session_key" => _sessionKey is null ? null : Convert.ToHexString(_sessionKey),
        "device_model" => _deviceModel,
        "app_version" => _appVersion,
        "system_version" => _systemVersion,
        "system_lang_code" => "en",
        "lang_pack" => "tdesktop",
        "lang_code" => "en",
        // Never prompt on the console: a session that needs a login code/password is simply invalid for us.
        "verification_code" or "email_verification_code" or "password" or "phone_number" or "first_name" or "last_name"
            => throw new SessionInvalidException($"telegram asked for '{what}'; the imported session is not usable without a login"),
        _ => null,
    };

    public async Task<IReadOnlyList<TgDialog>> GetDialogsAsync(bool includeChannels, CancellationToken ct)
    {
        var client = Connected();
        var dialogs = await InvokeAsync(client.Messages_GetAllDialogs(), ct).ConfigureAwait(false);
        var users = dialogs.users;
        var chats = dialogs.chats;

        _peers.Clear();
        var result = new List<TgDialog>(dialogs.dialogs.Length);
        foreach (var d in dialogs.dialogs)
        {
            var mapped = TelegramTypeMapper.MapDialog(d, users, chats);
            if (mapped.ConvKey == "unknown") continue;
            var input = InputPeerFor(d.Peer, users, chats);
            if (input is null) continue;
            _peers[mapped.ConvKey] = input;
            if (mapped.IsChannel && !includeChannels) continue; // broadcast channels only; groups/DMs always kept (WT1)
            result.Add(mapped);
        }
        return result;
    }

    public async Task<TgHistoryPage> GetHistoryAsync(TgDialog dialog, long offsetId, int limit, CancellationToken ct)
    {
        var client = Connected();
        if (!_peers.TryGetValue(dialog.ConvKey, out var peer))
            throw new InvalidOperationException($"no resolved peer for {dialog.ConvKey}; refresh dialogs first");

        var result = await InvokeAsync(
            client.Messages_GetHistory(peer, offset_id: checked((int)offsetId), limit: limit), ct).ConfigureAwait(false);

        var messages = new List<TgMessage>(result.Messages.Length);
        foreach (var mb in result.Messages)
            if (TelegramTypeMapper.MapMessage(mb, UsersOf(result)) is { } m) messages.Add(m);

        var hasMore = result.Messages.Length >= limit && result.Messages.Length > 0;
        return new TgHistoryPage(messages, hasMore);
    }

    public async Task<TgDifference> GetDifferenceAsync(string? stateToken, CancellationToken ct)
    {
        var client = Connected();
        if (stateToken is null || !DiffState.TryDecode(stateToken, out var state) || state is null)
        {
            var current = await InvokeAsync(client.Updates_GetState(), ct).ConfigureAwait(false);
            return new TgDifference(Array.Empty<TgMessageUpdate>(), DiffState.From(current).Encode(), false);
        }

        var diff = await InvokeAsync(
            client.Updates_GetDifference(state.Pts, DateTimeOffset.FromUnixTimeSeconds(state.Date).UtcDateTime, state.Qts), ct)
            .ConfigureAwait(false);

        switch (diff)
        {
            case Updates_DifferenceEmpty empty:
                return new TgDifference(Array.Empty<TgMessageUpdate>(),
                    (state with { Date = empty.date == default ? state.Date : new DateTimeOffset(DateTime.SpecifyKind(empty.date, DateTimeKind.Utc)).ToUnixTimeSeconds(), Seq = empty.seq }).Encode(), false);
            case Updates_DifferenceTooLong tooLong:
                return new TgDifference(Array.Empty<TgMessageUpdate>(), (state with { Pts = tooLong.pts }).Encode(), false);
            case Updates_Difference full:
                return BuildDifference(full.new_messages, full.other_updates, DiffState.From(full.state), more: false);
            case Updates_DifferenceSlice slice:
                return BuildDifference(slice.new_messages, slice.other_updates, DiffState.From(slice.intermediate_state), more: true);
            default:
                return new TgDifference(Array.Empty<TgMessageUpdate>(), state.Encode(), false);
        }
    }

    private static TgDifference BuildDifference(MessageBase[] newMessages, Update[] otherUpdates, DiffState newState, bool more)
    {
        var updates = new List<TgMessageUpdate>();
        foreach (var mb in newMessages)
            if (TelegramTypeMapper.MapMessage(mb) is { } m)
                updates.Add(new TgMessageUpdate(TelegramTypeMapper.ConvKey(mb.Peer), TgChange.Added, m));

        foreach (var u in otherUpdates)
        {
            switch (u)
            {
                case UpdateEditChannelMessage edit when TelegramTypeMapper.MapMessage(edit.message) is { } em:
                    updates.Add(new TgMessageUpdate(TelegramTypeMapper.ConvKey(edit.message.Peer), TgChange.Edited, em));
                    break;
                case UpdateEditMessage edit when TelegramTypeMapper.MapMessage(edit.message) is { } em:
                    updates.Add(new TgMessageUpdate(TelegramTypeMapper.ConvKey(edit.message.Peer), TgChange.Edited, em));
                    break;
                case UpdateDeleteChannelMessages del:
                    foreach (var id in del.messages)
                        updates.Add(new TgMessageUpdate("channel:" + del.channel_id.ToString(CultureInfo.InvariantCulture),
                            TgChange.Deleted, DeletedStub(id)));
                    break;
                // Plain UpdateDeleteMessages carries no conversation id (global pts); the daily Mac-side
                // reconciliation detects those gaps. We only emit deletions we can attribute to a chat.
            }
        }
        return new TgDifference(updates, newState.Encode(), more);
    }

    private static TgMessage DeletedStub(int msgId) =>
        new(msgId, "", DateTimeOffset.UnixEpoch, "", Deleted: true, DeletedAt: DateTimeOffset.UtcNow);

    public async Task<Stream?> DownloadAvatarAsync(string avatarRef, CancellationToken ct)
    {
        var client = Connected();
        // avatarRef = convKey|photoId|dcId (TelegramTypeMapper.AvatarRefOf). Resolve the peer we already paired.
        var parts = avatarRef.Split('|');
        if (parts.Length != 3 || !long.TryParse(parts[1], out var photoId) || !int.TryParse(parts[2], out var dcId)) return null;
        if (!_peers.TryGetValue(parts[0], out var peer)) return null;

        var location = new InputPeerPhotoFileLocation { peer = peer, photo_id = photoId };
        Directory.CreateDirectory(_tempRoot);
        var path = Path.Combine(_tempRoot, Guid.NewGuid().ToString("N") + ".avatar");
        FileStream fs = new(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1 << 16, FileOptions.DeleteOnClose);
        try
        {
            await InvokeAsync(client.DownloadFileAsync(location, fs, dcId), ct).ConfigureAwait(false);
            if (fs.Length == 0) { fs.Dispose(); return null; }
            fs.Position = 0;
            return fs;
        }
        catch { fs.Dispose(); return null; }
    }

    public async Task<Stream?> DownloadAsync(string fileRef, CancellationToken ct)
    {
        var client = Connected();
        if (!TelegramAttachmentRef.TryDecode(fileRef, out var reference) || reference is null)
            throw new InvalidOperationException("unresolved telegram attachment reference");

        Directory.CreateDirectory(_tempRoot);
        // A temp file the caller reads, then disposes; DeleteOnClose removes it. Never under the queue dir (WX2).
        var path = Path.Combine(_tempRoot, Guid.NewGuid().ToString("N") + ".part");
        FileStream fs = new(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1 << 16, FileOptions.DeleteOnClose);
        try
        {
            await InvokeAsync(
                client.DownloadFileAsync(reference.ToFileLocation(), fs, reference.DcId, reference.Size), ct)
                .ConfigureAwait(false);
            fs.Position = 0;
            return fs;
        }
        catch (RpcException e) when (e.Code == 400 && e.Message.Contains("FILE_REFERENCE", StringComparison.Ordinal))
        {
            await fs.DisposeAsync().ConfigureAwait(false);
            return null; // the reference expired; the collector keeps metadata and can re-resolve later
        }
        catch
        {
            await fs.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_client is { } c) await c.DisposeAsync().ConfigureAwait(false);
        _client = null;
        if (_sessionKey is not null) System.Security.Cryptography.CryptographicOperations.ZeroMemory(_sessionKey);
    }

    // ------------------------------------------------------------------ helpers

    private WClient Connected() => _client ?? throw new InvalidOperationException("telegram client not connected");

    /// <summary>Await an MTProto call, translating flood and auth-key errors to the collector's exceptions.</summary>
    private static async Task<T> InvokeAsync<T>(Task<T> call, CancellationToken ct)
    {
        try
        {
            return await call.WaitAsync(ct).ConfigureAwait(false);
        }
        catch (RpcException e) when (e.Code == 420 && e.X > 0)
        {
            throw new FloodWaitException(e.X);
        }
        catch (RpcException e) when (IsSessionInvalid(e))
        {
            throw new SessionInvalidException(e.Message);
        }
    }

    private static bool IsSessionInvalid(RpcException e) =>
        e.Code is 401 or 406 ||
        e.Message.Contains("AUTH_KEY", StringComparison.Ordinal) ||
        e.Message is "SESSION_REVOKED" or "SESSION_EXPIRED" or "USER_DEACTIVATED" or "USER_DEACTIVATED_BAN";

    private static IReadOnlyDictionary<long, User> UsersOf(Messages_MessagesBase r) => r switch
    {
        Messages_Messages m => m.users,
        _ => new Dictionary<long, User>(),
    };

    private static InputPeer? InputPeerFor(Peer peer, IReadOnlyDictionary<long, User> users, IReadOnlyDictionary<long, ChatBase> chats) => peer switch
    {
        PeerUser u when users.TryGetValue(u.user_id, out var user) => new InputPeerUser(user.id, user.access_hash),
        PeerChat c => new InputPeerChat(c.chat_id),
        PeerChannel ch when chats.TryGetValue(ch.channel_id, out var chat) && chat is Channel channel =>
            new InputPeerChannel(channel.id, channel.access_hash),
        _ => null,
    };

    /// <summary>The opaque incremental cursor: Telegram's updates state, carried through the collector as a string.</summary>
    internal sealed record DiffState(int Pts, int Qts, long Date, int Seq)
    {
        public string Encode() => JsonSerializer.Serialize(this);

        public static bool TryDecode(string s, out DiffState? state)
        {
            try { state = JsonSerializer.Deserialize<DiffState>(s); return state is not null; }
            catch (JsonException) { state = null; return false; }
        }

        public static DiffState From(Updates_State s) =>
            new(s.pts, s.qts, s.date == default ? 0 : new DateTimeOffset(DateTime.SpecifyKind(s.date, DateTimeKind.Utc)).ToUnixTimeSeconds(), s.seq);
    }
}

/// <summary>Creates the production adapter. Registered as the default factory on Windows when credentials are set.</summary>
public sealed class WTelegramClientFactory : ITelegramClientFactory
{
    private readonly TelegramApiCredentials _credentials;
    private readonly Func<ITelegramSessionProtector?> _protector;
    private readonly string _appVersion;

    public WTelegramClientFactory(TelegramApiCredentials credentials, Func<ITelegramSessionProtector?>? protector = null, string appVersion = "Telegram Desktop")
    {
        _credentials = credentials;
        _protector = protector ?? (() => null);
        _appVersion = appVersion;
    }

    public ITelegramClient Create() => new WTelegramClientAdapter(_credentials, _protector(), appVersion: _appVersion);
}
