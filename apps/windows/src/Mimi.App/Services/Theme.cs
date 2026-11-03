using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Mimi.App.Services;

/// <summary>
/// Dark and light, as the web app's two palettes (app.css <c>:root</c> and <c>[data-theme="light"]</c>).
/// Every Mimi brush is one shared <see cref="SolidColorBrush"/> (App.xaml), so a switch recolours them in
/// place: everything on screen, in XAML or built in code, follows at once. Fluent's own controls follow
/// the root element's <see cref="FrameworkElement.RequestedTheme"/>.
/// </summary>
internal static class Theme
{
    // name: (dark, light) — the CSS variables of app.css.
    private static readonly Dictionary<string, (uint Dark, uint Light)> Palette = new()
    {
        ["Bg"] = (0xFF171215, 0xFFF8EBF0),
        ["Panel"] = (0xFF20191E, 0xFFFFFAFC),
        ["Raised"] = (0xFF2A2027, 0xFFFFF2F7),
        ["Hover"] = (0xFF33262F, 0xFFFBE3EC),
        ["Line"] = (0xFF40303A, 0xFFEAD0DB),
        ["LineSoft"] = (0xFF2E242C, 0xFFF3E0E8),
        ["LineStrong"] = (0xFF4B3844, 0xFFDDB9C8),
        ["Ink"] = (0xFFF2E7EC, 0xFF3D2533),
        ["Ink2"] = (0xFFD2BEC8, 0xFF654655),
        ["Muted"] = (0xFFA48B97, 0xFF967281),
        ["Faint"] = (0xFF7A6470, 0xFFB598A4),
        ["Accent"] = (0xFFE08AA7, 0xFFCB6B8A),
        ["AccentInk"] = (0xFF2A121B, 0xFFFFFFFF),
        ["AccentText"] = (0xFFF2AEC3, 0xFFA94C6D),
        ["AccentSoft"] = (0x24E08AA7, 0x21CB6B8A),
        ["Ok"] = (0xFF7FCF9F, 0xFF3E8D5F),
        ["Warn"] = (0xFFE1B96C, 0xFFA9791F),
        ["Bad"] = (0xFFF08995, 0xFFC64E58),
        ["Info"] = (0xFF8DB8E8, 0xFF3970A5),
        ["Violet"] = (0xFFC3A6F2, 0xFF8460B8),
        ["User"] = (0xFF3B2733, 0xFFF6DFE8),
        ["UserLine"] = (0xFF563746, 0xFFEBC7D4),
        ["Code"] = (0xFF120E11, 0xFFFBEEF3),
        ["Act"] = (0xFFD6B98C, 0xFF8C5B3F),
        // Chat text over a character or a background (figure-tx / glass).
        ["Glass"] = (0xD6141115, 0xEBFFFAFC),
        ["GlassUser"] = (0xF03B2733, 0xF2F6DFE8),
    };

    public static string Current { get; private set; } = "dark";

    public static ElementTheme Element => Current == "light" ? ElementTheme.Light : ElementTheme.Dark;

    /// <summary>After a switch (pages that draw with their own colours redraw).</summary>
    public static event Action? Changed;

    public static Color ColorOf(string name, string? theme = null)
    {
        var (dark, light) = Palette[name];
        var argb = (theme ?? Current) == "light" ? light : dark;
        return Color.FromArgb((byte)(argb >> 24), (byte)(argb >> 16), (byte)(argb >> 8), (byte)argb);
    }

    public static Brush Brush(string name) => (Brush)Application.Current.Resources[$"Mimi{name}Brush"];

    /// <summary>Makes sure every brush exists (App.xaml has the long-standing ones; the rest are added here).</summary>
    public static void Install()
    {
        var resources = Application.Current.Resources;
        foreach (var name in Palette.Keys)
        {
            var key = $"Mimi{name}Brush";
            if (!resources.ContainsKey(key)) resources[key] = new SolidColorBrush(ColorOf(name));
        }
    }

    public static void Apply(string theme, FrameworkElement? root, AppWindow? window)
    {
        theme = theme == "light" ? "light" : "dark";
        var changed = theme != Current;
        Current = theme;
        Install();
        var resources = Application.Current.Resources;
        foreach (var name in Palette.Keys)
        {
            if (resources[$"Mimi{name}Brush"] is SolidColorBrush brush) brush.Color = ColorOf(name);
        }
        if (root is not null) root.RequestedTheme = Element;
        if (window is not null)
        {
            window.TitleBar.PreferredTheme = theme == "light" ? TitleBarTheme.Light : TitleBarTheme.Dark;
        }
        if (changed) Changed?.Invoke();
    }

    /// <summary>A colour from "#rrggbb" (backgrounds chosen in the web's colour pickers).</summary>
    public static Color? Parse(string? hex)
    {
        if (hex is not { Length: 7 } || hex[0] != '#') return null;
        try
        {
            var value = Convert.ToUInt32(hex[1..], 16);
            return Color.FromArgb(255, (byte)(value >> 16), (byte)(value >> 8), (byte)value);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    public static Color Transparent => Colors.Transparent;
}
