namespace Ivy.Collectors.Usage;

/// <summary>Reads a window's title with a bounded wait (Windows: SendMessageTimeout(WM_GETTEXT, SMTO_ABORTIFHUNG)).</summary>
public interface IWindowTextSource
{
    /// <summary>The title, or null when the window has none, did not answer within <paramref name="timeout"/>, or is hung.</summary>
    string? ReadTitle(IntPtr hwnd, TimeSpan timeout);
}

/// <summary>
/// Title read for the foreground probe. GetWindowTextW sends WM_GETTEXT with no timeout to windows of other
/// processes, and to windows of other threads in this process; when IVY's own window was in the foreground and
/// its UI thread was busy, the usage collector waited on it (second Windows run, AppHangB1). So: windows of
/// this process are never asked (the app's cached title is used instead), and other windows get a bounded
/// read through <see cref="IWindowTextSource"/>.
/// </summary>
public sealed class ForegroundTitleReader
{
    public static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(500);
    private readonly IWindowTextSource _source;
    private readonly uint _ownPid;

    /// <summary>
    /// The title the app shows for its own window, set by the app at startup. Null: IVY's own window is
    /// recorded without a title.
    /// </summary>
    public static string? OwnProcessTitle { get; set; }

    public ForegroundTitleReader(IWindowTextSource source, uint? ownProcessId = null)
    {
        _source = source;
        _ownPid = ownProcessId ?? (uint)Environment.ProcessId;
    }

    public string? Title(IntPtr hwnd, uint processId)
    {
        if (processId == _ownPid) return OwnProcessTitle;
        var t = _source.ReadTitle(hwnd, Timeout);
        return string.IsNullOrEmpty(t) ? null : t;
    }
}
