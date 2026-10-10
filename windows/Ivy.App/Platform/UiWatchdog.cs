using System.Diagnostics;
using System.Runtime.InteropServices;
using Ivy.App.Core.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.UI.Dispatching;

namespace Ivy.App.Platform;

/// <summary>
/// Hang watchdog for the WinUI thread (second Windows run: AppHangB1 with nothing in the log). A background
/// thread posts a heartbeat through the DispatcherQueue once a second; <see cref="UiWatchdogMonitor"/> decides
/// what to log. Unacknowledged for 5 s: "UI unresponsive since ..." with the UI thread's breadcrumb, and one
/// minidump per incident (<c>%LOCALAPPDATA%\IVY\logs\ivy-app-hang-&lt;utc&gt;.dmp</c>, thread info and memory-region
/// info, written by this process about itself). Recovery: "UI recovered after N ms". Once a minute a
/// heartbeat line with the last UI sample. Logs carry timings and identifiers only.
/// </summary>
internal sealed class UiWatchdog : IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(1);
    private readonly DispatcherQueue _ui;
    private readonly int _uiThreadId;
    private readonly Func<UiSample> _sample;
    private readonly ILogger _log;
    private readonly string _dumpDirectory;
    private readonly UiWatchdogMonitor _monitor = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly Thread _thread;
    private readonly DispatcherQueueHandler _beat;

    /// <summary>Create on the UI thread. <paramref name="sample"/> runs on the UI thread with each heartbeat.</summary>
    public UiWatchdog(DispatcherQueue ui, Func<UiSample> sample, ILogger log, string dumpDirectory)
    {
        _ui = ui;
        _uiThreadId = Environment.CurrentManagedThreadId;
        _sample = sample;
        _log = log;
        _dumpDirectory = dumpDirectory;
        _beat = Beat;
        _thread = new Thread(Loop) { IsBackground = true, Name = "IVY UI watchdog", Priority = ThreadPriority.AboveNormal };
    }

    public void Start() => _thread.Start();

    /// <summary>UI thread: acknowledge and sample the window.</summary>
    private void Beat()
    {
        UiSample s;
        try { s = _sample(); }
        catch (Exception) { s = new UiSample(-1, false, null); }
        _monitor.Acknowledge(DateTimeOffset.UtcNow, s);
    }

    private void Loop()
    {
        while (!_stop.IsCancellationRequested)
        {
            try { StepOnce(); }
            catch (Exception e) { _log.LogWarning(e, "watchdog step failed"); }
            if (_stop.Token.WaitHandle.WaitOne(Interval)) break;
        }
    }

    private void StepOnce()
    {
        var now = DateTimeOffset.UtcNow;
        var step = _monitor.Step(now, () => UiBreadcrumb.Describe(_uiThreadId), OtherThreads);
        if (step.PostHeartbeat && !_ui.TryEnqueue(DispatcherQueuePriority.Normal, _beat))
        {
            _monitor.PostFailed();
            if (!_stop.IsCancellationRequested) _log.LogWarning("watchdog: the UI dispatcher refused the heartbeat");
        }
        if (step.Info is not null) _log.LogInformation("{Line}", step.Info);
        if (step.Warning is not null) _log.LogWarning("{Line}", step.Warning);
        if (step.WriteDump) WriteDump(now);
    }

    private IEnumerable<string> OtherThreads()
    {
        var ts = Stopwatch.GetTimestamp();
        return UiBreadcrumb.All()
            .Where(c => c.ThreadId != _uiThreadId)
            .Select(c => "thread " + c.ThreadId + ": " + UiBreadcrumb.Describe(c, ts));
    }

    private void WriteDump(DateTimeOffset now)
    {
        var path = Path.Combine(_dumpDirectory, HangReport.DumpFileName(now));
        try
        {
            Directory.CreateDirectory(_dumpDirectory);
            using var fs = new FileStream(path, FileMode.Create, FileAccess.ReadWrite, FileShare.None);
            using var process = Process.GetCurrentProcess();
            var ok = Win32.MiniDumpWriteDump(process.Handle, (uint)process.Id, fs.SafeFileHandle,
                Win32.MiniDumpWithThreadInfo | Win32.MiniDumpWithFullMemoryInfo, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (ok) _log.LogWarning("watchdog: hang dump written ({File}, {Bytes} bytes)", Path.GetFileName(path), fs.Length);
            else _log.LogWarning("watchdog: MiniDumpWriteDump failed (HRESULT 0x{Error:X8})", Marshal.GetHRForLastWin32Error());
        }
        catch (Exception e)
        {
            _log.LogWarning("watchdog: hang dump failed: {Type}", e.GetType().Name);
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        if (Thread.CurrentThread != _thread && _thread.IsAlive) _thread.Join(TimeSpan.FromSeconds(2));
    }
}
