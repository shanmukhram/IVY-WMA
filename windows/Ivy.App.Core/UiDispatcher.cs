namespace Ivy.App.Core;

/// <summary>
/// Marshals work onto the UI thread. Agent and uploader events arrive on worker threads; view models
/// only change state inside <see cref="Post"/>. The WinUI shell implements this over DispatcherQueue.
/// </summary>
public interface IUiDispatcher
{
    /// <summary>
    /// Run <paramref name="action"/> on the UI thread. False when the dispatcher refused it
    /// (DispatcherQueue.TryEnqueue returned false, e.g. while shutting down): the action will never run, so a
    /// caller that set a "scheduled" flag must clear it.
    /// </summary>
    bool Post(Action action);
}

/// <summary>Runs the action inline. Used by tests and anywhere there is no UI thread.</summary>
public sealed class ImmediateDispatcher : IUiDispatcher
{
    public static readonly ImmediateDispatcher Instance = new();
    public bool Post(Action action)
    {
        action();
        return true;
    }
}
