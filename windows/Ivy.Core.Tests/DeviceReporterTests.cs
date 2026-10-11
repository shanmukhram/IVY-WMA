using System.Text.Json;
using Ivy.Core.Agent;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Sink;
using Ivy.Core.Storage;
using Ivy.Core.Tests.Support;

namespace Ivy.Core.Tests;

public class DeviceReporterTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Default_report_interval_is_30_seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(30), new DeviceReporterOptions().Interval);
    }

    [Fact]
    public void Collector_with_invalid_phase_is_reported_with_phase_nulled()
    {
        using var p = new AgentProcess(_dir.Path);
        var states = new CollectorStateStore(p.Db);
        states.Register("good");
        states.Register("bad");
        states.SetImport("good", new ImportProgress(10, 5, ImportPhases.Initial));
        states.SetImport("bad", new ImportProgress(null, 3, "cataloguing"));
        var sink = new RecordSink(p.Queue, _mac.PublicKey, "dev-1", p.Activity);
        var reporter = new DeviceReporter(sink, states, p.Queue);

        var r = reporter.ReportNow(); // must not throw RecordValidationException

        var item = p.Queue.All().Single(i => i.ObjectKey == r.ObjectKey);
        var json = _mac.Open(r.ObjectKey, File.ReadAllBytes(p.Queue.FullPathOf(item)), Kind.DeviceReport);
        using var doc = JsonDocument.Parse(json);
        var cols = doc.RootElement.GetProperty("collectors").EnumerateArray().ToDictionary(c => c.GetProperty("name").GetString()!);
        Assert.Equal("initial", cols["good"].GetProperty("phase").GetString());
        Assert.True(!cols["bad"].TryGetProperty("phase", out var ph) || ph.ValueKind == JsonValueKind.Null);
        Assert.Equal(3, cols["bad"].GetProperty("importDone").GetInt64());
    }
}
