namespace Ivy.App.Core;

/// <summary>
/// Marshals work onto the UI thread. Agent and uploader events arrive on worker threads; view models
/// only change state inside <see cref="Post"/>. The WinUI shell implements this over DispatcherQueue.
/// </summary>
public interface IUiDispatcher
{
    void Post(Action action);
}

/// <summary>Runs the action inline. Used by tests and anywhere there is no UI thread.</summary>
public sealed class ImmediateDispatcher : IUiDispatcher
{
    public static readonly ImmediateDispatcher Instance = new();
    public void Post(Action action) => action();
}
