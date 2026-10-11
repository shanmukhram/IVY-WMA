using Ivy.App.Core.WindowLock;

namespace Ivy.App.Core.Tests;

public class BuiltInWindowLockStoreTests
{
    [Fact]
    public void Save_throws()
    {
        Assert.Throws<NotSupportedException>(() => new BuiltInWindowLockStore().Save([1, 2, 3]));
    }

    [Fact]
    public void Load_matches_the_built_in_constant()
    {
        var record = new BuiltInWindowLockStore().Load();
        if (string.IsNullOrWhiteSpace(WindowLockRecord.Json)) Assert.Null(record);
        else Assert.True(PassphraseHash.IsValid(record));
    }

    [Fact]
    public void View_model_over_the_built_in_store_starts_locked()
    {
        var vm = new WindowLockViewModel(new BuiltInWindowLockStore());
        Assert.True(vm.IsLocked);
        Assert.Equal(LockPrompt.None, vm.Prompt);
    }
}
