using Ivy.Collectors.Usage;

namespace Ivy.Collectors.Tests;

public class ForegroundTitleReaderTests
{
    private sealed class FakeTextSource : IWindowTextSource
    {
        public List<(IntPtr Hwnd, TimeSpan Timeout)> Calls { get; } = new();
        public string? Next { get; set; } = "Inbox - Mail";
        public string? ReadTitle(IntPtr hwnd, TimeSpan timeout)
        {
            Calls.Add((hwnd, timeout));
            return Next;
        }
    }

    [Fact]
    public void Own_process_windows_are_never_asked_for_their_title()
    {
        var src = new FakeTextSource();
        var reader = new ForegroundTitleReader(src, ownProcessId: 4242);
        var saved = ForegroundTitleReader.OwnProcessTitle;
        try
        {
            ForegroundTitleReader.OwnProcessTitle = "IVY";
            Assert.Equal("IVY", reader.Title(new IntPtr(7), 4242));
            Assert.Empty(src.Calls); // no WM_GETTEXT to our own (possibly busy) UI thread

            ForegroundTitleReader.OwnProcessTitle = null;
            Assert.Null(reader.Title(new IntPtr(7), 4242));
            Assert.Empty(src.Calls);
        }
        finally
        {
            ForegroundTitleReader.OwnProcessTitle = saved;
        }
    }

    [Fact]
    public void Other_windows_are_read_with_the_bounded_timeout()
    {
        var src = new FakeTextSource();
        var reader = new ForegroundTitleReader(src, ownProcessId: 4242);
        Assert.Equal("Inbox - Mail", reader.Title(new IntPtr(9), 100));
        Assert.Equal((new IntPtr(9), TimeSpan.FromMilliseconds(500)), Assert.Single(src.Calls));
        src.Next = null; // hung or timed out
        Assert.Null(reader.Title(new IntPtr(9), 100));
        src.Next = "";
        Assert.Null(reader.Title(new IntPtr(9), 100));
    }

    [Fact]
    public void Default_own_process_id_is_this_process()
    {
        var src = new FakeTextSource();
        var reader = new ForegroundTitleReader(src);
        reader.Title(new IntPtr(1), (uint)Environment.ProcessId);
        Assert.Empty(src.Calls);
    }
}
