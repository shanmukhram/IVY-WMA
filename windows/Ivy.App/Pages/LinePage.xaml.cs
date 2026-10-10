using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>LINE page: status, coverage note, probe actions. All state is in the view model.</summary>
public sealed partial class LinePage : Page
{
    public LinePage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        base.OnNavigatedTo(e);
    }

    private void LineKeyBox_PasswordChanged(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        if (ViewModel?.Conversation is not null) ViewModel.Conversation.LineKeyText = LineKeyBox.Password;
    }
}
