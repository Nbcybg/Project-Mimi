using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Services;

namespace Mimi.App.Controls;

/// <summary>The web app's small building blocks (app.css .card, .btn, .seg, .hint, h3) for pages built in code.</summary>
internal static class Ui
{
    public static Style Style(string key) => (Style)Application.Current.Resources[key];

    public static TextBlock Title(string text, double size = 15) => new()
    {
        Text = text,
        FontSize = size,
        FontWeight = FontWeights.SemiBold,
        Foreground = Theme.Brush("Ink"),
        TextWrapping = TextWrapping.Wrap,
    };

    /// <summary>The small upper-case heading of a card (.card h2 / LANGUAGE).</summary>
    public static TextBlock Section(string text) => new() { Text = text, Style = Style("MimiSectionTitle") };

    public static TextBlock Hint(string text, string brush = "Muted") => new()
    {
        Text = text,
        FontSize = 12,
        Foreground = Theme.Brush(brush),
        TextWrapping = TextWrapping.Wrap,
    };

    public static TextBlock Mono(string text, double size = 12) => new()
    {
        Text = text,
        FontFamily = new FontFamily("Cascadia Mono, Consolas"),
        FontSize = size,
        Foreground = Theme.Brush("Ink2"),
        TextWrapping = TextWrapping.Wrap,
        IsTextSelectionEnabled = true,
    };

    public static Border Card(params UIElement[] children)
    {
        var stack = new StackPanel { Spacing = 10 };
        foreach (var child in children) stack.Children.Add(child);
        return new Border { Style = Style("MimiCard"), Child = stack };
    }

    public static Button Button(string text, Action click, string kind = "", string? id = null, string? tip = null)
    {
        var button = new Button
        {
            Content = text,
            Style = Style(kind switch { "pri" => "MimiPrimaryButton", "ghost" => "MimiGhostButton", _ => "MimiButton" }),
        };
        if (id is not null) AutomationProperties.SetAutomationId(button, id);
        if (tip is not null) ToolTipService.SetToolTip(button, tip);
        button.Click += (_, _) => click();
        return button;
    }

    public static StackPanel Row(double spacing = 6, params UIElement[] children)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = spacing };
        foreach (var child in children) row.Children.Add(child);
        return row;
    }

    /// <summary>A wrapping row (buttons, chips).</summary>
    public static VariableSizedWrapGrid Wrap(params UIElement[] children)
    {
        var grid = new VariableSizedWrapGrid { Orientation = Orientation.Horizontal, ItemHeight = double.NaN };
        foreach (var child in children)
        {
            if (child is FrameworkElement element) element.Margin = new Thickness(0, 0, 6, 6);
            grid.Children.Add(child);
        }
        return grid;
    }

    /// <summary>
    /// The web's segmented control (.seg): one of several, the chosen one lit. <paramref name="pick"/> gets the value.
    /// </summary>
    public static Border Seg<T>(IReadOnlyList<(T Value, string Label)> options, T current, Action<T> pick, string? id = null)
    {
        var grid = new Grid { ColumnSpacing = 3 };
        var buttons = new List<ToggleButton>();
        for (var i = 0; i < options.Count; i++)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var (value, label) = options[i];
            var button = new ToggleButton
            {
                Content = label,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                CornerRadius = new CornerRadius(8),
                BorderThickness = new Thickness(0),
                Padding = new Thickness(6, 5, 6, 5),
                FontSize = 13,
                IsChecked = Equals(value, current),
            };
            if (id is not null) AutomationProperties.SetAutomationId(button, $"{id}-{value}");
            button.Click += (_, _) =>
            {
                foreach (var other in buttons) other.IsChecked = ReferenceEquals(other, button);
                pick(value);
            };
            buttons.Add(button);
            Grid.SetColumn(button, i);
            grid.Children.Add(button);
        }
        return new Border
        {
            Child = grid,
            Padding = new Thickness(3),
            CornerRadius = new CornerRadius(10),
            BorderBrush = Theme.Brush("Line"),
            BorderThickness = new Thickness(1),
            Background = Theme.Brush("Bg"),
        };
    }

    /// <summary>A label above a control, with an optional hint under it.</summary>
    public static StackPanel Field(string label, UIElement control, string? hint = null)
    {
        var box = new StackPanel { Spacing = 4 };
        box.Children.Add(new TextBlock { Text = label, FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = Theme.Brush("Ink2"), TextWrapping = TextWrapping.Wrap });
        box.Children.Add(control);
        if (hint is { Length: > 0 }) box.Children.Add(Hint(hint));
        return box;
    }

    /// <summary>A coloured pill (status: ok / warn / bad / info).</summary>
    public static Border Pill(string text, string brush = "Muted") => new()
    {
        Child = new TextBlock { Text = text, FontSize = 11, Foreground = Theme.Brush(brush) },
        BorderBrush = Theme.Brush(brush),
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(9),
        Padding = new Thickness(7, 1, 7, 1),
        VerticalAlignment = VerticalAlignment.Center,
    };

    public static ScrollViewer Scroll(UIElement content, double maxHeight = double.PositiveInfinity) => new()
    {
        Content = content,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        MaxHeight = maxHeight,
    };
}
