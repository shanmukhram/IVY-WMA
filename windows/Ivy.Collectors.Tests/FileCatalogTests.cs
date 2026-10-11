using Ivy.Collectors.Common;
using Ivy.Collectors.Files;
using Ivy.Collectors.Host;
using Ivy.Collectors.Tests.Support;
using Ivy.Core.Protocol;
using Ivy.Core.Records;

namespace Ivy.Collectors.Tests;

public class FileCatalogTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly TestEnv _env;
    private readonly string _root;

    public FileCatalogTests()
    {
        _env = new TestEnv(_dir);
        _root = _dir.Sub("tree");
        Directory.CreateDirectory(_root);
    }

    public void Dispose() { _env.Dispose(); _dir.Dispose(); }

    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 8, 0, 0, TimeSpan.Zero);

    private FileCatalogCollector NewCollector(int batch = 1000)
    {
        var c = new FileCatalogCollector(_env.Context);
        Apply(c, batch, _root);
        return c;
    }

    // apply settings the way the host does: merged over the collector's current settings
    private static void Apply(FileCatalogCollector c, int batch, params string[] roots) =>
        Apply(c, new System.Text.Json.Nodes.JsonObject
        {
            ["roots"] = new System.Text.Json.Nodes.JsonArray(roots.Select(r => (System.Text.Json.Nodes.JsonNode?)r).ToArray()),
            ["scanBatchSize"] = batch,
        });

    private static void Apply(FileCatalogCollector c, System.Text.Json.Nodes.JsonObject patch) =>
        c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), patch));

    // catalog entries and deletions are carried in file_catalog batch records (entries[] / deletions[])
    private IEnumerable<System.Text.Json.JsonElement> Entries() =>
        _env.Sink.Of(Kind.FileCatalog).SelectMany(r => r.Root.GetProperty("entries").EnumerateArray());
    private IReadOnlyList<string> CataloguedNames() =>
        Entries().Select(e => e.GetProperty("name").GetString()!).OrderBy(n => n, StringComparer.Ordinal).ToList();
    private IReadOnlyList<string> DeletedNames() =>
        _env.Sink.Of(Kind.FileCatalog).SelectMany(r => r.Root.GetProperty("deletions").EnumerateArray())
            .Select(p => System.IO.Path.GetFileName(p.GetString()!)).OrderBy(n => n, StringComparer.Ordinal).ToList();

    [Fact]
    public async Task First_scan_catalogues_every_admitted_file_metadata_only()
    {
        _dir.Write("tree/a.txt", "alpha", T0);
        _dir.Write("tree/sub/b.md", "bravo", T0);
        _dir.Write("tree/node_modules/pkg/index.js", "excluded", T0);
        _dir.Write("tree/.git/config", "[core]", T0);

        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();

        Assert.Equal(new[] { "a.txt", "b.md" }, CataloguedNames()); // node_modules and .git excluded by default
        foreach (var e in Entries())
        {
            // each entry is metadata only: path, name, ext, size, mtime — nothing else
            Assert.True(e.TryGetProperty("path", out _) && e.TryGetProperty("name", out _) && e.TryGetProperty("ext", out _)
                        && e.TryGetProperty("size", out _) && e.TryGetProperty("mtime", out _));
            Assert.False(e.TryGetProperty("quickHash", out _));
            Assert.False(e.TryGetProperty("thumbBlobOid", out _));
        }
    }

    [Fact]
    public async Task Import_phase_is_a_protocol_phase_during_initial_and_rescan_passes()
    {
        for (var i = 0; i < 5; i++) _dir.Write($"tree/f{i}.txt", "x" + i, T0);
        var c = NewCollector(batch: 2);
        await c.StartAsync(default);

        c.ScanTick(); // mid first pass
        Assert.NotNull(c.CurrentScan);
        Assert.NotNull(c.Import);
        Assert.True(ImportPhases.IsValid(c.Import!.Phase));
        Assert.Equal(ImportPhases.Initial, c.Import.Phase);

        c.RunScanToCompletion();
        await c.RescanAsync(null, default);
        c.ScanTick(); // mid later pass
        Assert.NotNull(c.Import);
        Assert.True(ImportPhases.IsValid(c.Import!.Phase));
        Assert.Equal(ImportPhases.Rescan, c.Import.Phase);
    }

    [Fact]
    public async Task Unchanged_files_are_not_re_emitted()
    {
        _dir.Write("tree/a.txt", "alpha", T0);
        _dir.Write("tree/b.txt", "bravo", T0);
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        _env.Sink.Clear();

        await c.RescanAsync(null, default); // force a second pass; nothing changed on disk
        c.RunScanToCompletion();
        Assert.Empty(_env.Sink.Of(Kind.FileCatalog));
    }

    [Fact]
    public async Task Changed_file_re_emits_only_itself()
    {
        _dir.Write("tree/a.txt", "alpha", T0);
        _dir.Write("tree/b.txt", "bravo", T0);
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        _env.Sink.Clear();

        _dir.Write("tree/a.txt", "alpha changed, bigger now", T0.AddMinutes(5)); // new size and mtime
        await c.RescanAsync(null, default);
        c.RunScanToCompletion();

        Assert.Equal(new[] { "a.txt" }, CataloguedNames());
        Assert.Empty(DeletedNames());
    }

    [Fact]
    public async Task Removed_file_emits_a_catalog_deletion()
    {
        _dir.Write("tree/a.txt", "alpha", T0);
        _dir.Write("tree/b.txt", "bravo", T0);
        var c = NewCollector();
        await c.StartAsync(default);
        c.RunScanToCompletion();
        _env.Sink.Clear();

        File.Delete(_dir.Sub("tree", "b.txt"));
        await c.RescanAsync(null, default);
        c.RunScanToCompletion();

        Assert.Equal(new[] { "b.txt" }, DeletedNames());
        // the deletion is carried as a path in a batch's deletions[], with no re-listed entry
        Assert.DoesNotContain("b.txt", CataloguedNames());
    }

    [Fact]
    public async Task Large_tree_resumes_across_ticks_without_duplicates_or_misses()
    {
        for (var i = 0; i < 25; i++) _dir.Write($"tree/d{i % 4}/f{i:00}.txt", $"file {i}", T0);

        var c = NewCollector(batch: 4); // several ticks to finish
        await c.StartAsync(default);
        var ticks = 0;
        while (c.CurrentScan is not null || ticks == 0)
        {
            c.ScanTick();
            if (++ticks > 100) break; // guard
            if (ticks == 2)
            {
                // simulate a restart mid-scan: a fresh collector resumes from the persisted checkpoint
                c = NewCollector(batch: 4);
                await c.StartAsync(default);
            }
        }

        var names = CataloguedNames();
        Assert.Equal(25, names.Count);
        Assert.Equal(25, names.Distinct().Count()); // no duplicates across the restart
        for (var i = 0; i < 25; i++) Assert.Contains($"f{i:00}.txt", names);
    }

    [Fact]
    public async Task Relaunch_with_identical_settings_resumes_the_saved_pass_and_does_not_restart()
    {
        for (var i = 0; i < 25; i++) _dir.Write($"tree/d{i % 4}/f{i:00}.txt", $"file {i}", T0);
        var c = NewCollector(batch: 4);
        await c.StartAsync(default);
        await c.TickAsync(default);
        await c.TickAsync(default); // mid first pass
        var saved = c.CurrentScan!;
        var (gen, rootIndex, checkpoint, seen) = (saved.Generation, saved.RootIndex, saved.Checkpoint, saved.FilesSeen);
        Assert.NotNull(checkpoint);
        Assert.True(saved.Initial);

        // relaunch: the host applies the saved settings (here twice, identical) before StartAsync
        c = NewCollector(batch: 4);
        Apply(c, batch: 4, _root);
        await c.StartAsync(default);
        var resumed = c.CurrentScan!;
        Assert.Equal(gen, resumed.Generation);
        Assert.Equal(rootIndex, resumed.RootIndex);
        Assert.Equal(checkpoint, resumed.Checkpoint);
        Assert.Equal(seen, resumed.FilesSeen);
        Assert.True(resumed.Initial);

        for (var t = 0; t < 100 && c.CurrentScan is not null; t++)
        {
            Assert.Equal(gen, c.CurrentScan.Generation); // the same pass throughout
            await c.TickAsync(default);
        }
        Assert.Null(c.CurrentScan);
        var names = CataloguedNames();
        Assert.Equal(25, names.Count);
        Assert.Equal(25, names.Distinct().Count()); // continued from the checkpoint: nothing listed twice

        // and once it completes, no new pass starts by itself
        _env.Sink.Clear();
        for (var t = 0; t < 5; t++) await c.TickAsync(default);
        Assert.Null(c.CurrentScan);
        Assert.Empty(_env.Sink.Of(Kind.FileCatalog));

        // nor after another relaunch with the same settings
        c = NewCollector(batch: 4);
        await c.StartAsync(default);
        await c.TickAsync(default);
        Assert.Null(c.CurrentScan);
    }

    [Fact]
    public async Task Roots_change_after_start_restarts_with_a_new_generation()
    {
        for (var i = 0; i < 10; i++) _dir.Write($"tree/f{i}.txt", "x" + i, T0);
        _dir.Write("tree2/other.txt", "other", T0);
        var c = NewCollector(batch: 4);
        await c.StartAsync(default);
        await c.TickAsync(default); // mid first pass
        var gen = c.CurrentScan!.Generation;

        Apply(c, batch: 4, _root, _dir.Sub("tree2"));
        await c.TickAsync(default);
        Assert.NotNull(c.CurrentScan);
        Assert.Equal(gen + 1, c.CurrentScan!.Generation);

        c.RunScanToCompletion();
        Assert.Contains("other.txt", CataloguedNames());

        // after a completed pass, another real change also starts a new pass
        Apply(c, batch: 4, _root);
        await c.TickAsync(default);
        Assert.Equal(gen + 2, c.CurrentScan!.Generation);
    }

    [Fact]
    public async Task Reordered_or_recased_roots_and_budget_changes_do_not_restart()
    {
        for (var i = 0; i < 12; i++) _dir.Write($"tree/d{i % 3}/f{i:00}.txt", "x" + i, T0);
        _dir.Write("tree2/other.txt", "other", T0);
        var tree2 = _dir.Sub("tree2");
        var c = new FileCatalogCollector(_env.Context);
        Apply(c, batch: 4, _root, tree2);
        await c.StartAsync(default);
        await c.TickAsync(default); // mid first pass
        var (gen, checkpoint) = (c.CurrentScan!.Generation, c.CurrentScan.Checkpoint);

        // budgets, batch size and rescan period are not part of what the pass walks
        Apply(c, new System.Text.Json.Nodes.JsonObject { ["scanBatchSize"] = 5, ["fullRescanHours"] = 6 });
        Assert.Equal(gen, c.CurrentScan!.Generation);
        Assert.Equal(checkpoint, c.CurrentScan.Checkpoint);

        // the same roots in a different order (and, on Windows, different case / trailing separator)
        var root = OperatingSystem.IsWindows() ? _root.ToUpperInvariant() + Path.DirectorySeparatorChar : _root;
        Apply(c, batch: 5, tree2, root);
        Assert.Equal(gen, c.CurrentScan!.Generation);
        Assert.Equal(checkpoint, c.CurrentScan.Checkpoint);

        // the same exclusions in a different order
        var reversed = FileCatalogSettings.CatalogExclusions.Reverse().Select(e => (System.Text.Json.Nodes.JsonNode?)e).ToArray();
        Apply(c, new System.Text.Json.Nodes.JsonObject { ["exclusions"] = new System.Text.Json.Nodes.JsonArray(reversed) });
        Assert.Equal(gen, c.CurrentScan!.Generation);

        for (var t = 0; t < 100 && c.CurrentScan is not null; t++)
        {
            Assert.Equal(gen, c.CurrentScan.Generation);
            await c.TickAsync(default);
        }
        var names = CataloguedNames();
        Assert.Equal(13, names.Count);
        Assert.Equal(13, names.Distinct().Count());
    }

    [Fact]
    public async Task Saved_pass_is_discarded_when_roots_changed_while_not_running()
    {
        for (var i = 0; i < 10; i++) _dir.Write($"tree/f{i}.txt", "x" + i, T0);
        _dir.Write("tree2/other.txt", "other", T0);
        var c = NewCollector(batch: 4);
        await c.StartAsync(default);
        await c.TickAsync(default); // mid first pass, saved
        var gen = c.CurrentScan!.Generation;

        // relaunch with different saved roots: the saved pass was for another scope, so a new one starts
        c = new FileCatalogCollector(_env.Context);
        Apply(c, batch: 4, _dir.Sub("tree2"));
        await c.StartAsync(default);
        Assert.Null(c.CurrentScan);
        await c.TickAsync(default);
        Assert.Contains("other.txt", CataloguedNames());
    }
}
