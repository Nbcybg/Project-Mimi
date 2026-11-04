using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Services;
using Mimi.Core.Desktop;

namespace Mimi.App.Controls;

/// <summary>
/// The situation picture over the chat (feature-gallery.js apply, #25): one of the agent's gallery pictures that the
/// agent (gallery_show) or the person ("แสดงในแชต") put there, like an event picture of a visual novel. It can be
/// minimised to a thumbnail in the corner or closed to a small button; the choice holds until another picture comes.
/// </summary>
internal sealed partial class SceneOverlay : Grid
{
    private readonly Images images;
    private readonly AppConfig config;
    private readonly Action save;
    private readonly Border dim = new() { Background = new SolidColorBrush(Windows.UI.Color.FromArgb(158, 8, 9, 12)), IsHitTestVisible = false };
    private readonly Image picture = new() { Stretch = Stretch.Uniform };
    private readonly Border frame;
    private readonly StackPanel controls = new() { Orientation = Orientation.Horizontal, Spacing = 4, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 8, 10, 0) };
    private string agent = "";
    private string id = "";
    private string shown = "";

    public SceneOverlay(Images images, AppConfig config, Action save)
    {
        this.images = images;
        this.config = config;
        this.save = save;
        AutomationProperties.SetAutomationId(this, "SceneOverlay");
        AutomationProperties.SetName(picture, "ภาพสถานการณ์");
        picture.OpacityTransition = new ScalarTransition { Duration = TimeSpan.FromMilliseconds(600) };
        frame = new Border
        {
            Child = picture,
            CornerRadius = new CornerRadius(6),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Shadow = new ThemeShadow(),
            Translation = new System.Numerics.Vector3(0, 0, 32),
        };
        frame.Tapped += (_, _) =>
        {
            if (Mode == "min") SetMode("open");
        };
        Children.Add(dim);
        Children.Add(frame);
        Children.Add(controls);
        SizeChanged += (_, _) => Layout();
        Visibility = Visibility.Collapsed;
    }

    /// <summary>The picture for this agent's situation (null / empty: none, or a group chat).</summary>
    public async void Update(string? agentName, string? situation)
    {
        if (agentName is null || string.IsNullOrEmpty(situation))
        {
            agent = id = shown = "";
            picture.Source = null;
            Visibility = Visibility.Collapsed;
            return;
        }
        agent = agentName;
        id = situation;
        var mode = Mode;
        var path = $"/api/gallery/{Uri.EscapeDataString(agent)}/{Uri.EscapeDataString(id)}{(mode == "min" ? "/thumb" : "")}";
        Visibility = Visibility.Visible;
        Paint(mode);
        if (mode == "closed" || path == shown) return;
        var fresh = !shown.StartsWith($"/api/gallery/{Uri.EscapeDataString(agent)}/{Uri.EscapeDataString(id)}", StringComparison.Ordinal);
        shown = path;
        if (fresh) picture.Opacity = 0;
        var bitmap = await images.Get(path);
        // A picture without a preview of its own: the picture itself, made small.
        if (bitmap is null && mode == "min") bitmap = await images.Get($"/api/gallery/{Uri.EscapeDataString(agent)}/{Uri.EscapeDataString(id)}");
        if (shown != path) return;
        picture.Source = bitmap;
        picture.Opacity = 1;
        Layout();
    }

    /// <summary>open / min / closed for the picture on screen: a different picture than the one dealt with starts open.</summary>
    private string Mode => config.Scenes.TryGetValue(agent, out var entry) && entry.Id == id ? entry.Mode : "open";

    private void SetMode(string mode)
    {
        config.Scenes[agent] = new SceneMode { Id = id, Mode = mode };
        save();
        Update(agent, id);
    }

    private Button Control(string text, string name, Action act)
    {
        var button = new Button
        {
            Content = text,
            Padding = new Thickness(10, 2, 10, 3),
            CornerRadius = new CornerRadius(8),
            Background = new SolidColorBrush(Windows.UI.Color.FromArgb(191, 20, 22, 27)),
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
        };
        AutomationProperties.SetName(button, name);
        ToolTipService.SetToolTip(button, name);
        button.Click += (_, _) => act();
        return button;
    }

    private void Paint(string mode)
    {
        controls.Children.Clear();
        switch (mode)
        {
            case "open":
                controls.Children.Add(Control("–", "ย่อภาพ", () => SetMode("min")));
                controls.Children.Add(Control("×", "ปิดภาพ", () => SetMode("closed")));
                break;
            case "min":
                controls.Children.Add(Control("▢", "ขยายภาพ", () => SetMode("open")));
                controls.Children.Add(Control("×", "ปิดภาพ", () => SetMode("closed")));
                break;
            default:
                var reopen = Control("🖼", "แสดงภาพสถานการณ์อีกครั้ง", () => SetMode("open"));
                reopen.Opacity = 0.6;
                controls.Children.Add(reopen);
                break;
        }
        dim.Visibility = mode == "open" ? Visibility.Visible : Visibility.Collapsed;
        frame.Visibility = mode == "closed" ? Visibility.Collapsed : Visibility.Visible;
        // Only the picture and the buttons take clicks; the chat under the dimmed area stays as it is.
        IsHitTestVisible = true;
        Background = null;
        Layout();
    }

    private void Layout()
    {
        if (Mode == "min")
        {
            frame.HorizontalAlignment = HorizontalAlignment.Right;
            frame.VerticalAlignment = VerticalAlignment.Top;
            frame.Margin = new Thickness(0, 38, 12, 0);
            frame.BorderBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(64, 255, 255, 255));
            frame.BorderThickness = new Thickness(1);
            picture.MaxWidth = 150;
            picture.MaxHeight = 120;
        }
        else
        {
            frame.HorizontalAlignment = HorizontalAlignment.Center;
            frame.VerticalAlignment = VerticalAlignment.Center;
            frame.Margin = new Thickness(0);
            frame.BorderThickness = new Thickness(0);
            picture.MaxWidth = Math.Max(100, ActualWidth * 0.94);
            picture.MaxHeight = Math.Max(100, ActualHeight * 0.94);
        }
    }
}
