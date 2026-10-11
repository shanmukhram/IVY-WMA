using System.ComponentModel;
using Ivy.App.Core.ViewModels;
using Ivy.App.Core.WindowLock;
using Ivy.App.Pages;
using Ivy.App.Platform;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics;
using Windows.UI;

namespace Ivy.App;

/// <summary>
/// The one window (fourth run, Fluent): Mica, a custom title bar, the pairing page until paired, then a
/// NavigationView shell whose Frame hosts one page per <see cref="NavPages"/> tag. All state is in
/// <see cref="MainViewModel"/>; this class only keeps the NavigationView, the Frame and the theme in step with it.
/// </summary>
public sealed partial class MainWindow : Window
{
    /// <summary>Page tag (Ivy.App.Core NavPages) to XAML page. Group tags are not pages.</summary>
    private static readonly IReadOnlyDictionary<string, Type> PageTypes = new Dictionary<string, Type>(StringComparer.Ordinal)
    {
        [NavPages.Overview] = typeof(OverviewPage),
        [NavPages.Files] = typeof(FilesPage),
        [NavPages.Screenshots] = typeof(ScreenshotsPage),
        [NavPages.Usage] = typeof(UsagePage),
        [NavPages.Notifications] = typeof(NotificationsPage),
        [NavPages.Telegram] = typeof(TelegramPage),
        [NavPages.Line] = typeof(LinePage),
        [NavPages.Transfers] = typeof(TransfersPage),
        [NavPages.Settings] = typeof(SettingsPage),
        [NavPages.Activity] = typeof(ActivityPage),
    };

    /// <summary>
    /// The one place the locked window's content page is named. A later phase can swap the page type here.
    /// </summary>
    private static readonly Type CoverSurfaceType = typeof(CoverPage);

    /// <summary>True while a passphrase dialog is open, so two are never shown at once.</summary>
    private bool _promptOpen;

    /// <summary>Set while this class changes the NavigationView itself, so its events do not echo back.</summary>
    private bool _syncing;

    public MainWindow(MainViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();
        // Must stay "IVY": the usage collector recognises its own window by this title (ForegroundTitleReader.OwnProcessTitle).
        Title = "IVY";
        Hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        AppWindow.Resize(new SizeInt32(1200, 840));
        if (File.Exists(AppPaths.IconPath))
        {
            AppWindow.SetIcon(AppPaths.IconPath);
            TitleBarIcon.Source = new BitmapImage(new Uri(AppPaths.IconPath));
        }

        // Custom title bar over Mica: the 48 px AppTitleBar row is the drag region, caption buttons stay system-drawn.
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;

        TelegramNavItem.Icon = Ui.BrandIcon(ViewModel.TelegramBrand, 16);
        LineNavItem.Icon = Ui.BrandIcon(ViewModel.LineBrand, 16);

        ApplyTheme();
        Root.ActualThemeChanged += (_, _) => UpdateCaptionButtons();
        ViewModel.Appearance.PropertyChanged += OnAppearanceChanged;
        ViewModel.Navigation.PropertyChanged += OnNavigationChanged;
        ViewModel.PropertyChanged += OnViewModelChanged;
        ViewModel.Lock.PropertyChanged += OnLockChanged;
        SyncExpanded();
        SyncSelection();
    }

    public MainViewModel ViewModel { get; }

    public IntPtr Hwnd { get; }

    // ---------------------------------------------------------------- navigation

