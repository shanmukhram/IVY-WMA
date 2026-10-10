using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>Overview: status card, Running/Paused, collector tiles (each opens its page), live activity.</summary>
public sealed partial class OverviewPage : Page
{
    public OverviewPage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        base.OnNavigatedTo(e);
    }

    /// <summary>Tile tags are collector names, which are also the page tags (NavPages); unknown collectors stay put.</summary>
    private void Tile_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string tag }) ViewModel.Navigation.Select(tag);
    }

    private void PauseScroll_Click(object sender, RoutedEventArgs e) => PageCommon.TogglePauseScroll(ViewModel, sender);
}
