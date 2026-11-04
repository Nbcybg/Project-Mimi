using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using MessageFormat = Mimi.Core.Protocol.MessageFormat;
using MBlock = Mimi.Core.Protocol.Block;
using MSpan = Mimi.Core.Protocol.Span;

namespace Mimi.App.Controls;

/// <summary>
/// Message text the way the web shows it (api-contract.md B.2): ``` blocks, `code`, **bold**, *actions*,
/// links (open in the browser) and @mentions — plain text otherwise, never HTML. Selectable.
/// </summary>
public sealed class MessageText : ContentControl
{
    public static readonly DependencyProperty TextProperty =
        DependencyProperty.Register(nameof(Text), typeof(string), typeof(MessageText), new PropertyMetadata("", (control, _) => ((MessageText)control).Build()));

    public static readonly DependencyProperty TextBrushProperty =
        DependencyProperty.Register(nameof(TextBrush), typeof(Brush), typeof(MessageText), new PropertyMetadata(null, (control, _) => ((MessageText)control).Build()));

    public static readonly DependencyProperty TextSizeProperty =
        DependencyProperty.Register(nameof(TextSize), typeof(double), typeof(MessageText), new PropertyMetadata(14.0, (control, _) => ((MessageText)control).Build()));

    public string Text
    {
        get => (string)GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    /// <summary>The colour of the words (the user's bubble is light on the character screen).</summary>
    public Brush? TextBrush
    {
        get => (Brush?)GetValue(TextBrushProperty);
        set => SetValue(TextBrushProperty, value);
    }

    /// <summary>The chat's text size (0/1/2 in the chat setting), applied to every block.</summary>
    public double TextSize
    {
        get => (double)GetValue(TextSizeProperty);
        set => SetValue(TextSizeProperty, value);
    }

    public MessageText()
    {
        IsTabStop = false;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
    }

    private static Brush Brush(string key) => (Brush)Application.Current.Resources[key];

    private Brush Ink => TextBrush ?? Brush("MimiInkBrush");

    private void Build()
    {
        var panel = new StackPanel { Spacing = 6 };
        foreach (var block in MessageFormat.Blocks(Text ?? ""))
        {
            if (block is MBlock.Code code)
            {
                panel.Children.Add(new Border
                {
                    Background = Brush("MimiCodeBrush"),
                    CornerRadius = new CornerRadius(6),
                    Padding = new Thickness(10, 8, 10, 8),
                    Child = new ScrollViewer
                    {
                        HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                        VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                        Content = new TextBlock
                        {
                            Text = code.Text,
                            FontFamily = new FontFamily("Cascadia Mono, Consolas"),
                            FontSize = Math.Max(9, TextSize - 1.5),
                            IsTextSelectionEnabled = true,
                            Foreground = Ink,
                        },
                    },
                });
                continue;
            }
            var text = new RichTextBlock { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, Foreground = Ink, FontSize = TextSize };
            var paragraph = new Paragraph();
            foreach (var span in ((MBlock.Paragraph)block).Spans)
            {
                switch (span)
                {
                    case MSpan.Code inline:
                        paragraph.Inlines.Add(new Run { Text = inline.Text, FontFamily = new FontFamily("Cascadia Mono, Consolas"), Foreground = Brush("MimiAccentTextBrush") });
                        break;
                    case MSpan.Bold bold:
                        paragraph.Inlines.Add(new Run { Text = bold.Text, FontWeight = FontWeights.SemiBold });
                        break;
                    case MSpan.Action action:
                        paragraph.Inlines.Add(new Run { Text = action.Text, FontStyle = Windows.UI.Text.FontStyle.Italic, Foreground = Brush("MimiActBrush") });
                        break;
                    case MSpan.Link link when Uri.TryCreate(link.Url, UriKind.Absolute, out var url):
                        var hyperlink = new Hyperlink { NavigateUri = url, Foreground = Brush("MimiInfoBrush") };
                        hyperlink.Inlines.Add(new Run { Text = link.Url });
                        paragraph.Inlines.Add(hyperlink);
                        break;
                    case MSpan.Mention mention:
                        paragraph.Inlines.Add(new Run { Text = mention.Text, Foreground = Brush("MimiAccentTextBrush"), FontWeight = FontWeights.SemiBold });
                        break;
                    default:
                        paragraph.Inlines.Add(new Run { Text = span.Text });
                        break;
                }
            }
            text.Blocks.Add(paragraph);
            panel.Children.Add(text);
        }
        Content = panel;
    }
}
