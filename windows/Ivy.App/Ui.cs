using Ivy.App.Core;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Ivy.App;

/// <summary>
/// x:Bind helper functions (static, referenced as <c>local:Ui.Name(...)</c> in XAML) and the brand-icon builders.
/// Kept free of state except the brush cache.
/// </summary>
public static class Ui
{
    private static readonly Dictionary<string, SolidColorBrush> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary><c>#RRGGBB</c> to a cached brush (status dots, brand colours). Unknown input gives grey.</summary>
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

    /// <summary>InfoBar severity from the platform-neutral enum (same numeric values).</summary>
    public static InfoBarSeverity Severity(UiSeverity s) => (InfoBarSeverity)(int)s;

    /// <summary>Status dot for a severity (same palette as the collector dots).</summary>
    public static SolidColorBrush SeverityBrush(UiSeverity s) => Brush(s switch
    {
        UiSeverity.Success => StatusRules.Green,
        UiSeverity.Warning => StatusRules.Amber,
        UiSeverity.Error => StatusRules.Red,
        _ => StatusRules.Grey,
    });

    /// <summary>True when the text is not empty (InfoBar.IsOpen for error strings).</summary>
    public static bool HasText(string? text) => !string.IsNullOrEmpty(text);

    /// <summary>Visible when the text is not empty (pairs with <see cref="HasText"/> on InfoBars, so a closed bar takes no space).</summary>
    public static Visibility VisibleIfText(string? text) => string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;

    public static Visibility VisibleWhen(bool value) => value ? Visibility.Visible : Visibility.Collapsed;

    public static Visibility VisibleWhenEither(bool a, bool b) => a || b ? Visibility.Visible : Visibility.Collapsed;

    public static Visibility CollapsedWhen(bool value) => value ? Visibility.Collapsed : Visibility.Visible;

    public static bool Not(bool value) => !value;

    /// <summary>
    /// simple-icons path data (24x24 viewBox) as a Geometry scaled to <paramref name="size"/> pixels. A new Geometry
    /// per call: geometries cannot be shared between elements. "F1" keeps SVG's nonzero fill rule.
    /// </summary>
    public static Geometry? Path(string? data, double size)
    {
        if (string.IsNullOrEmpty(data)) return null;
        var g = (Geometry)XamlBindingHelper.ConvertValue(typeof(Geometry), "F1 " + data);
        g.Transform = new ScaleTransform { ScaleX = size / 24.0, ScaleY = size / 24.0 };
        return g;
    }

    /// <summary>
    /// An IconElement for a NavigationViewItem: the brand mark as a PathIcon in its colour, or, when there is no path
    /// data, the initials in the tile colour (an IconElement cannot carry a background, so the tile is implied).
    /// </summary>
    public static IconElement BrandIcon(BrandGlyph glyph, double size)
    {
        if (glyph.HasPath)
        {
            var icon = new PathIcon { Data = Path(glyph.PathData, size), Width = size, Height = size };
            if (!glyph.UsesTextColor) icon.Foreground = Brush(glyph.Color);
            return icon;
        }
        return new FontIcon
        {
            Glyph = glyph.Initials,
            FontFamily = new FontFamily("Segoe UI Variable Text"),
            FontWeight = FontWeights.SemiBold,
            FontSize = Math.Max(8, Math.Round(size * 0.6)),
            Foreground = Brush(glyph.TileColor),
        };
    }

    /// <summary>
    /// A page-header badge: the brand mark, or the initials tile in its colour (the Mac's fallback).
    /// Decorative (the page title names the app), so it is hidden from UI Automation.
    /// </summary>
    public static FrameworkElement BrandBadge(BrandGlyph glyph, double size)
    {
        var radius = new CornerRadius(Math.Round(size * 0.24));
        FrameworkElement badge;
        if (glyph.HasPath)
        {
            // The mark itself, no tile (as on the Mac): brand marks are already shaped and coloured.
            var mark = new PathIcon { Data = Path(glyph.PathData, size), Width = size, Height = size };
            if (!glyph.UsesTextColor) mark.Foreground = Brush(glyph.Color);
            badge = mark;
        }
        else
        {
            badge = new Border
            {
                Width = size,
                Height = size,
                CornerRadius = radius,
                Background = Brush(glyph.TileColor),
                Child = new TextBlock
                {
                    Text = glyph.Initials,
                    FontWeight = FontWeights.SemiBold,
                    FontSize = Math.Max(8, Math.Round(size * 0.42)),
                    Foreground = new SolidColorBrush(Colors.White),
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                },
            };
        }
        badge.VerticalAlignment = VerticalAlignment.Top;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAccessibilityView(badge, Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Raw);
        return badge;
    }
}
