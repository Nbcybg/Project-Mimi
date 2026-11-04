using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;

namespace Mimi.App.Controls;

/// <summary>Lays its children out left to right and wraps to the next line (the web's wrapping tab rows).</summary>
internal sealed class WrapPanel : Panel
{
    public double HorizontalSpacing { get; set; } = 4;
    public double VerticalSpacing { get; set; } = 4;

    protected override Size MeasureOverride(Size availableSize)
    {
        var width = double.IsInfinity(availableSize.Width) ? double.PositiveInfinity : availableSize.Width;
        var x = 0.0;
        var lineHeight = 0.0;
        var height = 0.0;
        var widest = 0.0;
        foreach (var child in Children)
        {
            child.Measure(new Size(Math.Max(0, width - x), double.PositiveInfinity));
            var desired = child.DesiredSize;
            if (x > 0 && x + desired.Width > width)
            {
                widest = Math.Max(widest, x);
                height += lineHeight + VerticalSpacing;
                x = 0;
                lineHeight = 0;
                child.Measure(new Size(width, double.PositiveInfinity));
                desired = child.DesiredSize;
            }
            x += desired.Width + (x > 0 ? HorizontalSpacing : 0);
            lineHeight = Math.Max(lineHeight, desired.Height);
        }
        widest = Math.Max(widest, x);
        height += lineHeight;
        return new Size(double.IsInfinity(width) ? widest : width, height);
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        var x = 0.0;
        var y = 0.0;
        var lineHeight = 0.0;
        foreach (var child in Children)
        {
            var desired = child.DesiredSize;
            if (x > 0 && x + desired.Width > finalSize.Width)
            {
                x = 0;
                y += lineHeight + VerticalSpacing;
                lineHeight = 0;
            }
            child.Arrange(new Rect(x, y, desired.Width, desired.Height));
            x += desired.Width + HorizontalSpacing;
            lineHeight = Math.Max(lineHeight, desired.Height);
        }
        return finalSize;
    }
}
