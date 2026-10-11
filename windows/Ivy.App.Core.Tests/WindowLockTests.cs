using System.Text;
using Ivy.App.Core.ViewModels;
using Ivy.App.Core.WindowLock;
using Microsoft.Extensions.Time.Testing;

namespace Ivy.App.Core.Tests;

public class WindowLockTests
{
    private const string Passphrase = "correct horse battery staple";
    private readonly InMemoryWindowLockStore _store = new();

    private WindowLockViewModel Create() => new(_store);

    private static void PressTimes(WindowLockViewModel vm, int n)
    {
        for (var i = 0; i < n; i++) vm.Press();
    }

    /// <summary>Open the set prompt with the gesture and choose <see cref="Passphrase"/>.</summary>
    private static void SetUp(WindowLockViewModel vm)
    {
        PressTimes(vm, UnlockGesture.PressCount);
        Assert.Equal(LockPrompt.SetPassphrase, vm.Prompt);
        Assert.True(vm.SetPassphrase(Passphrase, Passphrase));
    }

    [Fact]
    public void Starts_locked_with_no_prompt()
    {
        var vm = Create();
        Assert.True(vm.IsLocked);
        Assert.False(vm.HasPassphrase);
        Assert.Equal(LockPrompt.None, vm.Prompt);
        Assert.False(vm.ShowHint);
    }

    [Fact]
    public void Nineteen_presses_leave_no_prompt_and_the_twentieth_opens_it()
    {
        var vm = Create();
        PressTimes(vm, UnlockGesture.PressCount - 1);
        Assert.Equal(LockPrompt.None, vm.Prompt);
        vm.Press();
        Assert.Equal(LockPrompt.SetPassphrase, vm.Prompt);
        Assert.True(vm.IsLocked);
    }

    [Fact]
    public void Hint_shows_only_on_presses_18_and_19()
    {
        var vm = Create();
        var hints = new List<int>();
        for (var i = 1; i <= UnlockGesture.PressCount; i++)
        {
            vm.Press();
            if (vm.ShowHint) hints.Add(i);
        }
        Assert.Equal(new[] { 18, 19 }, hints);
    }

    [Fact]
    public void First_use_asks_to_set_and_afterwards_the_gesture_asks_to_enter()
    {
        var vm = Create();
        SetUp(vm);
        Assert.True(vm.HasPassphrase);
        Assert.False(vm.IsLocked);
        Assert.Equal(LockPrompt.None, vm.Prompt);

        vm.Lock();
        PressTimes(vm, UnlockGesture.PressCount);
        Assert.Equal(LockPrompt.EnterPassphrase, vm.Prompt);
    }

    [Fact]
    public void Correct_passphrase_unlocks_and_wrong_one_does_not()
    {
        var vm = Create();
        SetUp(vm);
        vm.Lock();

        PressTimes(vm, UnlockGesture.PressCount);
        Assert.False(vm.TryUnlock("not it"));
        Assert.True(vm.IsLocked);
        Assert.True(vm.HasPassphrase);
        Assert.Equal(LockPrompt.None, vm.Prompt);

        PressTimes(vm, UnlockGesture.PressCount);
        Assert.True(vm.TryUnlock(Passphrase));
        Assert.False(vm.IsLocked);
        Assert.Equal(LockPrompt.None, vm.Prompt);
    }

