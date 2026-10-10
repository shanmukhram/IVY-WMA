using Ivy.App.Core.Hosting;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// The Overview page's status card and its InfoBars (fourth run). Recomputed by <see cref="MainViewModel"/> on every
/// refresh from the same snapshot as everything else, so the card and the other pages never disagree.
/// </summary>
public sealed class OverviewViewModel : ObservableObject
{
    public const string RunningLine = "Capturing and uploading. Closing this window keeps IVY running in the tray.";
    public const string PausedLine = "Paused. Nothing is captured or uploaded until you resume.";

    private string _mac = "not paired";
    private string _device = "not paired";
    private string _lastUpload = "never";
    private string _lastPoll = "never";
    private string _bucketState = "Not checked yet";
    private UiSeverity _bucketSeverity = UiSeverity.Informational;
    private bool _bucketProblem;
    private string _bucketProblemTitle = "";
    private string _bucketProblemMessage = "";
    private string _runStateLine = RunningLine;
    private bool _hasCollectorProblems;
    private string _collectorProblems = "";

    public string MacFingerprint { get => _mac; private set => Set(ref _mac, value); }
    public string DeviceFingerprint { get => _device; private set => Set(ref _device, value); }
    public string LastUploadText { get => _lastUpload; private set => Set(ref _lastUpload, value); }
    public string LastPollText { get => _lastPoll; private set => Set(ref _lastPoll, value); }

    /// <summary>"Reachable", "Uploads failing", "Command poll failing", "Not reachable" or "Not checked yet".</summary>
    public string BucketStateText { get => _bucketState; private set => Set(ref _bucketState, value); }
    public UiSeverity BucketSeverity
    {
        get => _bucketSeverity;
        private set { if (Set(ref _bucketSeverity, value)) Raise(nameof(BucketColor)); }
    }
    /// <summary>Status dot colour for the bucket line (same palette as the collector dots).</summary>
    public string BucketColor => _bucketSeverity switch
    {
        UiSeverity.Success => StatusRules.Green,
        UiSeverity.Warning => StatusRules.Amber,
        UiSeverity.Error => StatusRules.Red,
        _ => StatusRules.Grey,
    };
    /// <summary>True when the last up-bucket attempt failed or the last command poll failed (the InfoBar).</summary>
    public bool HasBucketProblem { get => _bucketProblem; private set => Set(ref _bucketProblem, value); }
    public string BucketProblemTitle { get => _bucketProblemTitle; private set => Set(ref _bucketProblemTitle, value); }
    public string BucketProblemMessage { get => _bucketProblemMessage; private set => Set(ref _bucketProblemMessage, value); }

    /// <summary>The sentence next to the Running/Paused switch.</summary>
    public string RunStateLine { get => _runStateLine; private set => Set(ref _runStateLine, value); }

    public bool HasCollectorProblems { get => _hasCollectorProblems; private set => Set(ref _hasCollectorProblems, value); }
    /// <summary>"2 collectors need attention: Files, LINE."</summary>
    public string CollectorProblemsText { get => _collectorProblems; private set => Set(ref _collectorProblems, value); }

    public void SetRunning(bool running) => RunStateLine = running ? RunningLine : PausedLine;

    public void SetFingerprints(string? device, string? mac)
    {
        DeviceFingerprint = string.IsNullOrEmpty(device) ? "not paired" : device!;
        MacFingerprint = string.IsNullOrEmpty(mac) ? "not paired" : mac!;
    }

    public void Update(AgentSnapshot snap, IEnumerable<CollectorRowViewModel> rows, DateTimeOffset now)
    {
        LastUploadText = Fmt.StampAgo(snap.LastUpPutAt, now);
        LastPollText = Fmt.StampAgo(snap.LastCmdListAt, now);

        var upFailing = snap.UpError is not null;
        var cmdFailing = snap.CmdError is not null;
        (BucketStateText, BucketSeverity) = (upFailing, cmdFailing) switch
        {
            (true, true) => ("Not reachable", UiSeverity.Error),
            (true, false) => ("Uploads failing", UiSeverity.Error),
            (false, true) => ("Command poll failing", UiSeverity.Warning),
            _ when snap.LastUpPutAt is null && snap.LastCmdListAt is null => ("Not checked yet", UiSeverity.Informational),
            _ => ("Reachable", UiSeverity.Success),
        };
        HasBucketProblem = upFailing || cmdFailing;
        BucketProblemTitle = upFailing && cmdFailing ? "The IVY buckets are not reachable"
            : upFailing ? "Uploads are failing" : cmdFailing ? "Command poll is failing" : "";
        var parts = new List<string>();
        if (upFailing) parts.Add("Last upload attempt failed " + Fmt.Ago(snap.UpErrorAt, now) + ": " + snap.UpError + ".");
        if (cmdFailing) parts.Add("Last command poll failed: " + snap.CmdError + ".");
        if (parts.Count > 0) parts.Add("Captures stay queued and encrypted on this PC and upload when the bucket is reachable again.");
        BucketProblemMessage = string.Join(" ", parts);

        var problems = rows.Where(r => r.HasProblem).Select(r => r.DisplayName).ToList();
        HasCollectorProblems = problems.Count > 0;
        CollectorProblemsText = problems.Count == 0 ? ""
            : (problems.Count == 1 ? "1 collector needs attention: " : problems.Count + " collectors need attention: ") + string.Join(", ", problems) + ".";
    }
}

/// <summary>Where IVY keeps its data and logs (Settings > Advanced). Empty strings hide the Open buttons' effect.</summary>
public sealed record AppFolders(string DataDirectory, string LogDirectory);
