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

    private void RemoveExclusion_Click(object sender, RoutedEventArgs e) =>
        ViewModel.Settings.TitleExclusions.Remove(ExclusionsList.SelectedItem as string);

    private void PauseScroll_Changed(object sender, RoutedEventArgs e) =>
        ViewModel.Feed.ScrollPaused = PauseScrollBox.IsChecked == true;

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
