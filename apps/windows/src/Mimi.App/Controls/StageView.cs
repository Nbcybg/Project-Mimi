using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
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
        figureBox.Children.Add(figure);
        figureBox.Children.Add(vrm);
        Children.Add(fill);
        Children.Add(backdrop);
        Children.Add(figureBox);
        // A soft fade at the bottom so the newest messages read over the character (.stage .fade).
        Children.Add(shade);
        vrm.StateChanged += () => DispatcherQueue.TryEnqueue(() => Place());
        SizeChanged += (_, _) => Place();
        Theme.Changed += PaintShade;
        PaintShade();
    }

    /// <summary>Whether a backdrop or a character is showing (the chat's bubbles turn to glass over it).</summary>
    public bool HasSomething { get; private set; }

    public event Action? Changed;

    private void PaintShade()
    {
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
        figure.Height = Math.Max(120, height * 0.92 * Math.Clamp(look.Zoom, 0.4, 2.5));
        // On the holder: the picture itself has an opacity transition, which rules out a render transform on it.
        figureBox.RenderTransform = new TranslateTransform { X = look.X / 100 * ActualWidth, Y = -look.Y / 100 * height };
        vrm.View(look.Zoom, look.X, look.Y);
        var threeD = vrm.State == "ready" && vrm.Visibility == Visibility.Visible;
        figure.Visibility = threeD ? Visibility.Collapsed : Visibility.Visible;
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
