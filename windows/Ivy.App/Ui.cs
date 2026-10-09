using Microsoft.UI;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Ivy.App;

/// <summary>x:Bind helper functions (static, referenced as <c>local:Ui.Brush(...)</c> in XAML).</summary>
public static class Ui
{
    private static readonly Dictionary<string, SolidColorBrush> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary><c>#RRGGBB</c> to a cached brush (status dots). Unknown input gives grey.</summary>
    public static SolidColorBrush Brush(string? hex)
    {
        hex ??= "";
        if (Cache.TryGetValue(hex, out var b)) return b;
        b = new SolidColorBrush(Parse(hex));
        Cache[hex] = b;
        return b;
    }

    private static Color Parse(string hex)
    {
        var s = hex.TrimStart('#');
        if (s.Length == 6 && uint.TryParse(s, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out var v))
            return ColorHelper.FromArgb(0xFF, (byte)(v >> 16), (byte)(v >> 8), (byte)v);
        return ColorHelper.FromArgb(0xFF, 0x6B, 0x6B, 0x6B);
    }
}
