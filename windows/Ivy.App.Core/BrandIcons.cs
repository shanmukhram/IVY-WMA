using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ivy.App.Core;

/// <summary>
/// One app's icon as the window draws it. With <see cref="PathData"/> the shell renders a <c>PathIcon</c> (24x24
/// viewBox, scaled) in <see cref="Color"/>; without it, an initials tile (<see cref="Initials"/> on
/// <see cref="TileColor"/>). The same rules as the Mac dashboard's <c>AppIcon</c> (mac/ui/src/components/AppIcon.tsx),
/// so an app looks the same on both.
/// </summary>
public sealed record BrandGlyph(string Key, string Title, string? PathData, string Color, string Initials, string TileColor)
{
    public bool HasPath => PathData is not null;
    public bool IsFallback => PathData is null;

    /// <summary>Near-black marks (luminance &lt; 0.04) follow the text colour instead of their own (Mac rule).</summary>
    public bool UsesTextColor { get; init; }
}

/// <summary>
/// Brand marks from <c>simple-icons</c> (CC0), embedded as <c>Resources/brand-icons.json</c> so the path data is
/// versioned with the app and testable here. Unknown apps get the initials-tile fallback with a stable colour.
/// </summary>
public static class BrandIcons
{
    /// <summary>Tile colours, identical to the Mac's Avatar palette (same peer, same colour everywhere).</summary>
    private static readonly string[] TileColors = { "#FF6B5F", "#FF9F0A", "#E5B000", "#34C759", "#00B8A9", "#32ADE6", "#007AFF", "#5E5CE6", "#AF52DE", "#FF375F" };

    private static readonly Lazy<Catalog> Data = new(LoadCatalog);

    public static BrandGlyph Telegram => For("telegram");
    public static BrandGlyph Line => For("line");

    /// <summary>The embedded resource's provenance line (simple-icons version and licence).</summary>
    public static string Source => Data.Value.Source ?? "";

    /// <summary>Keys with path data (tests).</summary>
    public static IReadOnlyCollection<string> Known => Data.Value.Icons.Keys.ToArray();

    /// <summary>
    /// The icon for an app or platform identifier (collector name, Windows app name, Android package). Never null:
    /// unknown or empty identifiers give the initials tile.
    /// </summary>
    public static BrandGlyph For(string? app)
    {
        var name = string.IsNullOrWhiteSpace(app) ? "?" : app.Trim();
        var key = Normalise(name);
        var catalog = Data.Value;
        if (catalog.Aliases.TryGetValue(key, out var alias) && catalog.Icons.TryGetValue(alias, out var icon))
        {
            var lum = Luminance(icon.Hex);
            return new BrandGlyph(alias, icon.Title, icon.Path, "#" + icon.Hex.ToUpperInvariant(), Initials(icon.Title), HashColor(alias))
            {
                UsesTextColor = lum < 0.04,
            };
        }
        return new BrandGlyph(key, name, null, HashColor(key), Initials(name), HashColor(key));
    }

    /// <summary>Lower-case letters and digits only ("Telegram Desktop" and "telegram_desktop" both become "telegramdesktop").</summary>
    public static string Normalise(string id) => new(id.ToLowerInvariant().Where(char.IsAsciiLetterOrDigit).ToArray());

    /// <summary>FNV-1a over UTF-16 code units into the tile palette (the Mac's <c>hashColor</c>).</summary>
    public static string HashColor(string key)
    {
        uint h = 2166136261;
        foreach (var c in key)
        {
            h ^= c;
            h = unchecked(h * 16777619);
        }
        return TileColors[h % (uint)TileColors.Length];
    }

    /// <summary>First letters of the first and last words, or the first two letters of a single word; "#" when none.</summary>
    public static string Initials(string name)
    {
        var clean = new string(name.Select(c => char.IsLetterOrDigit(c) || char.IsWhiteSpace(c) ? c : ' ').ToArray()).Trim();
        if (clean.Length == 0) return "#";
        var parts = clean.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var first = TextElements(parts[0]);
        string text;
        if (parts.Length > 1) text = first[0] + TextElements(parts[^1])[0];
        else text = first[0] + (first.Count > 1 ? first[1] : "");
        return text.ToUpper(CultureInfo.InvariantCulture);
    }

    private static List<string> TextElements(string s)
    {
        var list = new List<string>();
        var e = StringInfo.GetTextElementEnumerator(s);
        while (e.MoveNext()) list.Add((string)e.Current);
        return list;
    }

    internal static double Luminance(string hex)
    {
        double Channel(int i)
        {
            var v = int.Parse(hex.AsSpan(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture) / 255.0;
            return v <= 0.03928 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * Channel(0) + 0.7152 * Channel(2) + 0.0722 * Channel(4);
    }

    private sealed record Icon(string Title, string Hex, string Path);

    private sealed record Catalog(string? Source, IReadOnlyDictionary<string, Icon> Icons, IReadOnlyDictionary<string, string> Aliases);

    private sealed class Dto
    {
        [JsonPropertyName("source")] public string? Source { get; set; }
        [JsonPropertyName("icons")] public List<IconDto>? Icons { get; set; }
        [JsonPropertyName("aliases")] public Dictionary<string, string>? Aliases { get; set; }
    }

    private sealed class IconDto
    {
        [JsonPropertyName("key")] public string? Key { get; set; }
        [JsonPropertyName("title")] public string? Title { get; set; }
        [JsonPropertyName("hex")] public string? Hex { get; set; }
        [JsonPropertyName("path")] public string? Path { get; set; }
    }

    internal const string ResourceName = "Ivy.App.Core.Resources.brand-icons.json";

    /// <summary>A missing or broken resource degrades to "every app gets a tile" rather than failing the window.</summary>
    private static Catalog LoadCatalog()
    {
        var empty = new Catalog(null, new Dictionary<string, Icon>(), new Dictionary<string, string>());
        using var stream = typeof(BrandIcons).Assembly.GetManifestResourceStream(ResourceName);
        if (stream is null) return empty;
        Dto? d;
        try { d = JsonSerializer.Deserialize<Dto>(stream); }
        catch (JsonException) { return empty; }
        if (d?.Icons is null) return empty;
        var icons = new Dictionary<string, Icon>(StringComparer.Ordinal);
        foreach (var i in d.Icons)
        {
            if (string.IsNullOrEmpty(i.Key) || string.IsNullOrEmpty(i.Path) || i.Hex is not { Length: 6 }) continue;
            icons[i.Key] = new Icon(i.Title ?? i.Key, i.Hex, i.Path);
        }
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var k in icons.Keys) aliases[k] = k;
        foreach (var (k, v) in d.Aliases ?? new()) if (icons.ContainsKey(v)) aliases[Normalise(k)] = v;
        return new Catalog(d.Source, icons, aliases);
    }
}
