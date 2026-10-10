using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;

namespace Ivy.App.Pages;

/// <summary>Files collector page. Code-behind only for the list selections and the folder dialog.</summary>
public sealed partial class FilesPage : Page
{
    public FilesPage() => InitializeComponent();

    public MainViewModel ViewModel { get; private set; } = null!;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = PageCommon.ViewModelFrom(e.Parameter);
        base.OnNavigatedTo(e);
    }

    private async void AddIndexedRoot_Click(object sender, RoutedEventArgs e) => await PageCommon.PickInto(ViewModel, ViewModel.Settings.IndexedRoots);

    private void RemoveIndexedRoot_Click(object sender, RoutedEventArgs e) => PageCommon.RemoveSelected(ViewModel.Settings.IndexedRoots, IndexedRootsList);

    private void AddFileExclusion_Click(object sender, RoutedEventArgs e) => ViewModel.Settings.FileExclusions.AddNew();

    private void RemoveFileExclusion_Click(object sender, RoutedEventArgs e) => PageCommon.RemoveSelected(ViewModel.Settings.FileExclusions, FileExclusionsList);

    private void FileExclusionBox_KeyDown(object sender, KeyRoutedEventArgs e) => PageCommon.AddOnEnter(ViewModel.Settings.FileExclusions, e);

    private void AddImageExtension_Click(object sender, RoutedEventArgs e) => ViewModel.Settings.ImageExtensions.AddNew();

    private void RemoveImageExtension_Click(object sender, RoutedEventArgs e) => PageCommon.RemoveSelected(ViewModel.Settings.ImageExtensions, ImageExtensionsList);

    private void ImageExtensionBox_KeyDown(object sender, KeyRoutedEventArgs e) => PageCommon.AddOnEnter(ViewModel.Settings.ImageExtensions, e);

    private void AddDocumentExtension_Click(object sender, RoutedEventArgs e) => ViewModel.Settings.DocumentExtensions.AddNew();

    private void RemoveDocumentExtension_Click(object sender, RoutedEventArgs e) => PageCommon.RemoveSelected(ViewModel.Settings.DocumentExtensions, DocumentExtensionsList);

    private void DocumentExtensionBox_KeyDown(object sender, KeyRoutedEventArgs e) => PageCommon.AddOnEnter(ViewModel.Settings.DocumentExtensions, e);
}
