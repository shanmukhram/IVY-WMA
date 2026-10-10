using Ivy.App.Core.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;

namespace Ivy.App.Pages;

/// <summary>
/// What every page's code-behind shares. Pages receive the one <see cref="MainViewModel"/> as the navigation parameter
/// (MainWindow navigates with it) and are cached (NavigationCacheMode="Required"), so their x:Bind subscriptions are
/// made once and never pile up.
/// </summary>
internal static class PageCommon
{
    public static MainViewModel ViewModelFrom(object? parameter) =>
        parameter as MainViewModel ?? throw new InvalidOperationException("pages are navigated to with the MainViewModel as parameter");

    /// <summary>Folder dialog into a list; FolderPicker throws when IVY runs elevated, so say so instead of crashing.</summary>
    public static async Task PickInto(MainViewModel vm, StringListViewModel list)
    {
        try { await list.PickAndAddAsync(); }
        catch (Exception ex)
        {
            vm.Settings.ReportError("Folder picker failed (is IVY running as administrator?): " + ex.Message);
        }
    }

    /// <summary>"Pause scroll" toggles on the Overview and Activity pages share the feed's flag.</summary>
    public static void TogglePauseScroll(MainViewModel vm, object sender) =>
        vm.Feed.ScrollPaused = (sender as ToggleButton)?.IsChecked == true;

    /// <summary>Remove the list's selected string; nothing selected is a no-op.</summary>
    public static void RemoveSelected(StringListViewModel list, ListView view) => list.Remove(view.SelectedItem as string);

    /// <summary>Enter in an "add" text box adds the item (keyboard path for the Add buttons).</summary>
    public static void AddOnEnter(StringListViewModel list, Microsoft.UI.Xaml.Input.KeyRoutedEventArgs e)
    {
        if (e.Key != Windows.System.VirtualKey.Enter) return;
        list.AddNew();
        e.Handled = true;
    }
}
