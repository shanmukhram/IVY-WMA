using Ivy.App.Core.Diagnostics;
using Ivy.App.Core.Hosting;
using Ivy.Core.Protocol;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// Not-paired screen: one box for the pasted pairing string, a Pair button, a status line, and after
/// pairing both fingerprints for comparison with the Mac's screen (PRD WP1, PLAN decision 1).
/// </summary>
public sealed class PairingViewModel : ObservableObject
{
    private readonly IAgentView _agent;
    private readonly IUiDispatcher _ui;
    private string _pairingText = "";
    private string _status = "Paste the pairing string shown on the Mac, then press Pair.";
    private string _deviceFingerprint = "";
    private string _macFingerprint = "";
    private bool _busy;
    private bool _completed;

    public PairingViewModel(IAgentView agent, IUiDispatcher ui)
    {
        _agent = agent;
        _ui = ui;
        PairCommand = new AsyncRelayCommand(PairAsync, () => !_busy && !_completed && Fmt.StripWhitespace(_pairingText).Length > 0);
        ContinueCommand = new RelayCommand(() => Continued?.Invoke(this, EventArgs.Empty), () => _completed);
        _agent.DeviceFingerprintAvailable += (_, fp) => _ui.Post(() => DeviceFingerprint = fp);
    }

    public AsyncRelayCommand PairCommand { get; }
    public RelayCommand ContinueCommand { get; }

    /// <summary>Raised after a successful pairing once the user pressed Continue.</summary>
    public event EventHandler? Continued;
    /// <summary>Raised on the UI thread right after a successful pairing (before Continue).</summary>
    public event EventHandler? Paired;

    public string PairingText
    {
        get => _pairingText;
        set
        {
            if (Set(ref _pairingText, value ?? "")) PairCommand.RaiseCanExecuteChanged();
        }
    }

    public string Status { get => _status; private set => Set(ref _status, value); }
    public string DeviceFingerprint
    {
        get => _deviceFingerprint;
        private set
        {
            if (Set(ref _deviceFingerprint, value)) Raise(nameof(HasFingerprints));
        }
    }
    public string MacFingerprint
    {
        get => _macFingerprint;
        private set
        {
            if (Set(ref _macFingerprint, value)) Raise(nameof(HasFingerprints));
        }
    }
    public bool HasFingerprints => _deviceFingerprint.Length > 0 || _macFingerprint.Length > 0;
    public bool IsBusy { get => _busy; private set => Set(ref _busy, value); }
    public bool Completed { get => _completed; private set => Set(ref _completed, value); }
    public bool CanEdit => !_busy && !_completed;

    public async Task PairAsync()
    {
        var code = Fmt.StripWhitespace(_pairingText);
        if (code.Length == 0)
        {
            Status = "Paste the pairing string first.";
            return;
        }
        using (UiBreadcrumb.Enter("Pairing submit"))
        {
            IsBusy = true;
            Raise(nameof(CanEdit));
            PairCommand.RaiseCanExecuteChanged();
            Status = "Pairing: fetching the bootstrap from the cmd bucket and sending this device's key to the Mac...";
        }
        try
        {
            var r = await Task.Run(() => _agent.PairAsync(code));
            using var crumb = UiBreadcrumb.Enter("Pairing result");
            DeviceFingerprint = r.DeviceFingerprint;
            MacFingerprint = r.MacFingerprint;
            Completed = true;
            PairingText = "";
            Status = "Paired. Check that both fingerprints match the Mac's screen, then press Continue.";
            Paired?.Invoke(this, EventArgs.Empty);
        }
        catch (PairingException e)
        {
            Status = "Pairing failed: " + e.Message;
        }
        catch (Exception e)
        {
            Status = "Pairing failed: " + e.GetType().Name + ": " + e.Message;
        }
        finally
        {
            IsBusy = false;
            Raise(nameof(CanEdit));
            PairCommand.RaiseCanExecuteChanged();
            ContinueCommand.RaiseCanExecuteChanged();
        }
    }
}
