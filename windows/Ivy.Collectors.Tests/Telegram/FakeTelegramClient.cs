using Ivy.Collectors.Telegram;
using Ivy.Collectors.Telegram.Client;

namespace Ivy.Collectors.Tests.Telegram;

/// <summary>
/// A scripted <see cref="ITelegramClient"/> (and its factory) so the whole collector runs on macOS with no
/// Telegram install. It records the session it was handed (to prove no key leaks downstream), serves dialogs,
/// pages history oldest-ward exactly as <c>messages.getHistory</c> does, drains queued differences, and can be
/// told to throw FLOOD_WAIT or a session-invalid error.
/// </summary>
internal sealed class FakeTelegramClient : ITelegramClient, ITelegramClientFactory
{
    public TelegramSession? ConnectedWith { get; private set; }
    public Exception? ConnectThrows { get; set; }
    public int Connects { get; private set; }

    public List<TgDialog> Dialogs { get; } = new();
    public Dictionary<string, List<TgMessage>> History { get; } = new();
    public Queue<TgDifference> Differences { get; } = new();
    public List<string> SecretChatIds { get; } = new();
    public Dictionary<string, byte[]> Downloads { get; } = new();

    /// <summary>When &gt; 0, the next <see cref="GetHistoryAsync"/> throws FLOOD_WAIT for that many seconds, once.</summary>
    public int FloodSecondsOnNextHistory { get; set; }

    public ITelegramClient Create() => this;

    public Task ConnectAsync(TelegramSession session, CancellationToken ct)
    {
        if (ConnectThrows is not null) throw ConnectThrows;
        ConnectedWith = session;
        Connects++;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<TgDialog>> GetDialogsAsync(bool includeChannels, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<TgDialog>>(
            includeChannels ? Dialogs : Dialogs.Where(d => !d.IsChannel).ToList());

    public Task<TgHistoryPage> GetHistoryAsync(TgDialog dialog, long offsetId, int limit, CancellationToken ct)
    {
        if (FloodSecondsOnNextHistory > 0)
        {
            var s = FloodSecondsOnNextHistory;
            FloodSecondsOnNextHistory = 0;
            throw new FloodWaitException(s);
        }
        var all = (History.TryGetValue(dialog.ConvKey, out var list) ? list : new List<TgMessage>())
            .OrderBy(m => m.MsgId).ToList();
        var older = (offsetId == 0 ? all : all.Where(m => m.MsgId < offsetId)).ToList();
        var page = older.OrderByDescending(m => m.MsgId).Take(limit).ToList();
        var hasMore = older.Count > page.Count;
        return Task.FromResult(new TgHistoryPage(page, hasMore));
    }

    public Task<TgDifference> GetDifferenceAsync(string? stateToken, CancellationToken ct) =>
        Task.FromResult(Differences.Count > 0
            ? Differences.Dequeue()
            : new TgDifference(Array.Empty<TgMessageUpdate>(), stateToken ?? "state0", false));

    public Task<Stream?> DownloadAsync(string fileRef, CancellationToken ct) =>
        Task.FromResult<Stream?>(Downloads.TryGetValue(fileRef, out var b) ? new MemoryStream(b) : null);
    public Dictionary<string, byte[]> Avatars { get; } = new();
    public Task<Stream?> DownloadAvatarAsync(string avatarRef, CancellationToken ct) =>
        Task.FromResult<Stream?>(Avatars.TryGetValue(avatarRef, out var b) ? new MemoryStream(b) : null);

    public IReadOnlyList<string> SecretChats => SecretChatIds;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    // ---- builders -------------------------------------------------------

    public TgDialog AddDm(string convKey, string peer, string title)
    {
        var d = new TgDialog(convKey, TgConvKind.Dm, peer, new TgChatMeta(title, null, "private"), 0, false);
        Dialogs.Add(d);
        History[convKey] = new List<TgMessage>();
        return d;
    }

    public TgDialog AddGroup(string convKey, string title, int participants)
    {
        var d = new TgDialog(convKey, TgConvKind.Group, null, new TgChatMeta(title, participants, "group"), 0, false);
        Dialogs.Add(d);
        History[convKey] = new List<TgMessage>();
        return d;
    }

    public void AddMessage(string convKey, TgMessage m)
    {
        History[convKey].Add(m);
        var i = Dialogs.FindIndex(d => d.ConvKey == convKey);
        if (i >= 0 && m.MsgId > Dialogs[i].TopMessageId) Dialogs[i] = Dialogs[i] with { TopMessageId = m.MsgId };
    }
}