    private void NavView_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (_syncing) return;
        if (args.SelectedItemContainer?.Tag is string tag) ViewModel.Navigation.Select(tag);
    }

    /// <summary>Pressing the plain "IVY" entry while locked. ItemInvoked fires once per mouse click or Enter/Space, so each activation counts once.</summary>
    private void NavView_ItemInvoked(NavigationView sender, NavigationViewItemInvokedEventArgs args)
    {
        if (ReferenceEquals(args.InvokedItemContainer, LockNavItem)) ViewModel.Lock.Press();
    }

    // ---------------------------------------------------------------- window lock

    private void OnViewModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainViewModel.ShowLocked)) SyncSelection();
    }

    private void OnLockChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(WindowLockViewModel.Prompt) && ViewModel.Lock.Prompt != LockPrompt.None) _ = ShowPromptAsync();
    }

    /// <summary>Open the passphrase dialog for the current prompt. Never two at once.</summary>
    private async Task ShowPromptAsync()
    {
        if (_promptOpen) return;
        if (Root.XamlRoot is null)
        {
            ViewModel.Lock.CancelPrompt();
            return;
        }
        _promptOpen = true;
        try
        {
            var dialog = new PassphraseDialog(ViewModel.Lock)
            {
                XamlRoot = Root.XamlRoot,
                RequestedTheme = Root.RequestedTheme,
            };
            await dialog.ShowAsync();
        }
        finally
        {
            _promptOpen = false;
        }
    }

    private void NavView_Expanding(NavigationView sender, NavigationViewItemExpandingEventArgs args)
    {
        if (_syncing) return;
        if (args.ExpandingItemContainer?.Tag is string tag) ViewModel.Navigation.SetExpanded(tag, true);
    }

    private void NavView_Collapsed(NavigationView sender, NavigationViewItemCollapsedEventArgs args)
    {
        if (_syncing) return;
        if (args.CollapsedItemContainer?.Tag is string tag) ViewModel.Navigation.SetExpanded(tag, false);
    }

    private void OnNavigationChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(NavigationViewModel.SelectedPage)) SyncSelection();
        else if (e.PropertyName == nameof(NavigationViewModel.ExpandedGroups)) SyncExpanded();
    }

    /// <summary>Select the item for the view model's page and show that page in the Frame.</summary>
    private void SyncSelection()
    {
        if (ViewModel.ShowLocked)
        {
            // Locked: the content area shows only the blank cover page; the selected page comes back on unlock.
            if (ContentFrame.CurrentSourcePageType != CoverSurfaceType)
                ContentFrame.Navigate(CoverSurfaceType, null, new SuppressNavigationTransitionInfo());
            return;
        }
        var tag = ViewModel.Navigation.SelectedPage;
        var item = FindItem(tag);
        _syncing = true;
        try
        {
            if (item is not null && !ReferenceEquals(NavView.SelectedItem, item)) NavView.SelectedItem = item;
        }
        finally
        {
            _syncing = false;
        }
        if (PageTypes.TryGetValue(tag, out var type) && ContentFrame.CurrentSourcePageType != type)
            ContentFrame.Navigate(type, ViewModel, new EntranceNavigationTransitionInfo());
    }

    private void SyncExpanded()
    {
        _syncing = true;
        try
        {
            CollectorsGroupItem.IsExpanded = ViewModel.Navigation.IsExpanded(NavPages.CollectorsGroup);
            ConversationsGroupItem.IsExpanded = ViewModel.Navigation.IsExpanded(NavPages.ConversationsGroup);
        }
        finally
        {
            _syncing = false;
        }
    }

    private NavigationViewItem? FindItem(string tag) =>
        Flatten(NavView.MenuItems).Concat(Flatten(NavView.FooterMenuItems)).FirstOrDefault(i => i.Tag as string == tag);

    private static IEnumerable<NavigationViewItem> Flatten(IEnumerable<object> items)
    {
        foreach (var o in items)
        {
            if (o is not NavigationViewItem item) continue;
            yield return item;
            foreach (var child in Flatten(item.MenuItems)) yield return child;
        }
    }

    // ---------------------------------------------------------------- theme

    private void OnAppearanceChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(AppearanceViewModel.Theme)) ApplyTheme();
    }

    /// <summary>Settings > Appearance: System follows Windows; Light/Dark override the whole window content.</summary>
    private void ApplyTheme()
    {
        Root.RequestedTheme = ViewModel.Appearance.Theme switch
        {
            AppTheme.Light => ElementTheme.Light,
            AppTheme.Dark => ElementTheme.Dark,
            _ => ElementTheme.Default,
        };
        UpdateCaptionButtons();
    }

    /// <summary>The system draws the caption buttons; give them the content's theme (transparent over Mica).</summary>
    private void UpdateCaptionButtons()
    {
        var bar = AppWindow.TitleBar;
        var dark = Root.ActualTheme == ElementTheme.Dark;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        bar.ButtonForegroundColor = dark ? Colors.White : Colors.Black;
        bar.ButtonInactiveForegroundColor = dark ? Color.FromArgb(0x87, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x72, 0x00, 0x00, 0x00);
        bar.ButtonHoverBackgroundColor = dark ? Color.FromArgb(0x0F, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x09, 0x00, 0x00, 0x00);
        bar.ButtonHoverForegroundColor = dark ? Colors.White : Colors.Black;
        bar.ButtonPressedBackgroundColor = dark ? Color.FromArgb(0x0A, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x06, 0x00, 0x00, 0x00);
        bar.ButtonPressedForegroundColor = dark ? Colors.White : Colors.Black;
    }
}
