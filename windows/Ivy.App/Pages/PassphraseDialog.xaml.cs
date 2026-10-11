using Ivy.App.Core.WindowLock;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;

namespace Ivy.App.Pages;

/// <summary>
/// Asks for the window-lock passphrase. A wrong entry simply closes the dialog with no message. Cancel and Escape
/// tell the view model the prompt is over.
/// </summary>
public sealed partial class PassphraseDialog : ContentDialog
{
    private readonly WindowLockViewModel _lock;

    public PassphraseDialog(WindowLockViewModel lockModel)
    {
        _lock = lockModel;
        InitializeComponent();
        Title = "Enter passphrase";
        PrimaryButtonText = "Unlock";
        CloseButtonText = "Cancel";
    }

    private void Dialog_PrimaryButtonClick(ContentDialog sender, ContentDialogButtonClickEventArgs args)
    {
        _lock.TryUnlock(FirstBox.Password); // a wrong passphrase closes the dialog with no message
    }

    private void FirstBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        e.Handled = true;
        _lock.TryUnlock(FirstBox.Password);
        Hide();
    }

    private void Dialog_Closed(ContentDialog sender, ContentDialogClosedEventArgs args)
    {
        FirstBox.Password = "";
        // Cancel, Escape, or a wrong passphrase: the prompt is over. After a successful unlock it is already None.
        if (_lock.Prompt != LockPrompt.None) _lock.CancelPrompt();
    }
}
