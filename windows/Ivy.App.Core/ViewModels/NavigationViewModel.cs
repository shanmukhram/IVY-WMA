using System.Text.Json;
using System.Text.Json.Serialization;
using Ivy.App.Core.Diagnostics;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// The NavigationView's items (fourth run, Fluent redesign). Tags are the contract between this class and
/// <c>MainWindow.xaml</c>: every <c>NavigationViewItem.Tag</c> there is one of these strings, and the shell maps
/// each page tag to a XAML page type. Groups only expand and collapse (they are not pages themselves).
/// </summary>
public static class NavPages
{
    public const string Overview = "overview";
    public const string Files = "files";
    public const string Screenshots = "screenshots";
    public const string Usage = "usage";
    public const string Notifications = "notifications";
    public const string Telegram = "telegram";
    public const string Line = "line";
    public const string Transfers = "transfers";
    public const string Settings = "settings";
    public const string Activity = "activity";

    public const string CollectorsGroup = "collectors";
    public const string ConversationsGroup = "conversations";

    /// <summary>Every page in navigation order (Activity is the footer item).</summary>
    public static readonly IReadOnlyList<string> All = new[] { Overview, Files, Screenshots, Usage, Notifications, Telegram, Line, Transfers, Settings, Activity };
    public static readonly IReadOnlyList<string> Groups = new[] { CollectorsGroup, ConversationsGroup };

    public static bool IsPage(string? tag) => tag is not null && All.Contains(tag, StringComparer.Ordinal);
    public static bool IsGroup(string? tag) => tag is not null && Groups.Contains(tag, StringComparer.Ordinal);

    /// <summary>The group a page sits under, or null for top-level pages.</summary>
    public static string? GroupOf(string tag) => tag switch
    {
        Files or Screenshots or Usage or Notifications => CollectorsGroup,
        Telegram or Line => ConversationsGroup,
        _ => null,
    };

    public static string Title(string tag) => tag switch
    {
        Overview => "Overview",
        Files => "Files",
        Screenshots => "Screenshots",
        Usage => "App usage",
        Notifications => "Notifications",
        Telegram => "Telegram",
        Line => "LINE",
        Transfers => "Transfers",
        Settings => "Settings",
        Activity => "Activity",
        CollectorsGroup => "Collectors",
        ConversationsGroup => "Conversations",
        _ => tag,
    };
}

/// <summary>
/// Navigation state: the selected page and which groups are expanded. Persisted in <c>agent_settings</c>
/// (<see cref="SettingsKey"/>) so the window reopens where it was left; the write runs on the thread pool
/// (SQLite, never on the UI thread). Unknown or corrupt saved state falls back to the defaults.
/// </summary>
public sealed class NavigationViewModel : ObservableObject
{
    public const string SettingsKey = "app.ui.navigation";
    private readonly UiStateStore _store;
    private readonly HashSet<string> _expanded = new(StringComparer.Ordinal) { NavPages.CollectorsGroup, NavPages.ConversationsGroup };
    private string _selected = NavPages.Overview;

    public NavigationViewModel(UiStateStore store) => _store = store;

    public string SelectedPage { get => _selected; private set => Set(ref _selected, value); }
    public string SelectedTitle => NavPages.Title(_selected);

    public IReadOnlyCollection<string> ExpandedGroups => _expanded.ToArray();
    public bool IsExpanded(string group) => _expanded.Contains(group);

    /// <summary>Read the saved state (UI thread at startup; a read, not a write).</summary>
    public void Load()
    {
        var saved = Decode(_store.Get(SettingsKey));
        if (saved is null) return;
        _expanded.Clear();
        foreach (var g in saved.Value.Expanded) _expanded.Add(g);
        SelectedPage = saved.Value.Page;
        Raise(nameof(SelectedTitle));
        Raise(nameof(ExpandedGroups));
    }

    /// <summary>The user picked a page. Unknown tags and group headers are ignored (returns false).</summary>
    public bool Select(string? tag)
    {
        if (!NavPages.IsPage(tag)) return false;
        var changed = tag != _selected;
        SelectedPage = tag!;
        // The selected item must be visible: open its group.
        if (NavPages.GroupOf(tag!) is { } g && _expanded.Add(g)) Raise(nameof(ExpandedGroups));
        if (changed)
        {
            Raise(nameof(SelectedTitle));
            Save();
        }
        return true;
    }

    public void SetExpanded(string? group, bool expanded)
    {
        if (!NavPages.IsGroup(group)) return;
        var changed = expanded ? _expanded.Add(group!) : _expanded.Remove(group!);
        if (!changed) return;
        Raise(nameof(ExpandedGroups));
        Save();
    }

