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
        c.ApplySettings(CollectorHost.Merge(c.GetSettingsJson(), new System.Text.Json.Nodes.JsonObject
        {
            ["roots"] = new System.Text.Json.Nodes.JsonArray((System.Text.Json.Nodes.JsonNode?)_root),
            ["scanBatchSize"] = batch,
        }));
        return c;
    }

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
}
