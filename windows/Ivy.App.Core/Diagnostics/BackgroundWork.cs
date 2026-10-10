namespace Ivy.App.Core.Diagnostics;

/// <summary>
/// Runs view-model side effects (SQLite writes, registry, collector host start/stop) on the thread pool, one at a
/// time and in the order they were requested, so the UI thread never waits on a database lock and a fast
/// Pause/Resume cannot be applied out of order. Awaiting the returned task resumes on the caller's
/// synchronization context (the UI thread in the app), which is where the caller sets resulting state.
/// </summary>
public sealed class BackgroundWork
{
    private readonly object _lock = new();
    private Task _tail = Task.CompletedTask;

    public Task<T> Run<T>(Func<Task<T>> work)
    {
        lock (_lock)
        {
            var prev = _tail;
            var next = Task.Run(async () =>
            {
                try { await prev.ConfigureAwait(false); }
                catch (Exception) { /* observed by the caller that queued it */ }
                return await work().ConfigureAwait(false);
            });
            _tail = next;
            return next;
        }
    }

    public Task Run(Func<Task> work) => Run<bool>(async () =>
    {
        await work().ConfigureAwait(false);
        return true;
    });

    public Task Run(Action work) => Run<bool>(() =>
    {
        work();
        return Task.FromResult(true);
    });

    /// <summary>Completes when everything requested so far has run (tests, shutdown). Never throws.</summary>
    public Task Idle()
    {
        lock (_lock) return _tail.ContinueWith(_ => { }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }
}