    /// <summary>Completes when the last save reached agent_settings (tests).</summary>
    public Task LastSave => _store.LastWrite;

    private void Save() => _store.Set(SettingsKey, Encode(_selected, _expanded));

    private sealed class Dto
    {
        [JsonPropertyName("page")] public string? Page { get; set; }
        [JsonPropertyName("expanded")] public List<string>? Expanded { get; set; }
    }

    internal static string Encode(string page, IEnumerable<string> expanded) =>
        JsonSerializer.Serialize(new Dto { Page = page, Expanded = expanded.OrderBy(g => g, StringComparer.Ordinal).ToList() });

    /// <summary>Null when absent or unusable; unknown groups are dropped, an unknown page becomes Overview.</summary>
    internal static (string Page, IReadOnlyList<string> Expanded)? Decode(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        Dto? d;
        try { d = JsonSerializer.Deserialize<Dto>(json); }
        catch (JsonException) { return null; }
        if (d is null) return null;
        var page = NavPages.IsPage(d.Page) ? d.Page! : NavPages.Overview;
        var groups = (d.Expanded ?? new List<string>()).Where(NavPages.IsGroup).Distinct(StringComparer.Ordinal).ToList();
        return (page, groups);
    }
}

/// <summary>App-wide colour theme override (Settings > Appearance). System follows Windows.</summary>
public enum AppTheme { System = 0, Light = 1, Dark = 2 }

/// <summary>
/// The theme override, persisted in <c>agent_settings</c> (<see cref="SettingsKey"/>). The shell applies it to the
/// window content's <c>RequestedTheme</c> and recolours the caption buttons when <see cref="Theme"/> changes.
/// </summary>
public sealed class AppearanceViewModel : ObservableObject
{
    public const string SettingsKey = "app.ui.theme";
    private readonly UiStateStore _store;
    private AppTheme _theme = AppTheme.System;

    public AppearanceViewModel(UiStateStore store) => _store = store;

    public AppTheme Theme
    {
        get => _theme;
        set
        {
            if (!Enum.IsDefined(value) || !Set(ref _theme, value)) return;
            Raise(nameof(ThemeIndex));
            _store.Set(SettingsKey, Name(value));
        }
    }

    /// <summary>Two-way with the theme selector's SelectedIndex (0 System, 1 Light, 2 Dark).</summary>
    public int ThemeIndex
    {
        get => (int)_theme;
        set
        {
            if (value is >= 0 and <= 2) Theme = (AppTheme)value;
        }
    }

    public void Load()
    {
        _theme = Parse(_store.Get(SettingsKey));
        Raise(nameof(Theme));
        Raise(nameof(ThemeIndex));
    }

    public Task LastSave => _store.LastWrite;

    internal static string Name(AppTheme t) => t switch { AppTheme.Light => "light", AppTheme.Dark => "dark", _ => "system" };

    internal static AppTheme Parse(string? s) => s switch { "light" => AppTheme.Light, "dark" => AppTheme.Dark, _ => AppTheme.System };
}

/// <summary>
/// Window state in <c>agent_settings</c>: reads inline (cheap, startup), writes queued on the thread pool one at a
/// time and in order (the second Windows run's rule: no SQLite writes on the UI thread). Failures are swallowed:
/// losing the remembered page is not worth an error line.
/// </summary>
public sealed class UiStateStore
{
    private readonly IAgentViewSettings _settings;
    private readonly BackgroundWork _work = new();

    public UiStateStore(IAgentViewSettings settings) => _settings = settings;

    public string? Get(string key)
    {
        try { return _settings.GetSetting(key); }
        catch (Exception) { return null; }
    }

    public void Set(string key, string value)
    {
        LastWrite = Write(key, value);
    }

    private async Task Write(string key, string value)
    {
        try { await _work.Run(() => _settings.SetSetting(key, value)); }
        catch (Exception) { /* cosmetic state; see the class summary */ }
    }

    public Task LastWrite { get; private set; } = Task.CompletedTask;
}

/// <summary>The two agent_settings members <see cref="UiStateStore"/> needs (kept narrow so tests can fake it).</summary>
public interface IAgentViewSettings
{
    string? GetSetting(string key);
    void SetSetting(string key, string value);
}

/// <summary>Adapts <see cref="Hosting.IAgentView"/> to <see cref="IAgentViewSettings"/>.</summary>
internal sealed class AgentSettingsAdapter(Hosting.IAgentView agent) : IAgentViewSettings
{
    public string? GetSetting(string key) => agent.GetSetting(key);
    public void SetSetting(string key, string value) => agent.SetSetting(key, value);
}
