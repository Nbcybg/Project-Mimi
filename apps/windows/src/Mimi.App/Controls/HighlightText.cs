using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Mimi.Core.ViewModels;

namespace Mimi.App.Controls;

/// <summary>A search snippet with the matched words marked (app.js renderSearch's &lt;mark&gt;), never HTML.</summary>
public sealed class HighlightText : ContentControl
{
    public static readonly DependencyProperty RowProperty =
        DependencyProperty.Register(nameof(Row), typeof(SearchRow), typeof(HighlightText), new PropertyMetadata(null, (control, _) => ((HighlightText)control).Build()));

    public SearchRow? Row
    {
        get => (SearchRow?)GetValue(RowProperty);
        set => SetValue(RowProperty, value);
    }

    public HighlightText() => IsTabStop = false;

    private static Brush Brush(string key) => (Brush)Application.Current.Resources[key];

    private void Build()
    {
        var text = new TextBlock { TextWrapping = TextWrapping.Wrap, MaxLines = 3, FontSize = 13, Foreground = Brush("MimiInk2Brush") };
        foreach (var (part, match) in Row?.Parts ?? [])
        {
            text.Inlines.Add(match
                ? new Run { Text = part, FontWeight = FontWeights.SemiBold, Foreground = Brush("MimiAccentTextBrush") }
                : new Run { Text = part });
        }
        Content = text;
    }
}
