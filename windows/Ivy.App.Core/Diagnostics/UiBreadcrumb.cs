using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;

namespace Ivy.App.Core.Diagnostics;

/// <summary>
/// What each thread that matters to the UI (the UI thread, the tray thread) is doing right now: a label and the
/// tick it started. Set on entry to every UI-thread entry point and cleared on exit, so the hang watchdog can
/// say where the UI thread was when it stopped answering. Labels are identifiers and counts only, never
/// content: <c>FlushFeed batch=12</c>, <c>tray WndProc msg=0x8001</c>.
/// </summary>
public static class UiBreadcrumb
{
    public sealed record Crumb(string What, long StartTimestamp, int ThreadId, Crumb? Previous);

    private static readonly ConcurrentDictionary<int, Crumb> Active = new();

    /// <summary><c>using var _ = UiBreadcrumb.Enter("Apply");</c> Nested entries restore the outer one on exit.</summary>
    public static Scope Enter(string what)
    {
        var tid = Environment.CurrentManagedThreadId;
        Active.TryGetValue(tid, out var prev);
        var crumb = new Crumb(what, Stopwatch.GetTimestamp(), tid, prev);
        Active[tid] = crumb;
        return new Scope(crumb);
    }

    /// <summary>The innermost breadcrumb of <paramref name="threadId"/>, or null when it is idle.</summary>
    public static Crumb? Of(int threadId) => Active.TryGetValue(threadId, out var c) ? c : null;

    /// <summary>All threads with an active breadcrumb.</summary>
    public static IReadOnlyList<Crumb> All() => Active.Values.ToList();

    /// <summary><c>FlushFeed batch=12 (running 5300 ms)</c>, or <c>idle</c>.</summary>
    public static string Describe(Crumb? crumb, long nowTimestamp)
    {
        if (crumb is null) return "idle";
        var ms = (long)Stopwatch.GetElapsedTime(crumb.StartTimestamp, nowTimestamp).TotalMilliseconds;
        var s = crumb.What + " (running " + ms.ToString(CultureInfo.InvariantCulture) + " ms)";
        return crumb.Previous is null ? s : s + " inside " + crumb.Previous.What;
    }

    public static string Describe(int threadId) => Describe(Of(threadId), Stopwatch.GetTimestamp());

    public readonly struct Scope : IDisposable
    {
        private readonly Crumb? _crumb;
        internal Scope(Crumb crumb) => _crumb = crumb;

        public void Dispose()
        {
            if (_crumb is null) return;
            if (_crumb.Previous is { } prev) Active[_crumb.ThreadId] = prev;
            else Active.TryRemove(new KeyValuePair<int, Crumb>(_crumb.ThreadId, _crumb));
        }
    }
}
