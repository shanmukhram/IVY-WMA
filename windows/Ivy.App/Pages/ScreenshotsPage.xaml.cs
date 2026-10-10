using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>Screenshots collector page: status and the watched folders.</summary>
public sealed partial class ScreenshotsPage : Page
{
    public ScreenshotsPage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        base.OnNavigatedTo(e);
    }

    private async void AddScreenshotRoot_Click(object sender, RoutedEventArgs e) => await PageCommon.PickInto(ViewModel, ViewModel.Settings.ScreenshotRoots);

    private void RemoveScreenshotRoot_Click(object sender, RoutedEventArgs e) => PageCommon.RemoveSelected(ViewModel.Settings.ScreenshotRoots, ScreenshotRootsList);
}
