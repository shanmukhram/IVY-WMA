using System.Collections.Concurrent;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;
using Microsoft.Extensions.Logging;

namespace Ivy.Core.Tests;

public class UiThreadGuardTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    private sealed class ListLogger : ILogger
    {
        public ConcurrentQueue<(LogLevel Level, string Text)> Lines { get; } = new();
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Enqueue((logLevel, formatter(state, exception)));
    }

    [Fact]
    public void Writes_on_the_ui_thread_are_logged_with_caller_and_duration_and_other_threads_are_not()
    {
        var log = new ListLogger();
        var db = new VaultDb(Path.Combine(_dir.Path, VaultDb.FileName));
        var activity = new ActivityLog(db);
        // Run on a dedicated thread so no other test can share the "UI" thread id.
        var t = new Thread(() =>
        {
            IvyUiThread.Logger = log;
            IvyUiThread.SetCurrent();
            try
            {
                Assert.True(IvyUiThread.IsCurrent);
                db.SetSetting("secret.key", "secret-value");
                activity.Append("files", ActivityEvents.Queued, "C:\\Users\\b\\private.txt");
                _ = db.GetSetting("secret.key"); // reads are not reported
                var off = new Thread(() => db.SetSetting("k2", "v2"));
                off.Start();
                off.Join();
            }
            finally
            {
                IvyUiThread.Set(0);
            }
        });
        t.Start();
        t.Join();
        try
        {
            var lines = log.Lines.Where(l => l.Text.Contains(nameof(Writes_on_the_ui_thread_are_logged_with_caller_and_duration_and_other_threads_are_not), StringComparison.Ordinal)).ToList();
            Assert.Equal(2, lines.Count);
            Assert.All(lines, l => Assert.Equal(LogLevel.Warning, l.Level));
            Assert.Contains("VaultDb.SetSetting", lines[0].Text);
            Assert.Contains("ActivityLog.Append", lines[1].Text);
            Assert.Matches(@"took \d+ ms", lines[0].Text);
            // Identifiers and timings only: no keys, values or details.
            Assert.All(lines, l => Assert.DoesNotContain("secret", l.Text));
            Assert.All(lines, l => Assert.DoesNotContain("private", l.Text));
            Assert.DoesNotContain(log.Lines, l => l.Text.Contains("k2", StringComparison.Ordinal));
        }
        finally
        {
            IvyUiThread.Logger = null;
            db.Dispose();
        }
    }

    [Fact]
    public void Without_a_ui_thread_the_guard_is_inert()
    {
        Assert.False(IvyUiThread.IsCurrent);
        using (IvyUiThread.Write("x")) { }
    }
}
