using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Ivy.Core.Storage;

/// <summary>
/// Regression guard for the app's UI thread (second Windows run: AppHangB1 after 16 minutes). The WinUI
/// shell records its UI thread id at startup; every <see cref="VaultDb"/> write that then runs on that thread
/// logs one warning with the write, the first caller outside the storage layer and the duration. Writes
/// belong on the thread pool: a SQLite write can wait up to busy_timeout for the WAL lock. The log line
/// carries method names and timings only, never values.
/// </summary>
public static class IvyUiThread
{
    private static int _id;

    /// <summary>Where warnings go; null disables logging (the guard still costs one int compare).</summary>
    public static ILogger? Logger { get; set; }

    /// <summary>Called once by the app on its UI thread. 0 clears it.</summary>
    public static void Set(int managedThreadId) => Volatile.Write(ref _id, managedThreadId);

    public static void SetCurrent() => Set(Environment.CurrentManagedThreadId);

    public static int ThreadId => Volatile.Read(ref _id);

    public static bool IsCurrent
    {
        get
        {
            var id = Volatile.Read(ref _id);
            return id != 0 && id == Environment.CurrentManagedThreadId;
        }
    }

    /// <summary>
    /// Wrap a database write: <c>using var _ = IvyUiThread.Write("VaultDb.SetSetting");</c>. Off the UI
    /// thread this is a no-op struct.
    /// </summary>
    public static WriteScope Write(string operation) => IsCurrent ? new WriteScope(operation, Caller(), Stopwatch.GetTimestamp()) : default;

    /// <summary>The first stack frame outside Ivy.Core.Storage and the BCL, as Type.Method.</summary>
    internal static string Caller()
    {
        try
        {
            var frames = new StackTrace(2, fNeedFileInfo: false).GetFrames();
            foreach (var f in frames)
            {
                var m = f.GetMethod();
                var t = m?.DeclaringType;
                if (t is null) continue;
                var ns = t.Namespace ?? "";
                if (ns.StartsWith("Ivy.Core.Storage", StringComparison.Ordinal) || ns.StartsWith("System", StringComparison.Ordinal)
                    || ns.StartsWith("Microsoft", StringComparison.Ordinal)) continue;
                // Compiler-generated state machines: <Name>d__12.MoveNext -> Outer.Name
                var type = t;
                var name = m!.Name;
                if (type.Name.StartsWith('<') && type.DeclaringType is { } outer)
                {
                    var close = type.Name.IndexOf('>');
                    name = close > 1 ? type.Name[1..close] : name;
                    type = outer;
                }
                if (name.StartsWith('<'))
                {
                    var close = name.IndexOf('>');
                    if (close > 1) name = name[1..close]; // lambda: <Outer>b__0 -> Outer
                }
                return type.Name + "." + name;
            }
        }
        catch (Exception)
        {
            // Diagnostics must never break a write.
        }
        return "?";
    }

    public readonly struct WriteScope : IDisposable
    {
        private readonly string? _op;
        private readonly string? _caller;
        private readonly long _start;

        internal WriteScope(string op, string caller, long start)
        {
            _op = op;
            _caller = caller;
            _start = start;
        }

        public void Dispose()
        {
            if (_op is null) return;
            var ms = (long)Stopwatch.GetElapsedTime(_start).TotalMilliseconds;
            Logger?.LogWarning("UI thread: VaultDb write {Operation} from {Caller} took {Ms} ms (move it to the thread pool)", _op, _caller, ms);
        }
    }
}
