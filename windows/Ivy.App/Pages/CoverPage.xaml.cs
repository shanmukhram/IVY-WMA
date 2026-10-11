using Ivy.App.Core.WindowLock;
using Microsoft.UI.Xaml.Controls;

namespace Ivy.App.Pages;

/// <summary>The blank page shown while the window is locked. It has no text, no icon and does not use the view model.</summary>
public sealed partial class CoverPage : Page, ICoverSurface
{
    public CoverPage() => InitializeComponent();
}
