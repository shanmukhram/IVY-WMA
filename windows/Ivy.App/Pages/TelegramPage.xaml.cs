using System.ComponentModel;
using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>Telegram page. Code-behind mirrors the PasswordBox (not bindable) into the view model.</summary>
public sealed partial class TelegramPage : Page
{
    public TelegramPage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;
    private bool _subscribed;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        // The page is cached for the app's lifetime (NavigationCacheMode="Required"), so one subscription is enough.
        if (!_subscribed)
        {
            ViewModel.Conversation.PropertyChanged += OnConversationChanged;
            _subscribed = true;
        }
        base.OnNavigatedTo(e);
    }

    /// <summary>Once the passcode was applied the view model clears its copy; clear the box too.</summary>
    private void OnConversationChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(ConversationViewModel.PasscodeText)
            && ViewModel.Conversation.PasscodeText.Length == 0 && TelegramPasscodeBox.Password.Length > 0)
            TelegramPasscodeBox.Password = "";
    }

    // PasswordBox.Password is not a bindable dependency property; mirror it into the view model here.
    private void TelegramPasscode_Changed(object sender, RoutedEventArgs e) =>
        ViewModel.Conversation.PasscodeText = TelegramPasscodeBox.Password;

    /// <summary>Enter applies, like the Unlock button.</summary>
    private async void TelegramPasscode_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != Windows.System.VirtualKey.Enter) return;
        e.Handled = true;
        await ViewModel.Conversation.ApplyPasscodeCommand.ExecuteAsync();
    }
}
