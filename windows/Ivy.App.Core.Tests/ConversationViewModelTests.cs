using Ivy.App.Core.Hosting;
using Ivy.App.Core.ViewModels;

namespace Ivy.App.Core.Tests;

public class ConversationViewModelTests
{
    private static CollectorInfo Info(string name, string? error = null, string? detail = null, bool running = true) =>
        new() { Name = name, Enabled = true, Running = running, LastError = error, Detail = detail };

    [Fact]
    public async Task Shows_needs_passcode_and_applies_it()
    {
        var host = new FakeHost();
        var vm = new ConversationViewModel(host);
        vm.Update(Info("telegram", error: "Telegram Desktop local passcode required (enter it once in the IVY window)"), null);

        Assert.True(vm.TelegramNeedsPasscode);
        Assert.False(vm.ApplyPasscodeCommand.CanExecute(null));

        vm.PasscodeText = "hunter2";
        Assert.True(vm.ApplyPasscodeCommand.CanExecute(null));
        await vm.ApplyPasscodeCommand.ExecuteAsync(); // host work runs on the thread pool

        Assert.Equal(new[] { "hunter2" }, host.Passcodes);
        Assert.Equal("", vm.PasscodeText); // cleared after applying
    }

    [Fact]
    public async Task Line_key_applies_and_clears()
    {
        var host = new FakeHost();
        var vm = new ConversationViewModel(host);

        Assert.False(vm.ApplyLineKeyCommand.CanExecute(null));
        vm.LineKeyText = "0123456789abcdef0123456789abcdef";
        Assert.True(vm.ApplyLineKeyCommand.CanExecute(null));
        await vm.ApplyLineKeyCommand.ExecuteAsync();

        Assert.Equal(new[] { "0123456789abcdef0123456789abcdef" }, host.LineKeys);
        Assert.Equal("", vm.LineKeyText);
    }

    [Fact]
    public async Task Line_key_detect_reports_found_or_not()
    {
        var host = new FakeHost { LineKeyDetected = false };
        var vm = new ConversationViewModel(host);
        await vm.DetectLineKeyCommand.ExecuteAsync();
        Assert.Contains("no key found", vm.LineKeyStatusText);

        host.LineKeyDetected = true;
        await vm.DetectLineKeyCommand.ExecuteAsync();
        Assert.Contains("found", vm.LineKeyStatusText);
        Assert.Contains("detected", host.LineKeys);
    }

    [Fact]
    public async Task Include_channels_toggle_pushes_to_host()
    {
        var host = new FakeHost { IncludeChannels = true };
        var vm = new ConversationViewModel(host);
        Assert.True(vm.IncludeChannels);

        vm.IncludeChannels = false;
        await vm.LastWork;
        Assert.False(host.IncludeChannels);
    }

    [Fact]
    public void Update_does_not_echo_include_channels_back_to_host()
    {
        var host = new FakeHost { IncludeChannels = false };
        var vm = new ConversationViewModel(host);
        // A refresh should mirror the host value without re-invoking the setter path.
        vm.Update(Info("telegram"), Info("line"));
        Assert.False(vm.IncludeChannels);
    }

    [Fact]
    public async Task Line_probe_runs_and_report_opens()
    {
        var opened = new List<string>();
        var host = new FakeHost();
        var vm = new ConversationViewModel(host, opened.Add);

        Assert.False(vm.HasReport);
        Assert.False(vm.OpenReportCommand.CanExecute(null));

        await vm.RunProbeCommand.ExecuteAsync();
        Assert.Equal(1, host.ProbeRuns);
        Assert.True(vm.HasReport);
        Assert.True(vm.OpenReportCommand.CanExecute(null));

        vm.OpenReportCommand.Execute(null);
        Assert.Single(opened);
        Assert.Equal(host.LineReportPath, opened[0]);
    }

    [Fact]
    public void Status_text_prefers_error_then_detail()
    {
        var host = new FakeHost();
        var vm = new ConversationViewModel(host);
        vm.Update(Info("telegram", error: "session invalid: AUTH_KEY_UNREGISTERED"), Info("line", detail: "ok partial: 3 chats"));
        Assert.Contains("AUTH_KEY_UNREGISTERED", vm.TelegramStatusText);
        Assert.Equal("ok partial: 3 chats", vm.LineStatusText);
    }
}
