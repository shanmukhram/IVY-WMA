using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>Settings: startup, theme, bandwidth, folders, version, unpair (the one confirmation dialog in the app).</summary>
public sealed partial class SettingsPage : Page
{
    public SettingsPage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        base.OnNavigatedTo(e);
    }

    /// <summary>Unpair is destructive, so it asks first (Cancel is the default button); routine status never uses dialogs.</summary>
    private async void Unpair_Click(object sender, RoutedEventArgs e)
    {
        if (!ViewModel.UnpairCommand.CanExecute(null)) return;
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            // Dialogs live in the popup layer: give them the window's (possibly overridden) theme.
            RequestedTheme = ActualTheme,
            Style = Application.Current.Resources["DefaultContentDialogStyle"] as Style,
            Title = "Unpair this PC?",
            Content = "IVY forgets this PC's key and tokens and stops capturing and uploading. Encrypted items already queued stay on this PC. To use IVY again, pair with a new string from the Mac.",
            PrimaryButtonText = "Unpair",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary) await ViewModel.UnpairCommand.ExecuteAsync();
    }
}
