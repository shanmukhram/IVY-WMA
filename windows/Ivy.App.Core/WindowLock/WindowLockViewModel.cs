using Ivy.App.Core.ViewModels;
using Microsoft.Extensions.Logging;

namespace Ivy.App.Core.WindowLock;

/// <summary>
/// The window privacy lock (PRD Part 1 "App UI", docs/CONTEXT.md): an app-lock on the owner's own window. The window
/// starts locked on every launch and shows a neutral cover; pressing the single sidebar entry
/// <see cref="UnlockGesture.PressCount"/> times opens the "enter passphrase" prompt. The passphrase is chosen by the
/// owner and provisioned once from the command line (see <see cref="WindowLockSetup"/>); the window never asks to set
/// one. Until a passphrase has been provisioned the gesture opens nothing and the window stays locked.
/// The right passphrase reveals the normal window for this session only; nothing about the unlock is remembered.
/// This class only decides what the window shows. Capture, upload, pairing and sync never read it.
/// </summary>
public sealed class WindowLockViewModel : ObservableObject
{
    private readonly IWindowLockStore _store;
    private readonly ILogger? _log;
    private byte[]? _record;
    private bool _isLocked = true;
    private LockPrompt _prompt = LockPrompt.None;
    private int _presses;

    public WindowLockViewModel(IWindowLockStore store, ILogger? log = null)
    {
        ArgumentNullException.ThrowIfNull(store);
        _store = store;
        _log = log;
        _record = LoadRecord();
    }

    /// <summary>True from construction until the right passphrase is entered; true again after <see cref="Lock"/>.</summary>
    public bool IsLocked
    {
        get => _isLocked;
        private set => Set(ref _isLocked, value);
    }

    /// <summary>The store holds a usable passphrase record. A corrupt record counts as none (nothing provisioned).</summary>
    public bool HasPassphrase => PassphraseHash.IsValid(_record);

    /// <summary>Which prompt the shell should show now.</summary>
    public LockPrompt Prompt
    {
        get => _prompt;
        private set => Set(ref _prompt, value);
    }

    /// <summary>True only while the press count is at least <see cref="UnlockGesture.HintFromPress"/> and below <see cref="UnlockGesture.PressCount"/>.</summary>
    public bool ShowHint => _presses >= UnlockGesture.HintFromPress && _presses < UnlockGesture.PressCount;

    /// <summary>
    /// One press of the quiet gesture. The <see cref="UnlockGesture.PressCount"/>-th press resets the count and, when a
    /// passphrase has been provisioned, opens the enter-passphrase prompt; with none provisioned it opens nothing.
    /// Ignored while unlocked or while a prompt is already open.
    /// </summary>
    public void Press()
    {
        if (!_isLocked || _prompt != LockPrompt.None) return;
        _presses++;
        if (_presses >= UnlockGesture.PressCount)
        {
            _presses = 0;
            if (HasPassphrase) Prompt = LockPrompt.EnterPassphrase;
        }
        Raise(nameof(ShowHint));
    }

    /// <summary>Close the prompt without unlocking; the press count starts again.</summary>
    public void CancelPrompt()
    {
        Prompt = LockPrompt.None;
        ResetPresses();
    }

    /// <summary>
    /// True when <paramref name="passphrase"/> matches: the window is unlocked for this session. False leaves the
    /// window locked and only closes the prompt.
    /// </summary>
    public bool TryUnlock(string passphrase)
    {
        if (!string.IsNullOrEmpty(passphrase) && PassphraseHash.Verify(passphrase, _record))
        {
            _log?.LogInformation("window lock: unlocked");
            Reveal();
            return true;
        }
        _log?.LogInformation("window lock: wrong passphrase");
        Prompt = LockPrompt.None;
        return false;
    }

    /// <summary>Lock the window again (the shell also does this on close; a relaunch always starts locked).</summary>
    public void Lock()
    {
        Prompt = LockPrompt.None;
        ResetPresses();
        if (_isLocked) return;
        IsLocked = true;
        _log?.LogInformation("window lock: locked");
    }

    private void Reveal()
    {
        Prompt = LockPrompt.None;
        ResetPresses();
        IsLocked = false;
    }

    private void ResetPresses()
    {
        if (_presses == 0) return;
        _presses = 0;
        Raise(nameof(ShowHint));
    }

    /// <summary>An unreadable store is treated like an empty one: no passphrase, so the window stays locked.</summary>
    private byte[]? LoadRecord()
    {
        try { return _store.Load(); }
        catch (Exception e)
        {
            _log?.LogWarning("window lock: could not read the passphrase record ({ErrorType})", e.GetType().Name);
            return null;
        }
    }
}
