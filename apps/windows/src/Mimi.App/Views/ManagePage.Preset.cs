using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Controls;
using Mimi.Core.Hub;

namespace Mimi.App.Views;

/// <summary>
/// The web's model-preset editor (app.js hubModels): the sampling knobs as sliders with their
/// meaning, instead of three bare number fields.
/// </summary>
public sealed partial class ManagePage
{
    private FrameworkElement PresetExtras(JsonObject preset)
    {
        var card = new Border
        {
            Background = Brush("MimiPanelBrush"),
            BorderBrush = Brush("MimiLineBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 10, 12, 12),
        };
        var body = new StackPanel { Spacing = 10 };
        body.Children.Add(Ui.Section("ค่าการสุ่ม"));
        body.Children.Add(Ui.Hint("temperature / top_p / top_k — ว่างไว้ = ใช้ค่าเริ่มต้นของโมเดล"));
        body.Children.Add(Knob(preset, "temperature", "temperature", 0, 2, 0.05, 1, "ต่ำ = ตรงไปตรงมา, สูง = คิดสร้างสรรค์", "0.00"));
        body.Children.Add(Knob(preset, "topP", "top_p", 0, 1, 0.01, 1, "เลือกคำจากความน่าจะเป็นสะสม", "0.00"));
        body.Children.Add(Knob(preset, "topK", "top_k", 1, 1000, 1, 0, "เลือกจาก K คำแรกที่ใกล้ที่สุด", "0"));
        card.Child = body;
        return card;
    }

    private FrameworkElement Knob(JsonObject preset, string key, string label, double min, double max, double step, double fallback, string hint, string format)
    {
        var current = preset[key] is JsonValue value && value.TryGetValue<double>(out var number) ? number : fallback;
        var shown = new TextBlock
        {
            Text = preset[key] is null ? "(ค่าเริ่มต้น)" : current.ToString(format),
            FontSize = 11,
            Foreground = Brush("MimiMutedBrush"),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var slider = new Slider { Minimum = min, Maximum = max, StepFrequency = step, Value = current };
        var resetting = false;
        var clear = new Button { Content = "ล้าง", FontSize = 11, MinHeight = 0, Padding = new Thickness(6, 1, 6, 2), Margin = new Thickness(6, 0, 0, 0) };
        clear.Click += (_, _) =>
        {
            resetting = true;
            slider.Value = fallback;
            resetting = false;
            preset.Remove(key);
            shown.Text = "(ค่าเริ่มต้น)";
        };
        slider.ValueChanged += (_, args) =>
        {
            if (resetting) return;
            preset[key] = args.NewValue;
            shown.Text = args.NewValue.ToString(format);
        };
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(new TextBlock { Text = label, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, Foreground = Brush("MimiInk2"), VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(shown, 1);
        head.Children.Add(shown);
        Grid.SetColumn(clear, 2);
        head.Children.Add(clear);
        var box = new StackPanel { Spacing = 2 };
        box.Children.Add(head);
        box.Children.Add(slider);
        box.Children.Add(Ui.Hint(hint));
        return box;
    }
}
