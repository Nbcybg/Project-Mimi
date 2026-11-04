using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using Mimi.App.Services;
using Mimi.Core.Desktop;

namespace Mimi.App.Controls;

/// <summary>
/// The stage behind a chat, visual-novel style (feature-stage.js + feature-backgrounds.js): the backdrop, then
/// the character — a 2D picture picked by the newest emoji, or the agent's 3D VRM model — placed by the chat's
/// own size/slide. The chat's messages sit on top of it.
/// </summary>
internal sealed partial class StageView : Grid
{
    private readonly Border fill = new();
    private readonly Image backdrop = new() { Stretch = Stretch.UniformToFill, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly Grid figureBox = new();
    private readonly Grid zoomBox = new() { RenderTransformOrigin = new Windows.Foundation.Point(0.5, 1) };
    private readonly ScaleTransform zoomScale = new();
    private readonly Grid breath = new() { RenderTransformOrigin = new Windows.Foundation.Point(0.5, 1) };
    private readonly Image figure = new() { Stretch = Stretch.Uniform, VerticalAlignment = VerticalAlignment.Bottom, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly Border shade = new() { IsHitTestVisible = false };
    private readonly VrmView vrm;
    private readonly Images images;
    private readonly HashSet<string> broken = [];
    private string shownBackdrop = "";
    private string shownFigure = "";
    private string wantedFigure = "";
    private string agent = "";
    private ChatLook look = new();

    public StageView(Images images, Func<Mimi.Core.Net.MimiApi> api, string cache)
    {
        this.images = images;
        vrm = new VrmView(api, Path.Combine(cache, "models")) { Visibility = Visibility.Collapsed };
        IsHitTestVisible = false;
        backdrop.OpacityTransition = new ScalarTransition { Duration = TimeSpan.FromMilliseconds(600) };
        figure.OpacityTransition = new ScalarTransition { Duration = TimeSpan.FromMilliseconds(420) };
        // The web's slow breath (fig-breathe, 5.5 s): the 2D figure stretches from its feet.
        // It needs a holder of its own: an OpacityTransition on the picture rules out a transform origin on it.
        var scale = new ScaleTransform();
        breath.RenderTransform = scale;
        var breathe = new DoubleAnimation
        {
            From = 1,
            To = 1.007,
            Duration = TimeSpan.FromSeconds(2.75),
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EnableDependentAnimation = true,
        };
        Storyboard.SetTarget(breathe, scale);
        Storyboard.SetTargetProperty(breathe, "ScaleY");
        var board = new Storyboard();
        board.Children.Add(breathe);
        Loaded += (_, _) => board.Begin();
        zoomBox.RenderTransform = zoomScale;
        breath.Children.Add(figure);
        zoomBox.Children.Add(breath);
        figureBox.Children.Add(zoomBox);
        figureBox.Children.Add(vrm);
        Children.Add(fill);
        Children.Add(backdrop);
        Children.Add(figureBox);
        // A soft fade at the bottom so the newest messages read over the character (.stage .fade).
        Children.Add(shade);
        vrm.StateChanged += () => DispatcherQueue.TryEnqueue(() => Place());
        SizeChanged += (_, _) =>
        {
            // A character scaled up to 10× must not draw over the rest of the window.
            if (ActualWidth > 0 && ActualHeight > 0) Clip = new RectangleGeometry { Rect = new Windows.Foundation.Rect(0, 0, ActualWidth, ActualHeight) };
            Place();
        };
        Theme.Changed += PaintShade;
        PaintShade();
    }

    /// <summary>Whether a backdrop or a character is showing (the chat's bubbles turn to glass over it).</summary>
    public bool HasSomething { get; private set; }

    /// <summary>The chat is the full-window character screen: the figure is taller and the fade is the web's .solo one.</summary>
    public bool Solo
    {
        get => solo;
        set
        {
            if (solo == value) return;
            solo = value;
            PaintShade();
            Place();
        }
    }

    private bool solo;

    public event Action? Changed;

    private void PaintShade()
    {
        if (solo)
        {
            var fade = Theme.ColorOf("SoloFade");
            shade.Background = new LinearGradientBrush
            {
                StartPoint = new Windows.Foundation.Point(0, 0),
                EndPoint = new Windows.Foundation.Point(0, 1),
                GradientStops =
                {
                    new GradientStop { Color = Windows.UI.Color.FromArgb(0, fade.R, fade.G, fade.B), Offset = 0 },
                    new GradientStop { Color = Windows.UI.Color.FromArgb(56, fade.R, fade.G, fade.B), Offset = 0.5 },
                    new GradientStop { Color = Windows.UI.Color.FromArgb(153, fade.R, fade.G, fade.B), Offset = 1 },
                },
            };
            return;
        }
        var bg = Theme.ColorOf("Bg");
        shade.Background = new LinearGradientBrush
        {
            StartPoint = new Windows.Foundation.Point(0, 0),
            EndPoint = new Windows.Foundation.Point(0, 1),
            GradientStops =
            {
                new GradientStop { Color = Windows.UI.Color.FromArgb(0, bg.R, bg.G, bg.B), Offset = 0.55 },
                new GradientStop { Color = Windows.UI.Color.FromArgb(200, bg.R, bg.G, bg.B), Offset = 1 },
            },
        };
    }

    /// <summary>Shows what the chat asks for: <paramref name="agentName"/> null = a group (no character).</summary>
    public async void Update(StageData data, ChatLook look, bool characterOn, string? agentName, string? mood)
    {
        this.look = look;
        if (agentName != agent)
        {
            broken.Clear();
            shownFigure = "";
            figure.Source = null;
            agent = agentName ?? "";
        }
        // The backdrop.
        var target = data.Backdrop(look, agentName);
        if ((target?.Key ?? "") != shownBackdrop)
        {
            shownBackdrop = target?.Key ?? "";
            await ShowBackdrop(target);
        }
        // The character: 3D when the agent is a VRM and the model loads, else the best picture that loads.
        var model = characterOn && agentName is not null ? data.ModelPath(agentName) : null;
        if (model is not null)
        {
            vrm.Show(model);
            vrm.Motions(data.Motions(agentName!), data.IdleMotion(agentName!));
            vrm.Mood(mood);
        }
        else vrm.Hide();
        if (!characterOn || agentName is null)
        {
            figure.Opacity = 0;
            wantedFigure = "";
            shownFigure = "";
        }
        else if (model is null || vrm.State != "ready")
        {
            var pick = data.Candidates(agentName, mood).FirstOrDefault(item => !broken.Contains(item.Path));
            if (pick is not null && pick.Path != shownFigure && pick.Path != wantedFigure)
            {
                wantedFigure = pick.Path;
                var bitmap = await images.Get(pick.Path);
                if (wantedFigure != pick.Path) return;
                wantedFigure = "";
                if (bitmap is null)
                {
                    broken.Add(pick.Path);
                    Update(data, look, characterOn, agentName, mood);
                    return;
                }
                figure.Opacity = 0;
                figure.Source = bitmap;
                shownFigure = pick.Path;
                figure.Opacity = 1;
            }
            else if (pick is null && shownFigure.Length == 0) figure.Opacity = 0;
        }
        Place();
    }

    private async Task ShowBackdrop(BackdropTarget? target)
    {
        fill.Background = null;
        backdrop.Opacity = 0;
        if (target is null) return;
        if (target.Color is { } color && Theme.Parse(color) is { } solid)
        {
            fill.Background = new SolidColorBrush(solid);
            return;
        }
        if (target.From is { } from && Theme.Parse(from) is { } start && Theme.Parse(target.To) is { } end)
        {
            var radians = (target.Angle - 90) * Math.PI / 180;
            fill.Background = new LinearGradientBrush
            {
                StartPoint = new Windows.Foundation.Point(0.5 - Math.Cos(radians) / 2, 0.5 - Math.Sin(radians) / 2),
                EndPoint = new Windows.Foundation.Point(0.5 + Math.Cos(radians) / 2, 0.5 + Math.Sin(radians) / 2),
                GradientStops = { new GradientStop { Color = start, Offset = 0 }, new GradientStop { Color = end, Offset = 1 } },
            };
            return;
        }
        BitmapImage? image = target.File is { } file ? new BitmapImage(new Uri(file)) : target.Path is { } path ? await images.Get(path) : null;
        if (image is null || shownBackdrop != target.Key) return;
        backdrop.Source = image;
        backdrop.Opacity = 1;
    }

    /// <summary>The character's size and slide (the chat's own placement), and whether anything shows.</summary>
    private void Place()
    {
        var height = ActualHeight;
        // The picture keeps the web's 94% of the stage; the chat's size is a scale from the feet,
        // not a taller layout box (a taller image was held back by the window width).
        figure.Height = Math.Max(20, height * (solo ? 0.94 : 0.92));
        zoomScale.ScaleX = zoomScale.ScaleY = Math.Clamp(look.Zoom, 0.1, 10);
        // On the holder: the picture itself has an opacity transition, which rules out a render transform on it.
        figureBox.RenderTransform = new TranslateTransform { X = look.X / 100 * ActualWidth, Y = -look.Y / 100 * height };
        vrm.View(look.Zoom, look.X, look.Y);
        var threeD = vrm.State == "ready" && vrm.Visibility == Visibility.Visible;
        figure.Visibility = threeD ? Visibility.Collapsed : Visibility.Visible;
        // .solo .fade is the bottom 62% only.
        shade.VerticalAlignment = solo ? VerticalAlignment.Bottom : VerticalAlignment.Stretch;
        shade.Height = solo ? Math.Max(0, height * 0.62) : double.NaN;
        var something = shownBackdrop.Length > 0 || threeD || (figure.Opacity > 0 && figure.Source is not null);
        shade.Visibility = something ? Visibility.Visible : Visibility.Collapsed;
        if (something != HasSomething)
        {
            HasSomething = something;
            Changed?.Invoke();
        }
    }

    /// <summary>A reply is streaming in: the 3D character moves its mouth.</summary>
    public void Talk() => vrm.Talk();
}
