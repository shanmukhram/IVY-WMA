using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>Activity: the live feed at full height. Pause scroll is shared with the Overview page.</summary>
public sealed partial class ActivityPage : Page
{
    public ActivityPage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        base.OnNavigatedTo(e);
    }

    private void PauseScroll_Click(object sender, RoutedEventArgs e) => PageCommon.TogglePauseScroll(ViewModel, sender);
}
