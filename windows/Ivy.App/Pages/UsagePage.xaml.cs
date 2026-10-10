using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>App usage collector page: status, window-title capture and the title exclusion list.</summary>
public sealed partial class UsagePage : Page
{
    public UsagePage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        base.OnNavigatedTo(e);
    }

    private void AddExclusion_Click(object sender, RoutedEventArgs e) => ViewModel.Settings.TitleExclusions.AddNew();

    private void RemoveExclusion_Click(object sender, RoutedEventArgs e) => PageCommon.RemoveSelected(ViewModel.Settings.TitleExclusions, ExclusionsList);

    private void ExclusionBox_KeyDown(object sender, KeyRoutedEventArgs e) => PageCommon.AddOnEnter(ViewModel.Settings.TitleExclusions, e);
}
