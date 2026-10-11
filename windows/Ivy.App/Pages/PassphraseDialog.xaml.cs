using Ivy.App.Core.WindowLock;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;

namespace Ivy.App.Pages;

/// <summary>
/// Asks for the window-lock passphrase. <see cref="LockPrompt.SetPassphrase"/> asks twice and shows an inline
/// message when the entries differ; <see cref="LockPrompt.EnterPassphrase"/> asks once and simply closes on a wrong
/// entry. Cancel and Escape tell the view model the prompt is over.
/// </summary>
public sealed partial class PassphraseDialog : ContentDialog
{
    private readonly WindowLockViewModel _lock;
    private readonly bool _setting;

    public PassphraseDialog(WindowLockViewModel lockModel, LockPrompt mode)
    {
        _lock = lockModel;
        _setting = mode == LockPrompt.SetPassphrase;
        InitializeComponent();
        CloseButtonText = "Cancel";
        if (_setting)
        {
            Title = "Set a passphrase for this window";
            PrimaryButtonText = "Set";
        }
        else
        {
            Title = "Enter passphrase";
            PrimaryButtonText = "Unlock";
            BodyText.Visibility = Visibility.Collapsed;
            SecondBox.Visibility = Visibility.Collapsed;
        }
    }

    /// <summary>Runs the primary action. True when the dialog can close.</summary>
    private bool Submit()
    {
        if (_setting)
        {
            if (_lock.SetPassphrase(FirstBox.Password, SecondBox.Password)) return true;
            ErrorText.Visibility = Visibility.Visible;
            return false;
        }
        _lock.TryUnlock(FirstBox.Password); // a wrong passphrase closes the dialog with no message
        return true;
    }

    private void Dialog_PrimaryButtonClick(ContentDialog sender, ContentDialogButtonClickEventArgs args)
    {
        if (!Submit()) args.Cancel = true;
    }

    /// <summary>Enter in the first box moves on to the second (Set mode) or submits (Enter mode).</summary>
    private void FirstBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        e.Handled = true;
        if (_setting) SecondBox.Focus(FocusState.Keyboard);
        else SubmitFromKeyboard();
    }

    private void SecondBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        e.Handled = true;
        SubmitFromKeyboard();
    }

    private void SubmitFromKeyboard()
    {
        if (Submit()) Hide();
    }

    private void Dialog_Closed(ContentDialog sender, ContentDialogClosedEventArgs args)
    {
        FirstBox.Password = "";
        SecondBox.Password = "";
        // Cancel, Escape, or a wrong passphrase: the prompt is over. After a successful Set/Unlock it is already None.
        if (_lock.Prompt != LockPrompt.None) _lock.CancelPrompt();
    }
}
