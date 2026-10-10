using Ivy.App.Core.ViewModels;
using Ivy.App.Platform;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace Ivy.App;

/// <summary>
/// The status window. All state is in <see cref="MainViewModel"/>; code-behind only handles the few
/// interactions that need a control reference (selected list item, folder dialog, the pause-scroll box).
/// </summary>
public sealed partial class MainWindow : Window
{
    public MainWindow(MainViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();
        Title = "IVY";
        Hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        AppWindow.Resize(new SizeInt32(1280, 900));
        if (File.Exists(AppPaths.IconPath)) AppWindow.SetIcon(AppPaths.IconPath);
    }

    public MainViewModel ViewModel { get; }

    public IntPtr Hwnd { get; }

    private async void AddIndexedRoot_Click(object sender, RoutedEventArgs e) => await PickInto(ViewModel.Settings.IndexedRoots);

    private void RemoveIndexedRoot_Click(object sender, RoutedEventArgs e) =>
        ViewModel.Settings.IndexedRoots.Remove(IndexedRootsList.SelectedItem as string);

    private async void AddScreenshotRoot_Click(object sender, RoutedEventArgs e) => await PickInto(ViewModel.Settings.ScreenshotRoots);

    private void RemoveScreenshotRoot_Click(object sender, RoutedEventArgs e) =>
        ViewModel.Settings.ScreenshotRoots.Remove(ScreenshotRootsList.SelectedItem as string);

    private void AddExclusion_Click(object sender, RoutedEventArgs e) => ViewModel.Settings.TitleExclusions.AddNew();

    private void AddImageExtension_Click(object sender, RoutedEventArgs e) => ViewModel.Settings.ImageExtensions.AddNew();

    private void RemoveImageExtension_Click(object sender, RoutedEventArgs e) =>
        ViewModel.Settings.ImageExtensions.Remove(ImageExtensionsList.SelectedItem as string);

    private void AddDocumentExtension_Click(object sender, RoutedEventArgs e) => ViewModel.Settings.DocumentExtensions.AddNew();

    private void RemoveDocumentExtension_Click(object sender, RoutedEventArgs e) =>
        ViewModel.Settings.DocumentExtensions.Remove(DocumentExtensionsList.SelectedItem as string);

    private void RemoveExclusion_Click(object sender, RoutedEventArgs e) =>
        ViewModel.Settings.TitleExclusions.Remove(ExclusionsList.SelectedItem as string);

    private void PauseScroll_Changed(object sender, RoutedEventArgs e) =>
        ViewModel.Feed.ScrollPaused = PauseScrollBox.IsChecked == true;

    // PasswordBox.Password is not a bindable dependency property; mirror it into the view model here.
    private void TelegramPasscode_Changed(object sender, RoutedEventArgs e) =>
        ViewModel.Conversation.PasscodeText = TelegramPasscodeBox.Password;

    private async Task PickInto(StringListViewModel list)
    {
        try { await list.PickAndAddAsync(); }
        catch (Exception ex)
        {
            // FolderPicker throws when the process runs elevated; say so instead of crashing.
            ViewModel.Settings.ReportError("Folder picker failed (is IVY running as administrator?): " + ex.Message);
        }
    }
}