    [Fact]
    public void Mismatched_entries_are_rejected_and_nothing_is_stored()
    {
        var vm = Create();
        PressTimes(vm, UnlockGesture.PressCount);
        Assert.False(vm.SetPassphrase(Passphrase, Passphrase + "x"));
        Assert.Null(_store.Load());
        Assert.False(vm.HasPassphrase);
        Assert.True(vm.IsLocked);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Empty_or_whitespace_passphrase_is_rejected(string blank)
    {
        var vm = Create();
        PressTimes(vm, UnlockGesture.PressCount);
        Assert.False(vm.SetPassphrase(blank, blank));
        Assert.Null(_store.Load());
        Assert.True(vm.IsLocked);
    }

    [Fact]
    public void Lock_relocks_and_resets_the_press_count()
    {
        var vm = Create();
        SetUp(vm);
        Assert.False(vm.IsLocked);

        vm.Lock();
        Assert.True(vm.IsLocked);
        PressTimes(vm, UnlockGesture.PressCount - 1);
        vm.Lock();
        vm.Press();
        Assert.Equal(LockPrompt.None, vm.Prompt);
        Assert.False(vm.ShowHint);
    }

    [Fact]
    public void Cancel_closes_the_prompt_and_resets_the_count()
    {
        var vm = Create();
        PressTimes(vm, UnlockGesture.PressCount);
        vm.CancelPrompt();
        Assert.Equal(LockPrompt.None, vm.Prompt);
        vm.Press();
        Assert.Equal(LockPrompt.None, vm.Prompt);
        Assert.True(vm.IsLocked);
    }

    [Fact]
    public void Relaunch_over_the_same_store_starts_locked_with_a_passphrase()
    {
        SetUp(Create());
        var relaunched = Create();
        Assert.True(relaunched.IsLocked);
        Assert.True(relaunched.HasPassphrase);
        PressTimes(relaunched, UnlockGesture.PressCount);
        Assert.Equal(LockPrompt.EnterPassphrase, relaunched.Prompt);
        Assert.True(relaunched.TryUnlock(Passphrase));
    }

    [Fact]
    public void Setting_again_once_a_passphrase_exists_is_refused()
    {
        var vm = Create();
        SetUp(vm);
        var stored = _store.Load();
        vm.Lock();
        Assert.False(vm.SetPassphrase("other", "other"));
        Assert.Equal(stored, _store.Load());
        Assert.True(vm.IsLocked);
    }

    [Fact]
    public void Stored_record_holds_only_a_salted_hash()
    {
        SetUp(Create());
        var stored = _store.Load();
        Assert.NotNull(stored);
        var text = Encoding.UTF8.GetString(stored!);
        Assert.DoesNotContain(Passphrase, text, StringComparison.Ordinal);
        Assert.Equal(-1, stored!.AsSpan().IndexOf(Encoding.UTF8.GetBytes(Passphrase)));
        Assert.Equal(-1, stored!.AsSpan().IndexOf(Encoding.Unicode.GetBytes(Passphrase)));
        Assert.Contains("\"kdf\":\"pbkdf2-sha256\"", text, StringComparison.Ordinal);
        Assert.Contains("\"iterations\":" + PassphraseHash.Iterations, text, StringComparison.Ordinal);
    }

    [Fact]
    public void Two_records_for_the_same_passphrase_use_different_salts()
    {
        var a = PassphraseHash.Create(Passphrase);
        var b = PassphraseHash.Create(Passphrase);
        Assert.NotEqual(a, b);
        Assert.True(PassphraseHash.Verify(Passphrase, a));
        Assert.True(PassphraseHash.Verify(Passphrase, b));
        Assert.False(PassphraseHash.Verify(Passphrase + " ", a));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("{}")]
    [InlineData("{\"v\":1,\"kdf\":\"pbkdf2-sha256\",\"iterations\":600000,\"salt\":\"!!\",\"hash\":\"!!\"}")]
    [InlineData("{\"v\":2,\"kdf\":\"pbkdf2-sha256\",\"iterations\":600000,\"salt\":\"AAAAAAAAAAAAAAAAAAAAAA==\",\"hash\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\"}")]
    public void Corrupt_record_behaves_as_first_use(string corrupt)
    {
        _store.Save(Encoding.UTF8.GetBytes(corrupt));
        var vm = Create();
        Assert.True(vm.IsLocked);
        Assert.False(vm.HasPassphrase);
        Assert.False(vm.TryUnlock(Passphrase));
        Assert.True(vm.IsLocked);
        PressTimes(vm, UnlockGesture.PressCount);
        Assert.Equal(LockPrompt.SetPassphrase, vm.Prompt);
        Assert.True(vm.SetPassphrase(Passphrase, Passphrase));
        Assert.True(Create().HasPassphrase);
    }

    [Fact]
    public void Unreadable_store_behaves_as_first_use()
    {
        var vm = new WindowLockViewModel(new ThrowingStore());
        Assert.True(vm.IsLocked);
        Assert.False(vm.HasPassphrase);
        PressTimes(vm, UnlockGesture.PressCount);
        Assert.Equal(LockPrompt.SetPassphrase, vm.Prompt);
        Assert.False(vm.SetPassphrase(Passphrase, Passphrase)); // the write fails too: stays locked
        Assert.True(vm.IsLocked);
    }

    private sealed class ThrowingStore : IWindowLockStore
    {
        public byte[]? Load() => throw new IOException("unreadable");
        public void Save(byte[] record) => throw new IOException("unwritable");
    }
}

/// <summary>The lock changes only what the window shows; capture, upload and pairing are untouched by it.</summary>
public class MainViewModelWindowLockTests
{
    private const string Passphrase = "correct horse battery staple";
    private readonly FakeAgent _agent = new();
    private readonly FakeHost _host = new();
    private readonly FakeStartup _startup = new();
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-10-10T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));

    private MainViewModel Create(IWindowLockStore? store = null) =>
        new(_agent, _host, ImmediateDispatcher.Instance, _startup, () => Task.FromResult<string?>(null), @"C:\IVY\Ivy.App.exe", "1.2.3", _time,
            lockStore: store);

    /// <summary>Everything the lock must not change: collector rows, run state, host pause, and the fakes' call logs.</summary>
    private string Snapshot(MainViewModel vm)
    {
        var sb = new StringBuilder();
        foreach (var r in vm.Collectors)
            sb.Append(r.Name).Append('|').Append(r.Enabled).Append('|').Append(r.Status).Append('|').Append(r.StatusText).Append('|')
              .Append(r.DetailText).Append('|').Append(r.LastCaptureText).Append('|').Append(r.LastUploadText).Append('|')
              .Append(r.QueueDepthText).Append('\n');
        sb.Append("running=").Append(vm.IsRunning).Append(" run=").Append(vm.RunStateText).Append(" hostPaused=").Append(_host.Paused)
          .Append(" starts=").Append(_host.Starts).Append(" enabled=").Append(_host.EnabledCalls.Count).Append(" applied=").Append(_host.Applied.Count)
          .Append(" syncs=").Append(_agent.SyncCalls).Append(" unpairs=").Append(_agent.Unpairs).Append(" uploadsPaused=").Append(_agent.UploadsPaused)
          .Append(" startupCmd=").Append(_startup.Command).Append('\n');
        sb.Append("agent:").AppendJoin(',', _agent.Threads.Calls.Select(c => c.Op)).Append('\n');
        sb.Append("host:").AppendJoin(',', _host.Threads.Calls.Select(c => c.Op)).Append('\n');
        sb.Append("startup:").AppendJoin(',', _startup.Threads.Calls.Select(c => c.Op)).Append('\n');
        return sb.ToString();
    }

    [Fact]
    public async Task Locking_and_unlocking_changes_only_what_the_window_shows()
    {
        _agent.IsPaired = true;
        var vm = Create();
        await vm.StartAsync();
        await vm.LastHostWork;
        await vm.Settings.LastWork;

        var before = Snapshot(vm);
        Assert.True(vm.Lock.IsLocked);
        Assert.False(vm.ShowMain);
        Assert.True(vm.ShowLocked);
        Assert.False(vm.ShowPairing);

        var raised = new List<string?>();
        vm.PropertyChanged += (_, e) => raised.Add(e.PropertyName);

        for (var i = 0; i < UnlockGesture.PressCount; i++) vm.Lock.Press();
        Assert.Equal(LockPrompt.SetPassphrase, vm.Lock.Prompt);
        Assert.True(vm.Lock.SetPassphrase(Passphrase, Passphrase));
        Assert.True(vm.ShowMain);
        Assert.False(vm.ShowLocked);
        Assert.False(vm.ShowPairing);
        Assert.Contains(nameof(MainViewModel.ShowMain), raised);
        Assert.Contains(nameof(MainViewModel.ShowLocked), raised);
        Assert.Equal(before, Snapshot(vm));

        raised.Clear();
        vm.Lock.Lock();
        Assert.False(vm.ShowMain);
        Assert.True(vm.ShowLocked);
        Assert.False(vm.ShowPairing);
        Assert.Contains(nameof(MainViewModel.ShowMain), raised);
        Assert.Contains(nameof(MainViewModel.ShowLocked), raised);
        Assert.Equal(before, Snapshot(vm));

        for (var i = 0; i < UnlockGesture.PressCount; i++) vm.Lock.Press();
        Assert.Equal(LockPrompt.EnterPassphrase, vm.Lock.Prompt);
        Assert.True(vm.Lock.TryUnlock(Passphrase));
        Assert.True(vm.ShowMain);
        Assert.False(vm.ShowLocked);
        Assert.False(vm.ShowPairing);

        await vm.RefreshAsync();
        Assert.Equal(before, Snapshot(vm));
    }

    [Fact]
    public async Task Unpaired_window_shows_pairing_whatever_the_lock_state()
    {
        var store = new InMemoryWindowLockStore();
        var vm = Create(store);
        await vm.StartAsync();
        Assert.True(vm.Lock.IsLocked);
        Assert.True(vm.ShowPairing);
        Assert.False(vm.ShowLocked);
        Assert.False(vm.ShowMain);

        for (var i = 0; i < UnlockGesture.PressCount; i++) vm.Lock.Press();
        Assert.True(vm.Lock.SetPassphrase(Passphrase, Passphrase));
        Assert.True(vm.ShowPairing);
        Assert.False(vm.ShowLocked);
        Assert.False(vm.ShowMain);

        vm.Lock.Lock();
        Assert.True(vm.ShowPairing);
        Assert.False(vm.ShowLocked);
        Assert.False(vm.ShowMain);
    }
}
