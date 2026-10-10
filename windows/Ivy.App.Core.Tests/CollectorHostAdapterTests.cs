using Ivy.App.Core.Hosting;
using Ivy.App.Hosting;
using Ivy.Core.Agent;
using Ivy.Core.KeyStore;

namespace Ivy.App.Core.Tests;

/// <summary>Runs Ivy.App's adapter (linked source) against the real Ivy.Collectors CollectorHost, unpaired.</summary>
public class CollectorHostAdapterTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    private VaultAgent NewAgent() =>
        new(new VaultAgentOptions { DataDirectory = Path.Combine(_dir.Path, "data") }, new FileKeyStore(Path.Combine(_dir.Path, "keys")));

    [Fact]
    public async Task Rows_settings_pause_and_enable_round_trip()
    {
        var folder = Directory.CreateDirectory(Path.Combine(_dir.Path, "docs")).FullName;
        var shots = Directory.CreateDirectory(Path.Combine(_dir.Path, "shots")).FullName;
        await using (var agent = NewAgent())
        {
            await agent.StartAsync();
            var host = CollectorHostAdapter.Create(agent, null);
            await host.StartAsync();

            var rows = host.Collectors();
            Assert.Equal(new[] { "files", "line", "notifications", "screenshots", "telegram", "usage" }, rows.Select(r => r.Name).OrderBy(n => n, StringComparer.Ordinal));
            Assert.All(rows, r => Assert.True(r.Enabled));
            Assert.All(rows, r => Assert.NotNull(r.ExpectedInterval));
            Assert.Same(agent.CollectorConfigHandler, ((CollectorHostAdapter)host).Host); // registered for collector_config commands

            var s = host.GetSettings();
            Assert.Empty(s.IndexedRoots);
            Assert.True(s.WindowTitleCapture);
            Assert.NotEmpty(s.TitleExclusions); // collector defaults (KeePass*, InPrivate, ...)
            Assert.Contains("node_modules", s.FileExclusions); // files collector defaults (fourth run: editable on the Files page)

            await host.ApplySettingsAsync(s with
            {
                IndexedRoots = new[] { folder },
                ScreenshotRoots = new[] { shots },
                WindowTitleCapture = false,
                TitleExclusions = new[] { "secret.exe" },
                FileExclusions = s.FileExclusions.Append("*.iso").ToList(),
            });
            var back = host.GetSettings();
            Assert.Equal(new[] { folder }, back.IndexedRoots);
            Assert.Equal(new[] { shots }, back.ScreenshotRoots);
            Assert.False(back.WindowTitleCapture);
            Assert.Equal(new[] { "secret.exe" }, back.TitleExclusions);
            Assert.Equal("*.iso", back.FileExclusions[^1]);
            Assert.Equal(s.FileExclusions.Count + 1, back.FileExclusions.Count);

            // media policy (PLAN decision 8) maps onto the files collector's settings
            Assert.True(back.AutoUploadImages);
            Assert.Equal(25, back.ImageCapMB);
            Assert.Equal(10, back.DocumentCapMB);
            await host.ApplySettingsAsync(back with
            {
                AutoUploadImages = false, ImageCapMB = 8, AutoUploadDocuments = true, DocumentCapMB = 0.5,
                ImageExtensions = new[] { "png", "webp" }, DocumentExtensions = new[] { "pdf" },
            });
            var files = ((CollectorHostAdapter)host).Host.Get<Ivy.Collectors.Files.FileIndexCollector>().Settings;
            Assert.False(files.AutoUploadImages);
            Assert.Equal(8, files.ImageCapMB);
            Assert.Equal(0.5, files.DocumentCapMB);
            Assert.Equal(new[] { "png", "webp" }, files.ImageExtensions);
            Assert.Equal(new[] { "pdf" }, files.DocumentExtensions);
            Assert.Equal(new[] { folder }, files.Roots);
            var bad = await Record.ExceptionAsync(() => host.ApplySettingsAsync(host.GetSettings() with { DocumentCapMB = 0 }));
            Assert.IsType<ArgumentException>(bad);
            Assert.Equal(0.5, host.GetSettings().DocumentCapMB);

            await host.PauseAsync();
            Assert.True(host.Paused);
            await host.ResumeAsync();
            Assert.False(host.Paused);

            await host.SetEnabledAsync("usage", false);
            Assert.False(host.Collectors().Single(r => r.Name == "usage").Enabled);
            await host.DisposeAsync();
        }

        // Settings and the enabled flag persist in vault-agent.db and come back with a fresh host.
        await using (var agent = NewAgent())
        {
            await agent.StartAsync();
            var host = CollectorHostAdapter.Create(agent, null);
            await host.StartAsync();
            var s = host.GetSettings();
            Assert.Equal(new[] { folder }, s.IndexedRoots);
            Assert.False(s.WindowTitleCapture);
            Assert.False(s.AutoUploadImages);
            Assert.Equal(new[] { "pdf" }, s.DocumentExtensions);
            Assert.False(host.Collectors().Single(r => r.Name == "usage").Enabled);
            await host.DisposeAsync();
        }
    }

    [Fact]
    public async Task Rejected_settings_surface_as_argument_exceptions()
    {
        await using var agent = NewAgent();
        await agent.StartAsync();
        var host = CollectorHostAdapter.Create(agent, null);
        await host.StartAsync();
        var s = host.GetSettings();
        var e = await Record.ExceptionAsync(() => host.ApplySettingsAsync(s with { IndexedRoots = new[] { "relative/path" } }));
        // The files collector validates roots; whatever it decides, a rejection must arrive as ArgumentException.
        if (e is not null) Assert.IsType<ArgumentException>(e);
        await host.DisposeAsync();
    }

    [Fact]
    public async Task No_import_reported_before_any_scan()
    {
        await using var agent = NewAgent();
        await agent.StartAsync();
        var host = CollectorHostAdapter.Create(agent, null);
        Assert.Null(host.FileImport);
        await host.DisposeAsync();
    }
}
