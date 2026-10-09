namespace Ivy.App.Core.Tests;

public class FormatTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-10T12:00:00Z");

    [Theory]
    [InlineData(-5, "0 B")]
    [InlineData(0, "0 B")]
    [InlineData(1023, "1023 B")]
    [InlineData(1024, "1.0 KB")]
    [InlineData(1536, "1.5 KB")]
    [InlineData(32L * 1024 * 1024, "32.0 MB")]
    [InlineData(5L * 1024 * 1024 * 1024, "5.0 GB")]
    public void Bytes(long n, string expected) => Assert.Equal(expected, Fmt.Bytes(n));

    [Fact]
    public void Ago()
    {
        Assert.Equal("never", Fmt.Ago(null, Now));
        Assert.Equal("just now", Fmt.Ago(Now, Now));
        Assert.Equal("just now", Fmt.Ago(Now.AddSeconds(3), Now)); // clock skew
        Assert.Equal("42s ago", Fmt.Ago(Now.AddSeconds(-42), Now));
        Assert.Equal("5m ago", Fmt.Ago(Now.AddMinutes(-5).AddSeconds(-10), Now));
        Assert.Equal("3h ago", Fmt.Ago(Now.AddHours(-3), Now));
        Assert.Equal("2d ago", Fmt.Ago(Now.AddDays(-2), Now));
    }

    [Fact]
    public void Clock_and_stamp_use_the_given_zone()
    {
        Assert.Equal("12:00:00", Fmt.Clock(Now, TimeZoneInfo.Utc));
        Assert.Equal("2026-10-10 12:00:00", Fmt.Stamp(Now, TimeZoneInfo.Utc));
        Assert.Equal("never", Fmt.StampAgo(null, Now, TimeZoneInfo.Utc));
        Assert.Equal("2026-10-10 11:59:00 (1m ago)", Fmt.StampAgo(Now.AddMinutes(-1), Now, TimeZoneInfo.Utc));
    }

    [Theory]
    [InlineData("", 0L)]
    [InlineData("  ", 0L)]
    [InlineData("0", 0L)]
    [InlineData("512", 512L * 1024)]
    [InlineData(" 100 ", 100L * 1024)]
    [InlineData("-1", null)]
    [InlineData("1.5", null)]
    [InlineData("abc", null)]
    [InlineData("99999999999999999999", null)]
    public void Parse_bandwidth(string text, long? expected) => Assert.Equal(expected, Fmt.ParseBandwidthKBps(text));

    [Fact]
    public void Bandwidth_display()
    {
        Assert.Equal("unlimited", Fmt.Bandwidth(0));
        Assert.Equal("512.0 KB/s", Fmt.Bandwidth(512 * 1024));
        Assert.Equal("0", Fmt.BandwidthKBps(0));
        Assert.Equal("512", Fmt.BandwidthKBps(512 * 1024));
    }

    [Fact]
    public void Percent_is_clamped()
    {
        Assert.Equal(0, Fmt.Percent(5, 0));
        Assert.Equal(50, Fmt.Percent(5, 10));
        Assert.Equal(100, Fmt.Percent(15, 10));
        Assert.Equal(0, Fmt.Percent(-1, 10));
    }

    [Fact]
    public void Strip_whitespace_from_pasted_codes()
    {
        Assert.Equal("IVYPAIR1.abcdef", Fmt.StripWhitespace("  IVYPAIR1.abc\r\n def \t"));
        Assert.Equal("", Fmt.StripWhitespace(null));
    }
}

public class StatusRulesTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-10T12:00:00Z");
    private static readonly TimeSpan I = TimeSpan.FromSeconds(30);

    [Fact]
    public void Off_beats_everything()
    {
        Assert.Equal(CollectorStatus.Off, StatusRules.Evaluate(false, true, true, "boom", Now, I, Now).Status);
    }

    [Fact]
    public void Paused_then_error_then_running_checks()
    {
        Assert.Equal(CollectorStatus.Paused, StatusRules.Evaluate(true, true, true, "boom", Now, I, Now).Status);
        var err = StatusRules.Evaluate(true, false, true, "access denied", Now, I, Now);
        Assert.Equal(CollectorStatus.Error, err.Status);
        Assert.Equal("error: access denied", err.Text);
        Assert.Equal((CollectorStatus.Stale, "not running"), StatusRules.Evaluate(true, false, false, null, Now, I, Now));
        Assert.Equal((CollectorStatus.Stale, "no run yet"), StatusRules.Evaluate(true, false, true, null, null, I, Now));
    }

    [Fact]
    public void Stale_after_more_than_two_intervals()
    {
        Assert.Equal(CollectorStatus.Ok, StatusRules.Evaluate(true, false, true, null, Now.AddSeconds(-60), I, Now).Status);
        Assert.Equal(CollectorStatus.Stale, StatusRules.Evaluate(true, false, true, null, Now.AddSeconds(-61), I, Now).Status);
    }

    [Fact]
    public void Fast_tickers_use_the_floor()
    {
        var oneSecond = TimeSpan.FromSeconds(1);
        Assert.Equal(CollectorStatus.Ok, StatusRules.Evaluate(true, false, true, null, Now.AddSeconds(-30), oneSecond, Now).Status);
        Assert.Equal(CollectorStatus.Stale, StatusRules.Evaluate(true, false, true, null, Now.AddSeconds(-31), oneSecond, Now).Status);
        Assert.Equal(CollectorStatus.Ok, StatusRules.Evaluate(true, false, true, null, Now.AddSeconds(-30), TimeSpan.Zero, Now).Status);
    }

    [Fact]
    public void Colors()
    {
        Assert.Equal(StatusRules.Green, StatusRules.Color(CollectorStatus.Ok));
        Assert.Equal(StatusRules.Amber, StatusRules.Color(CollectorStatus.Stale));
        Assert.Equal(StatusRules.Red, StatusRules.Color(CollectorStatus.Error));
        Assert.Equal(StatusRules.Grey, StatusRules.Color(CollectorStatus.Off));
        Assert.Equal(StatusRules.Grey, StatusRules.Color(CollectorStatus.Paused));
    }
}

public class StartupCommandTests
{
    private const string Exe = @"C:\Users\b\AppData\Local\IVY\app\Ivy.App.exe";

    [Fact]
    public void Build_quotes_path_and_adds_minimized()
    {
        Assert.Equal("\"" + Exe + "\" --minimized", StartupCommand.Build(Exe));
    }

    [Fact]
    public void PointsAt()
    {
        Assert.True(StartupCommand.PointsAt(StartupCommand.Build(Exe), Exe));
        Assert.True(StartupCommand.PointsAt(StartupCommand.Build(Exe.ToUpperInvariant()), Exe));
        Assert.True(StartupCommand.PointsAt(@"C:\ivy\Ivy.App.exe --minimized", @"C:\ivy\Ivy.App.exe"));
        Assert.False(StartupCommand.PointsAt(@"""C:\old\Ivy.App.exe"" --minimized", Exe));
        Assert.False(StartupCommand.PointsAt(null, Exe));
        Assert.False(StartupCommand.PointsAt("  ", Exe));
    }

    [Fact]
    public void Minimized_switch()
    {
        Assert.True(StartupCommand.IsMinimizedLaunch(new[] { "--MINIMIZED" }));
        Assert.False(StartupCommand.IsMinimizedLaunch(Array.Empty<string>()));
    }
}
