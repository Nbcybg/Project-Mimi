using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Mimi.App.Views;

/// <summary>An agent's round picture (loaded with the token), or its first letter while there is none.</summary>
public sealed class Avatar : Grid
{
    public static readonly DependencyProperty PathProperty =
        DependencyProperty.Register(nameof(Path), typeof(string), typeof(Avatar), new PropertyMetadata(null, (d, _) => ((Avatar)d).Load()));

    public static readonly DependencyProperty InitialProperty =
        DependencyProperty.Register(nameof(Initial), typeof(string), typeof(Avatar), new PropertyMetadata("", (d, _) => ((Avatar)d).letter.Text = ((Avatar)d).Initial));

    public static readonly DependencyProperty SizeProperty =
        DependencyProperty.Register(nameof(Size), typeof(double), typeof(Avatar), new PropertyMetadata(36.0, (d, _) => ((Avatar)d).Resize()));

    private readonly Ellipse circle = new();
    private readonly TextBlock letter = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold };

    public Avatar()
    {
        circle.Fill = (Brush)Application.Current.Resources["MimiRaisedBrush"];
        letter.Foreground = (Brush)Application.Current.Resources["MimiAccentTextBrush"];
        Children.Add(circle);
        Children.Add(letter);
        Resize();
    }

    public string? Path
    {
        get => (string?)GetValue(PathProperty);
        set => SetValue(PathProperty, value);
    }

    public string Initial
    {
        get => (string)GetValue(InitialProperty);
        set => SetValue(InitialProperty, value);
    }

    public double Size
    {
        get => (double)GetValue(SizeProperty);
        set => SetValue(SizeProperty, value);
    }

    private void Resize()
    {
        Width = Height = Size;
        letter.FontSize = Size * 0.42;
    }

    private async void Load()
    {
        var path = Path;
        circle.Fill = (Brush)Application.Current.Resources["MimiRaisedBrush"];
        letter.Visibility = Visibility.Visible;
        if (string.IsNullOrEmpty(path) || App.Instance?.Images is not { } images) return;
        var image = await images.Get(path);
        if (image is null || Path != path) return;
        circle.Fill = new ImageBrush { ImageSource = image, Stretch = Stretch.UniformToFill };
        letter.Visibility = Visibility.Collapsed;
    }
}
