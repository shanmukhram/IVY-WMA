using Ivy.App.Core.ViewModels;
using Microsoft.Extensions.Logging;

namespace Ivy.App.Core.WindowLock;

/// <summary>
/// The window privacy lock (PRD Part 1 "App UI", docs/CONTEXT.md): an app-lock on the owner's own window. The window
/// starts locked on every launch and shows a neutral cover; pressing the single sidebar entry
/// <see cref="UnlockGesture.PressCount"/> times opens a passphrase prompt (or, on first use, a prompt to choose one).
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

    /// <summary>The store holds a usable passphrase record. A corrupt record counts as none (first use).</summary>
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
    /// One press of the quiet gesture. The <see cref="UnlockGesture.PressCount"/>-th press opens the prompt and resets
    /// the count. Ignored while unlocked or while a prompt is already open.
    /// </summary>
    public void Press()
    {
        if (!_isLocked || _prompt != LockPrompt.None) return;
        _presses++;
        if (_presses >= UnlockGesture.PressCount)
        {
            _presses = 0;
            Prompt = HasPassphrase ? LockPrompt.EnterPassphrase : LockPrompt.SetPassphrase;
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
    /// First use: store a hash of the chosen passphrase and unlock for this session. False (and nothing stored) when
    /// the two entries differ, are empty or whitespace, a passphrase is already set, or the store write fails.
    /// </summary>
    public bool SetPassphrase(string a, string b)
    {
        if (HasPassphrase) return false;
        if (string.IsNullOrWhiteSpace(a) || !string.Equals(a, b, StringComparison.Ordinal)) return false;
        var record = PassphraseHash.Create(a);
        try
        {
            _store.Save(record);
        }
        catch (Exception e)
        {
            // Only the exception type is logged, never the record or the passphrase.
            _log?.LogWarning("window lock: could not save the passphrase record ({ErrorType})", e.GetType().Name);
            return false;
        }
        _record = record;
        Raise(nameof(HasPassphrase));
        _log?.LogInformation("window lock: passphrase set");
        Reveal();
        return true;
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

    /// <summary>An unreadable store is treated like an empty one: the lock behaves as on first use.</summary>
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
