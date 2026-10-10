using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>Notifications collector page: status and the notification database state. No settings.</summary>
public sealed partial class NotificationsPage : Page
{
    public NotificationsPage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        base.OnNavigatedTo(e);
    }
}
