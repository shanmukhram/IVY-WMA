using System.Collections.ObjectModel;

namespace Ivy.App.Core.ViewModels;

/// <summary>
/// Editable list of strings (indexed roots, screenshot roots, title exclusions, extensions). Values are trimmed
/// (and passed through <c>normalize</c> when given), blanks ignored, duplicates rejected case-insensitively. Every
/// change calls <c>changed</c> once.
/// </summary>
public sealed class StringListViewModel : ObservableObject
{
    private readonly Action _changed;
    private readonly Func<Task<string?>>? _pick;
    private readonly Func<string, string>? _normalize;
    private string _newItem = "";

    public StringListViewModel(Action changed, Func<Task<string?>>? pick = null, Func<string, string>? normalize = null)
    {
        _changed = changed;
        _pick = pick;
        _normalize = normalize;
    }

    private string Clean(string? v)
    {
        var t = (v ?? "").Trim();
        return _normalize is null ? t : _normalize(t).Trim();
    }

    public ObservableCollection<string> Items { get; } = new();

    /// <summary>Text box for lists edited by typing (exclusions).</summary>
    public string NewItem { get => _newItem; set => Set(ref _newItem, value ?? ""); }

    public IReadOnlyList<string> Values => Items.ToList();

    /// <summary>Replace the contents without raising <c>changed</c> (loading from the host).</summary>
    public void Load(IEnumerable<string> values)
    {
        Items.Clear();
        foreach (var v in values)
        {
            var t = Clean(v);
            if (t.Length > 0 && !Contains(t)) Items.Add(t);
        }
    }

    public bool Add(string? value)
    {
        var t = Clean(value);
        if (t.Length == 0 || Contains(t)) return false;
        Items.Add(t);
        _changed();
        return true;
    }

    /// <summary>Add whatever is in <see cref="NewItem"/> and clear it on success.</summary>
    public bool AddNew()
    {
        if (!Add(_newItem)) return false;
        NewItem = "";
        return true;
    }

    /// <summary>Ask the picker (folder dialog) for a value and add it.</summary>
    public async Task<bool> PickAndAddAsync()
    {
        if (_pick is null) return false;
        var v = await _pick();
        return Add(v);
    }

    public bool Remove(string? value)
    {
        if (value is null) return false;
        var existing = Items.FirstOrDefault(i => string.Equals(i, value, StringComparison.OrdinalIgnoreCase));
        if (existing is null) return false;
        Items.Remove(existing);
        _changed();
        return true;
    }

    private bool Contains(string v) => Items.Any(i => string.Equals(i, v, StringComparison.OrdinalIgnoreCase));
}
