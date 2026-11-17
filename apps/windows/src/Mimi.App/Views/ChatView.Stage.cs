using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core;
using Mimi.Core.Desktop;
using Mimi.Core.Hub;
using Mimi.Core.Protocol;
using Mimi.Core.ViewModels;
using Color = Windows.UI.Color;

namespace Mimi.App.Views;

/// <summary>
/// The chat's stage and its own look (the web's "Chat setting": ข้อมูล / หน้าตา): text size, theme, the
/// character and how much chat shows over it, where it stands, and the chat's background.
/// </summary>
public sealed partial class ChatView
{
    private App? app;
    private StageData? stage;
    private StageView? stageView;
    private SceneOverlay? scene;
    private string? mood;
    private Action<bool>? railPeek;
    private Action? railRepaint;
    private ScrollViewer? messagesScroll;
    private bool bubbleFadeQueued;
    private Border? stageFade;
    private readonly Dictionary<string, TextBox> statusBoxes = [];

    private static readonly (string Key, string Label)[] StatusKeys = [("location", "ที่อยู่"), ("outfit", "ชุด"), ("current_task", "กำลังทำ"), ("mood", "อารมณ์")];

    internal void Attach(App owner, StageData data, string cache)
    {
        app = owner;
        stage = data;
        stageView = new StageView(owner.Images, () => owner.Session.Api, cache);
        StageHost.Children.Add(stageView);
        // The web's .solo .stage .fade: a gradient over the lower 62% of the stage, so the chat
        // does not fight the character's face — transparent at its top, 60% of the stage colour at the bottom.
        stageFade = new Border
        {
            VerticalAlignment = VerticalAlignment.Bottom,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Background = FadeBrush(),
            IsHitTestVisible = false,
            Visibility = Visibility.Collapsed,
        };
        StageHost.Children.Add(stageFade);
        StageHost.SizeChanged += (_, _) => stageFade.Height = StageHost.ActualHeight * 0.62;
        // The situation picture lies over the messages (feature-gallery.js #cg), in the same row as the stage.
        scene = new SceneOverlay(owner.Images, owner.Config, () => owner.SaveConfig(later: true));
        if (StageHost.Parent is Grid layout)
        {
            Grid.SetRow(scene, Grid.GetRow(StageHost));
            Grid.SetRowSpan(scene, Grid.GetRowSpan(StageHost));
            // Under the messages, as #cg is in the web's stage (it used to be added last, above the chat).
            layout.Children.Insert(layout.Children.IndexOf(StageHost) + 1, scene);
        }
        data.Changed += () => DispatcherQueue.TryEnqueue(RefreshStage);
        StartRuleTimer();
        Messages.Loaded += (_, _) => HookMessagesScroll();
        Messages.ContainerContentChanging += (_, _) => QueueBubbleFade();
        Messages.SizeChanged += (_, _) => QueueBubbleFade();
        BottomDock.SizeChanged += (_, _) => UpdateSoloPadding();
        ViewModel.Grew += () => DispatcherQueue.TryEnqueue(OnGrew);
        ViewModel.PropertyChanged += (_, e) =>
        {
            // The chat's kind and agent arrive with chat-open: the character screen follows.
            if (e.PropertyName == nameof(ChatViewModel.ChatId)) DispatcherQueue.TryEnqueue(ApplyLook);
            if (e.PropertyName == nameof(ChatViewModel.ContextLabel)) Meter();
        };
        Theme.Changed += PaintChatBrushes;
        Theme.Changed += () => { if (stageFade is not null) stageFade.Background = FadeBrush(); };
    }

    private ChatLook Look => app is not null && ViewModel.ChatId != 0 ? app.Config.Look(ViewModel.ChatId) : new ChatLook();

    private ChatLook EditLook()
    {
        var look = app!.Config.Look(ViewModel.ChatId, create: true);
        return look;
    }

    /// <summary>The direct chat's agent, or null in a group.</summary>
    private string? DirectAgent() => ViewModel.Chat is { Kind: "direct" } chat && chat.AgentNames.Count > 0 ? chat.AgentNames[0] : null;

    private bool CharacterOn => Look.Character ?? app?.Config.Character ?? true;

    /// <summary>The look of the open chat (or the app's where the chat has none).</summary>
    internal void ApplyLook()
    {
        if (app is null) return;
        var look = Look;
        var size = look.TextSize ?? app.Config.TextSize;
        var pixels = size switch { 0 => 12.5, 2 => 17, _ => 14 };
        var textChanged = Math.Abs(textSize - pixels) > 0.01;
        var promptChanged = showPrompt != app.Config.ShowPrompt;
        textSize = pixels;
        showPrompt = app.Config.ShowPrompt;
        Messages.FontSize = pixels;
        CharacterButton.IsChecked = CharacterOn;
        CharacterButton.Visibility = DirectAgent() is null ? Visibility.Collapsed : Visibility.Visible;
        // How much of the chat shows over the character: none, the newest two, all. The view model
        // really filters the rows (the web's data-bubbles) — never a crop of the list.
        var level = CharacterOn && DirectAgent() is not null ? look.Bubbles ?? 2 : 2;
        ViewModel.BubbleLevel = level;
        Messages.Visibility = Visibility.Visible;
        // A direct chat with its character is the web's .solo screen: the stage is the page.
        ApplySolo(DirectAgent() is not null && CharacterOn);
        PaintChatBrushes();
        if (textChanged || promptChanged) RefreshRows();
        Meter();
        mood = null;
        for (var i = ViewModel.Items.Count - 1; i >= 0 && mood is null; i--)
        {
            if (ViewModel.Items[i] is MessageItem { IsUser: false } message) mood = StageData.LastEmojiKey(message.Text);
        }
        RefreshStage();
    }

    /// <summary>
    /// The web's character screen (.solo, html[data-mode="mobile"] .solo): the stage runs behind a floating
    /// composer and two glass buttons, and the chat is only the newest messages over the character.
    /// </summary>
    private void ApplySolo(bool on)
    {
        if (solo == on) return;
        solo = on;
        ChatHeader.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        SoloBar.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        Grid.SetRowSpan(StageHost, on ? 3 : 1);
        Grid.SetRowSpan(Messages, on ? 3 : 1);
        if (scene is not null) Grid.SetRowSpan(scene, on ? 3 : 1);
        // The character screen floats the status/composer dock over the stage (the web's mobile .solo),
        // so the character fills the window and the messages reserve only the dock's real height.
        Grid.SetRow(BottomDock, on ? 0 : 2);
        Grid.SetRowSpan(BottomDock, on ? 4 : 2);
        BottomDock.VerticalAlignment = on ? VerticalAlignment.Bottom : VerticalAlignment.Stretch;
        Messages.Padding = on ? new Thickness(10, 62, 10, 122) : new Thickness(10, 6, 10, 6);
        UpdateSoloPadding();
        ComposerArea.Padding = on ? new Thickness(10, 0, 10, 12) : new Thickness(10, 4, 10, 8);
        // The web's mobile composer: two glass circles, a glass input pill and send, not one box around all.
        ComposerBox.Background = on ? null : Theme.Brush("Panel");
        ComposerBox.BorderBrush = Theme.Brush("LineStrong");
        ComposerBox.BorderThickness = new Thickness(on ? 0 : 1);
        ComposerBox.Padding = on ? new Thickness(0) : new Thickness(6, 4, 6, 6);
        ComposerBox.CornerRadius = new CornerRadius(on ? 0 : 14);
        Composer.Background = on ? Theme.Brush("SoloInput") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        Composer.CornerRadius = new CornerRadius(on ? 24 : 0);
        Composer.Padding = on ? new Thickness(20, 13, 58, 13) : new Thickness(8, 6, 8, 6);
        Composer.MinHeight = on ? 48 : 0;
        // The send button sits inside the input's right end (web: margin 0 4px 4px -52px).
        if (SendHost.Parent is Grid line) line.ColumnSpacing = on ? 8 : 2;
        Grid.SetColumn(SendHost, on ? 2 : 4);
        SendHost.HorizontalAlignment = on ? HorizontalAlignment.Right : HorizontalAlignment.Stretch;
        SendHost.Margin = on ? new Thickness(0, 0, 4, 4) : new Thickness(0);
        ComposerHint.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        EmojiButton.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        foreach (var button in new Control[] { AttachButton, MicButton })
        {
            button.Width = on ? 48 : double.NaN;
            button.Height = on ? 48 : double.NaN;
            button.CornerRadius = new CornerRadius(on ? 24 : 8);
            button.BorderThickness = new Thickness(on ? 1 : 0);
            button.Background = on ? Theme.Brush("GlassButton") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            button.BorderBrush = on ? Theme.Brush("GlassButtonLine") : null;
        }
        AttachButton.Foreground = Theme.Brush(on ? "GlassInk" : "Muted");
        MicButton.Foreground = Theme.Brush(on ? "GlassInk" : "Ink");
        foreach (var button in new Control[] { SendButton, StopButton })
        {
            button.Width = on ? 40 : double.NaN;
            button.Height = on ? 40 : double.NaN;
            button.CornerRadius = new CornerRadius(on ? 20 : 10);
            button.Padding = on ? new Thickness(0) : new Thickness(9, 7, 9, 7);
        }
        if (stageView is not null) stageView.Solo = on;
        if (stageFade is not null)
        {
            stageFade.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
            if (on) stageFade.Height = StageHost.ActualHeight * 0.62;
        }
        // The web's .solo .log.fade-top fades the bubbles themselves, not a black panel over them.
        QueueBubbleFade();
        PaintChatBrushes();
        // The name row and the brushes in the realised rows: a fresh pass of the item templates.
        RefreshRows();
        app?.ChatSoloChanged(on);
    }

    private void RefreshRows()
    {
        var items = Messages.ItemsSource;
        Messages.ItemsSource = null;
        Messages.ItemsSource = items;
        DispatcherQueue.TryEnqueue(ScrollDown);
        QueueBubbleFade();
    }

    private void HookMessagesScroll()
    {
        if (messagesScroll is not null) return;
        messagesScroll = FindDescendant<ScrollViewer>(Messages);
        if (messagesScroll is null) return;
        messagesScroll.ViewChanged += (_, _) => QueueBubbleFade();
        QueueBubbleFade();
    }

    private static T? FindDescendant<T>(DependencyObject root) where T : DependencyObject
    {
        for (var index = 0; index < VisualTreeHelper.GetChildrenCount(root); index++)
        {
            var child = VisualTreeHelper.GetChild(root, index);
            if (child is T found) return found;
            if (FindDescendant<T>(child) is { } nested) return nested;
        }
        return null;
    }

    /// <summary>The messages stop above the floating composer, not at a fixed guess (web .solo .log).</summary>
    private void UpdateSoloPadding()
    {
        if (!solo) return;
        var height = BottomDock.ActualHeight;
        if (height <= 0) height = 122;
        Messages.Padding = new Thickness(10, 62, 10, Math.Max(72, height + 10));
    }

    private void QueueBubbleFade()
    {
        if (bubbleFadeQueued) return;
        bubbleFadeQueued = true;
        DispatcherQueue.TryEnqueue(() =>
        {
            bubbleFadeQueued = false;
            ApplyBubbleFade();
        });
    }

    /// <summary>
    /// The web's .solo .log.fade-top: with the character on, messages fade away as they reach the top
    /// of the list. The rows themselves become transparent (no black gradient painted over them).
    /// </summary>
    private void ApplyBubbleFade()
    {
        if (Messages.ItemsPanelRoot is not Panel panel) return;
        var fade = solo && messagesScroll is { VerticalOffset: > 8 };
        foreach (var child in panel.Children)
        {
            if (child is not UIElement element) continue;
            if (!fade)
            {
                element.Opacity = 1;
                continue;
            }
            double top;
            try
            {
                top = element.TransformToVisual(Messages).TransformPoint(new Windows.Foundation.Point(0, 0)).Y;
            }
            catch
            {
                element.Opacity = 1;
                continue;
            }
        var height = (element as FrameworkElement)?.ActualHeight ?? 0;
        // mask-image: transparent 0-18% of the log's height, opaque from 46%, linear in between.
        var shown = Messages.ActualHeight;
        var progress = shown <= 0 ? 0 : (top + height / 2) / shown;
        var opacity = Math.Clamp((progress - 0.18) / (0.46 - 0.18), 0, 1);
        // The bottom edge too: rows slide under the floating glass composer, so they dissolve
        // as they reach it instead of being cut off at the screen's edge.
        opacity = Math.Min(opacity, Math.Clamp((1.08 - progress) / 0.11, 0, 1));
        element.Opacity = shown <= 0 ? 1 : opacity;
        }
    }

    /// <summary>Colours shared by every bubble, recoloured in place (so open rows follow without a rebuild).</summary>
    private void PaintChatBrushes()
    {
        Set("MimiChatTxBrush", solo ? "SoloTx" : "Panel");
        Set("MimiChatTxLineBrush", solo ? "SoloTxLine" : "Line");
        Set("MimiChatUserBrush", solo ? "SoloUser" : "User");
        Set("MimiChatUserLineBrush", solo ? "SoloUser" : "UserLine");
        Set("MimiChatInkBrush", "Ink");
        Set("MimiChatUserInkBrush", solo ? "SoloUserInk" : "Ink");
        Set("MimiChatTimeBrush", solo ? "SoloTime" : "Faint");
        Set("MimiChatUserTimeBrush", solo ? "SoloUserTime" : "Faint");
    }

    private static void Set(string key, string color)
    {
        if (Application.Current.Resources[key] is SolidColorBrush brush) brush.Color = Theme.ColorOf(color);
    }

    /// <summary>The web's .solo .stage .fade: transparent at the top, 22% halfway, 60% of the stage colour at the bottom.</summary>
    private static LinearGradientBrush FadeBrush()
    {
        var color = ((SolidColorBrush)Theme.Brush("SoloFade")).Color;
        var brush = new LinearGradientBrush
        {
            StartPoint = new Windows.Foundation.Point(0.5, 0),
            EndPoint = new Windows.Foundation.Point(0.5, 1),
        };
        brush.GradientStops.Add(new GradientStop { Color = Color.FromArgb(0, color.R, color.G, color.B), Offset = 0 });
        brush.GradientStops.Add(new GradientStop { Color = Color.FromArgb((byte)(color.A * 0.22), color.R, color.G, color.B), Offset = 0.5 });
        brush.GradientStops.Add(new GradientStop { Color = Color.FromArgb((byte)(color.A * 0.6), color.R, color.G, color.B), Offset = 1 });
        return brush;
    }

    private void Meter()
    {
        var context = ViewModel.Timeline.Context;
        ContextMeter.Visibility = context is { WindowTokens: > 0 } ? Visibility.Visible : Visibility.Collapsed;
        if (context is { WindowTokens: > 0 }) ContextMeter.Value = Math.Min(100, 100.0 * context.UsedTokens / context.WindowTokens);
        ContextPct.Text = context is { WindowTokens: > 0 } ? $"{Math.Round(ContextMeter.Value)}%" : "";
    }

    private void RefreshStage()
    {
        if (app is null || stage is null || stageView is null) return;
        if (ViewModel.ChatId == 0)
        {
            stageView.Visibility = Visibility.Collapsed;
            scene?.Update(null, null);
            return;
        }
        stageView.Visibility = Visibility.Visible;
        stageView.Update(stage, Look, CharacterOn, DirectAgent(), mood);
        var direct = DirectAgent();
        scene?.Update(direct, direct is not null && stage.Agent(direct) is { } agent ? agent.S("status.situation") : null);
    }

    /// <summary>The newest reply drives the picture (its last emoji) and the 3D character's mouth.</summary>
    private void OnGrew()
    {
        if (ViewModel.Items.Count == 0) return;
        string? text = ViewModel.Items[^1] switch
        {
            LiveItem live => string.Concat(live.Parts.OfType<string>()),
            MessageItem { IsUser: false } message => message.Text,
            _ => null,
        };
        if (text is null) return;
        if (ViewModel.Items[^1] is LiveItem) stageView?.Talk();
        var key = StageData.LastEmojiKey(text);
        if (key is not null && key != mood)
        {
            mood = key;
            RefreshStage();
        }
    }

    private void OnCharacter(object sender, RoutedEventArgs e)
    {
        if (app is null || ViewModel.ChatId == 0) return;
        EditLook().Character = CharacterButton.IsChecked == true;
        app.LookChanged();
    }

    // ---------- the panel: ข้อมูล / หน้าตา ----------

    private void OnRail(object sender, RoutedEventArgs e)
    {
        if (app is null || ViewModel.ChatId == 0) return;
        var body = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch };
        var tab = "status";
        var flyout = new Flyout { Placement = FlyoutPlacementMode.BottomEdgeAlignedRight };
        void Paint()
        {
            // The panel fits the window: two tiles of 140px plus their spacing never overflow the frame.
            var panel = new StackPanel { Spacing = 14, Width = Math.Min(330, Math.Max(272, ActualWidth - 24)) };
            panel.Children.Add(Ui.Seg<string>([("status", "สถานะ / Session"), ("look", "หน้าตา"), ("info", "ข้อมูล / ตั้งค่า")], tab, next =>
            {
                tab = next;
                Paint();
            }, "rail"));
            if (tab == "status") StatusPanel(panel);
            else if (tab == "look") LookPanel(panel, Paint);
            else InfoPanel(panel);
            body.Content = panel;
        }
        Paint();
        railRepaint = Paint;
        // A shell of our own: the flyout presenter's default background is opaque, and the web fades the
        // panel to 16% while a size/position slider is held so the character can be seen.
        var scroll = Ui.Scroll(body, 560);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(scroll, "rail-scroll");
        var shell = new Border { Background = Theme.Brush("Panel"), CornerRadius = new CornerRadius(14), Padding = new Thickness(14), Child = scroll };
        var presenter = new Style(typeof(FlyoutPresenter));
        presenter.Setters.Add(new Setter(Control.BackgroundProperty, new SolidColorBrush(Microsoft.UI.Colors.Transparent)));
        presenter.Setters.Add(new Setter(Control.PaddingProperty, new Thickness(0)));
        presenter.Setters.Add(new Setter(Control.BorderThicknessProperty, new Thickness(0)));
        flyout.FlyoutPresenterStyle = presenter;
        flyout.Content = shell;
        railPeek = peek => shell.Opacity = peek ? 0.16 : 1;
        // A new uploaded background arrives after the panel is open: redraw its thumbnails.
        // An agent's status can change any moment too: the status tab refreshes its boxes in
        // place (a full repaint would drop the box the person is editing right now).
        void StageChanged() => DispatcherQueue.TryEnqueue(() =>
        {
            if (tab == "status" && statusBoxes.Count > 0) SyncStatusBoxes();
            else Paint();
        });
        if (stage is not null) stage.Changed += StageChanged;
        // The model finished loading (or could not): the position sliders are the camera's now, or the picture's again.
        void ThreeDChanged() => DispatcherQueue.TryEnqueue(() => { if (tab == "look") Paint(); });
        if (stageView is not null) stageView.ThreeDChanged += ThreeDChanged;
        flyout.Closed += (_, _) =>
        {
            railPeek = null;
            railRepaint = null;
            if (stage is not null) stage.Changed -= StageChanged;
            if (stageView is not null) stageView.ThreeDChanged -= ThreeDChanged;
        };
        // The header's button, or the glass one on the character screen.
        flyout.ShowAt(sender as FrameworkElement ?? RailButton);
    }

    private void OnSoloBack(object sender, RoutedEventArgs e) => App.Instance?.ShowChats();

    /// <summary>The web's status tab: search, sessions, context/token, and the agent's live status.</summary>
    private void StatusPanel(StackPanel panel)
    {
        var chat = ViewModel.Chat;
        if (chat is null) return;
        panel.Children.Add(Ui.Row(6,
            Ui.Button("ค้นหาในแชต", () => App.Instance?.ShowSearch(), "ghost", "rail-search"),
            Ui.Button(Loc.T("+ session ใหม่"), () => ViewModel.NewSession(), "ghost", "rail-new-session")));

        panel.Children.Add(Ui.Section("Session"));
        var choices = ViewModel.SessionChoices;
        if (choices.Count == 0) panel.Children.Add(Ui.Hint("ยังไม่มี session — ส่งข้อความแรกแล้วระบบจะเริ่มให้"));
        else
        {
            var sessions = new StackPanel { Spacing = 3 };
            foreach (var (id, label, current) in choices.Take(50))
            {
                var row = new Button
                {
                    Content = label,
                    HorizontalAlignment = HorizontalAlignment.Stretch,
                    HorizontalContentAlignment = HorizontalAlignment.Left,
                    FontSize = 12,
                    Padding = new Thickness(8, 4, 8, 4),
                    BorderThickness = new Thickness(0),
                    Background = current ? Theme.Brush("AccentSoft") : new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                    Tag = id,
                };
                row.Click += (_, _) => ViewModel.OpenSession((long)row.Tag);
                sessions.Children.Add(row);
            }
            panel.Children.Add(sessions);
        }

        panel.Children.Add(Ui.Section("Context / token"));
        var context = ViewModel.Timeline.Context;
        if (context is { WindowTokens: > 0 })
        {
            var meter = new ProgressBar { Maximum = 100, Value = Math.Min(100, 100.0 * context.UsedTokens / context.WindowTokens), Height = 5, MinHeight = 5 };
            panel.Children.Add(meter);
            panel.Children.Add(Ui.Mono(ViewModel.ContextLabel));
            var detail = new StackPanel { Spacing = 2 };
            detail.Children.Add(Ui.Hint($"ใช้ {context.UsedTokens:N0} / {context.WindowTokens:N0} token"));
            if (context.CacheHitPct is { } cache) detail.Children.Add(Ui.Hint($"cache hit {cache:0.#}%"));
            detail.Children.Add(Ui.Hint($"ค่าใช้จ่าย session นี้ ${context.CostUsd:0.####}"));
            if (context.MaxTokens > 0) detail.Children.Add(Ui.Hint($"บทสนทนา {context.ConversationTokens:N0} / {context.MaxTokens:N0} token"));
            panel.Children.Add(detail);
        }
        else panel.Children.Add(Ui.Hint("ยังไม่มีข้อมูล context ของ session นี้"));

        if (DirectAgent() is not { } name || stage?.Agent(name) is not { } agent) return;
        panel.Children.Add(Ui.Section("สถานะตอนนี้"));
        var grid = new Grid { ColumnSpacing = 10, RowSpacing = 6 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var rowIndex = 0;
        statusBoxes.Clear();
        foreach (var (key, label) in StatusKeys)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var caption = Ui.Hint(Loc.T(label));
            caption.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetRow(caption, rowIndex);
            grid.Children.Add(caption);
            var value = agent.S($"status.{key}");
            var box = new TextBox { Text = value, PlaceholderText = "ยังไม่ระบุ", FontSize = 13 };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, label);
            box.LostFocus += (_, _) =>
            {
                if (box.Text != value)
                {
                    app!.Session.Send(ClientFrames.Json("status-set", new JsonObject { ["agent"] = name, ["key"] = key, ["value"] = box.Text.Trim() }));
                    // The answer comes back as a broadcast: repaint so every part (boxes, the
                    // situation button) shows the fresh state once this box is not focused.
                    DispatcherQueue.TryEnqueue(() => railRepaint?.Invoke());
                }
            };
            Grid.SetRow(box, rowIndex);
            Grid.SetColumn(box, 1);
            grid.Children.Add(box);
            statusBoxes[key] = box;
            rowIndex++;
        }
        panel.Children.Add(grid);
        panel.Children.Add(Ui.Hint("แก้ได้ (ปกติ agent อัปเดตเองระหว่างคุย)"));
        if (agent.S("status.situation").Length > 0)
        {
            panel.Children.Add(Ui.Button("เอาภาพสถานการณ์ออกจากแชต", () =>
                app!.Session.Send(ClientFrames.Json("status-set", new JsonObject { ["agent"] = name, ["key"] = "situation", ["value"] = "" })), "ghost"));
        }
    }

    /// <summary>The agent's status changed while the panel is open: refresh the boxes in place,
    /// leaving the one being edited alone (app.js renders the rail again on every 'status' frame).</summary>
    private void SyncStatusBoxes()
    {
        if (DirectAgent() is not { } name || stage?.Agent(name) is not { } agent) return;
        foreach (var (key, box) in statusBoxes)
        {
            if (box.FocusState != FocusState.Unfocused) continue;
            box.Text = agent.S($"status.{key}");
        }
    }

    /// <summary>The web's info tab: who the chat is with, the prompt switch, CSV and delete — all centred.</summary>
    private void InfoPanel(StackPanel panel)
    {
        var chat = ViewModel.Chat;
        if (chat is null) return;
        var title = Ui.Title(app!.Session.ChatTitle(chat));
        title.TextAlignment = TextAlignment.Center;
        title.HorizontalAlignment = HorizontalAlignment.Stretch;
        panel.Children.Add(title);
        var kind = Ui.Hint(chat.Kind == "direct" ? "แชตตัวต่อตัว" : $"แชตกลุ่ม · สมาชิก {string.Join(", ", (chat.Agents ?? []).Select(app.Session.AgentName))}");
        kind.TextAlignment = TextAlignment.Center;
        kind.HorizontalAlignment = HorizontalAlignment.Stretch;
        panel.Children.Add(kind);
        if (DirectAgent() is { } name && stage?.Agent(name) is { } agent)
        {
            // The web's who-card: the face, the name and the description centred, the edit button under them.
            var card = new StackPanel { Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center };
            var avatar = new Avatar { Path = AvatarPath(name, agent), Initial = app.Session.AgentName(name) is { Length: > 0 } shown ? shown[..1].ToUpperInvariant() : "?", Size = 56, HorizontalAlignment = HorizontalAlignment.Center };
            var shownName = new TextBlock { Text = app.Session.AgentName(name), FontSize = 15, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Theme.Brush("Ink"), TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap };
            card.Children.Add(avatar);
            card.Children.Add(shownName);
            if (agent.S("description").Length > 0)
            {
                card.Children.Add(new TextBlock { Text = agent.S("description"), FontSize = 12.5, Foreground = Theme.Brush("Muted"), TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap });
            }
            var edit = Ui.Button("แก้ไข agent", () => App.Instance?.ShowManage(Page.Agents), "ghost", "rail-edit-agent");
            edit.HorizontalAlignment = HorizontalAlignment.Center;
            card.Children.Add(edit);
            panel.Children.Add(card);
        }
        else if (chat.Kind == "group")
        {
            var members = Ui.Section("สมาชิก");
            members.TextAlignment = TextAlignment.Center;
            members.HorizontalAlignment = HorizontalAlignment.Stretch;
            panel.Children.Add(members);
            foreach (var member in chat.AgentNames)
            {
                var info = stage?.Agent(member) is { } entry ? entry : default;
                var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center };
                row.Children.Add(new Avatar { Path = info.ValueKind == JsonValueKind.Object ? AvatarPath(member, info) : null, Initial = app.Session.AgentName(member) is { Length: > 0 } shown ? shown[..1].ToUpperInvariant() : "?", Size = 28 });
                row.Children.Add(new TextBlock { Text = app.Session.AgentName(member), FontSize = 13, VerticalAlignment = VerticalAlignment.Center, Foreground = Theme.Brush("Ink2") });
                panel.Children.Add(row);
            }
            var editGroup = Ui.Button("แก้ไขกลุ่ม", () => _ = EditChat(), "ghost");
            editGroup.HorizontalAlignment = HorizontalAlignment.Center;
            panel.Children.Add(editGroup);
        }

        var display = Ui.Section("การแสดงผล");
        display.TextAlignment = TextAlignment.Center;
        display.HorizontalAlignment = HorizontalAlignment.Stretch;
        panel.Children.Add(display);
        var prompt = new ToggleSwitch { Header = "แสดง prompt / เครื่องมือ", IsOn = app.Config.ShowPrompt, OnContent = "เปิด", OffContent = "ปิด", HorizontalAlignment = HorizontalAlignment.Center };
        prompt.Toggled += (_, _) =>
        {
            app.Config.ShowPrompt = prompt.IsOn;
            app.SaveConfig(later: true);
            showPrompt = prompt.IsOn;
            RefreshRows();
        };
        panel.Children.Add(prompt);
        var promptHint = Ui.Hint("ปิดเพื่อซ่อนบรรทัดเครื่องมือและ helper ในแชต");
        promptHint.TextAlignment = TextAlignment.Center;
        promptHint.HorizontalAlignment = HorizontalAlignment.Stretch;
        panel.Children.Add(promptHint);
        var csv = Ui.Button("ดาวน์โหลดแชตเป็น CSV", () => _ = App.Instance?.Download($"/api/export/chat/{ViewModel.ChatId}.csv", $"mimi-chat-{ViewModel.ChatId}.csv"), "ghost");
        csv.HorizontalAlignment = HorizontalAlignment.Center;
        panel.Children.Add(csv);
        var delete = Ui.Button("ลบแชต", () => _ = DeleteChat(), "ghost");
        delete.HorizontalAlignment = HorizontalAlignment.Center;
        panel.Children.Add(delete);
    }

    private string? AvatarPath(string name, JsonElement agent) =>
        agent.S("avatar") is { Length: > 0 } stamp ? Mimi.Core.Net.MimiApi.AgentImagePath(name, "avatar", stamp) : null;

    private void LookPanel(StackPanel panel, Action repaint)
    {
        var look = Look;
        void Changed()
        {
            app!.LookChanged();
            repaint();
        }
        panel.Children.Add(Ui.Hint("หน้าตาของแชตนี้ถูกจำแยกจากแชตอื่น — ค่าที่ไม่ได้ตั้งเองจะใช้ค่าเดิมของแอป"));
        panel.Children.Add(Ui.Section("ขนาดข้อความ"));
        panel.Children.Add(Ui.Seg<int>([(0, "เล็ก"), (1, "ปกติ"), (2, "ใหญ่")], look.TextSize ?? app!.Config.TextSize, size =>
        {
            EditLook().TextSize = size;
            Changed();
        }, "chat-size"));
        panel.Children.Add(Ui.Section("ธีมของแชตนี้"));
        panel.Children.Add(Ui.Seg<string>([("", "ตามแอป"), ("light", "สว่าง"), ("dark", "มืด")], look.Theme ?? "", theme =>
        {
            EditLook().Theme = theme.Length == 0 ? null : theme;
            Changed();
        }, "chat-theme"));
        if (DirectAgent() is not null)
        {
            panel.Children.Add(Ui.Section(Loc.T("ตัวละคร")));
            panel.Children.Add(Ui.Seg<bool>([(true, "แสดง"), (false, "ซ่อน")], CharacterOn, on =>
            {
                EditLook().Character = on;
                Changed();
            }, "chat-character"));
            if (CharacterOn)
            {
                panel.Children.Add(Ui.Section("แชตบนตัวละคร"));
                panel.Children.Add(Ui.Seg<int>([(0, "ไม่แสดง"), (1, "2 ข้อความล่าสุด"), (2, Loc.T("ทั้งหมด"))], look.Bubbles ?? 2, level =>
                {
                    EditLook().Bubbles = level;
                    Changed();
                }, "chat-bubbles"));
                // The web's ranges: size/zoom 0.1–10× and slide ±300%; the 3D camera also turns ±180° and tilts ±89°.
                if (stageView?.ThreeD == true)
                {
                    panel.Children.Add(Ui.Section(Loc.T("ตำแหน่งตัวละคร (3D)")));
                    panel.Children.Add(Slider(Loc.T("หมุน"), look.CameraYaw, -180, 180, value => EditLook().CameraYaw = value, "chat-yaw", "°"));
                    panel.Children.Add(Slider(Loc.T("ก้ม / เงย"), look.CameraPitch, -89, 89, value => EditLook().CameraPitch = value, "chat-pitch", "°"));
                    panel.Children.Add(Slider(Loc.T("ซูม"), look.CameraZoom * 100, 10, 1000, value => EditLook().CameraZoom = value / 100, "chat-zoom", "×"));
                    panel.Children.Add(Slider(Loc.T("ซ้าย - ขวา"), look.CameraX, -300, 300, value => EditLook().CameraX = value, "chat-x"));
                    panel.Children.Add(Slider(Loc.T("ลง - ขึ้น"), look.CameraY, -300, 300, value => EditLook().CameraY = value, "chat-y"));
                    panel.Children.Add(Ui.Button(Loc.T("รีเซ็ตตำแหน่ง"), () =>
                    {
                        var edited = EditLook();
                        edited.CameraYaw = 0;
                        edited.CameraPitch = 0;
                        edited.CameraZoom = 1;
                        edited.CameraX = 0;
                        edited.CameraY = 0;
                        Changed();
                    }, "ghost", "chat-view-reset"));
                }
                else
                {
                    panel.Children.Add(Ui.Section(Loc.T("ตำแหน่งตัวละคร (2D)")));
                    panel.Children.Add(Slider(Loc.T("ขยาย"), look.Zoom * 100, 10, 1000, value => EditLook().Zoom = value / 100, "chat-zoom", "×"));
                    panel.Children.Add(Slider(Loc.T("ซ้าย - ขวา"), look.X, -300, 300, value => EditLook().X = value, "chat-x"));
                    panel.Children.Add(Slider(Loc.T("ลง - ขึ้น"), look.Y, -300, 300, value => EditLook().Y = value, "chat-y"));
                    panel.Children.Add(Ui.Button(Loc.T("รีเซ็ตตำแหน่ง"), () =>
                    {
                        var edited = EditLook();
                        edited.Zoom = 1;
                        edited.X = 0;
                        edited.Y = 0;
                        Changed();
                    }, "ghost", "chat-view-reset"));
                }
            }
        }
        BackgroundPanel(panel, Changed);
        if (!look.IsEmpty)
        {
            panel.Children.Add(Ui.Button("ใช้ค่าเดิมของแอป (ล้างค่าของแชตนี้)", () =>
            {
                app!.Config.ForgetLook(ViewModel.ChatId);
                Changed();
            }, "ghost"));
        }
    }

    private Slider Slider(string label, double value, double min, double max, Action<double> set, string? id = null, string unit = "%")
    {
        var shown = new TextBlock { Text = Show(value, unit), FontSize = 11, Foreground = Theme.Brush("Muted"), HorizontalAlignment = HorizontalAlignment.Right };
        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.Children.Add(new TextBlock { Text = label, FontSize = 12, Foreground = Theme.Brush("Ink2") });
        Grid.SetColumn(shown, 1);
        header.Children.Add(shown);
        var slider = new Slider { Header = header, Minimum = min, Maximum = max, Value = value, StepFrequency = 1 };
        if (id is not null) Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(slider, id);
        slider.ValueChanged += (_, args) =>
        {
            shown.Text = Show(args.NewValue, unit);
            set(args.NewValue);
            app!.SaveConfig(later: true);
            RefreshStage();
        };
        // While a slider is held the panel fades, as the web's rail.peek does.
        void Peek(bool on) => railPeek?.Invoke(on);
        slider.AddHandler(UIElement.PointerPressedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => Peek(true)), true);
        slider.AddHandler(UIElement.PointerReleasedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => Peek(false)), true);
        slider.AddHandler(UIElement.PointerCanceledEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => Peek(false)), true);
        slider.AddHandler(UIElement.PointerCaptureLostEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => Peek(false)), true);
        return slider;
    }

    private static string Show(double value, string unit) => unit switch
    {
        "×" => $"{value / 100:0.00}×",
        "°" => $"{Math.Round(value)}°",
        _ => $"{Math.Round(value)}%",
    };

    /// <summary>The chat's own background, created on first use, set to <paramref name="kind"/>.</summary>
    private JsonObject EditBackground(string kind)
    {
        var edited = EditLook();
        edited.Background ??= new JsonObject { ["color"] = "#1b1d22", ["from"] = "#1b1d22", ["to"] = "#3a2d28", ["angle"] = 135, ["preset"] = "floral" };
        edited.Background["type"] = kind;
        return edited.Background;
    }

    /// <summary>The chat's own background (feature-backgrounds.js chatPanel): a preview, then none, a colour, a gradient, a preset scene or an uploaded one.</summary>
    private void BackgroundPanel(StackPanel panel, Action changed)
    {
        var look = Look;
        var current = look.Background?.Str("type") is { Length: > 0 } type ? type : "default";
        panel.Children.Add(Ui.Section("ฉากหลังของแชตนี้"));
        panel.Children.Add(Ui.Hint("เลือกพื้นหลังของแชตนี้ — รูปที่อัปโหลดและสีจะแสดงด้านหลังตัวละคร"));
        panel.Children.Add(BackgroundPreview(look.Background, current));
        var kinds = new List<(string, string)> { ("default", "ตามแอป"), ("none", "ไม่ใช้"), ("solid", "สีเดียว"), ("gradient", "ไล่สี"), ("preset", "รูปในแอป"), ("upload", "อัปโหลด") };
        // Thai labels never fit three to a row of a 330 px panel: two per row (the web's .seg.bgtabs) keeps every choice readable.
        panel.Children.Add(Ui.Seg<string>(kinds, current, kind =>
        {
            if (kind == "default")
            {
                EditLook().Background = null;
            }
            else
            {
                var background = EditBackground(kind);
                if (kind == "preset" && background.Str("preset").Length == 0) background["preset"] = "floral";
                if (kind == "upload" && background.Str("upload").Length == 0 && stage!.Scenes.FirstOrDefault(scene => scene.S("image").Length > 0) is { ValueKind: System.Text.Json.JsonValueKind.Object } first)
                {
                    background["upload"] = first.S("id");
                }
            }
            changed();
        }, "chat-bg", columns: 2));
        var background = look.Background;
        if (background is null) return;
        BackgroundKind(panel, current, background, changed);
        // The time spans come after the main choice, whatever it is (feature-backgrounds.js scheduleBox).
        RulesPanel(panel, changed);
    }

    private FrameworkElement BackgroundPreview(JsonObject? background, string current)
    {
        // 16:9 at whatever width the panel has (the web's aspect-ratio), framed like the other cards.
        var preview = new Border
        {
            Height = 160,
            CornerRadius = new CornerRadius(12),
            BorderBrush = Theme.Brush("Line"),
            BorderThickness = new Thickness(1),
            Background = Theme.Brush("Raised"),
        };
        preview.SizeChanged += (_, size) =>
        {
            var height = Math.Round(size.NewSize.Width * 9 / 16);
            if (height > 0 && Math.Abs(preview.Height - height) > 0.5) preview.Height = height;
        };
        var caption = new TextBlock
        {
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            FontSize = 12,
            Foreground = Theme.Brush("Muted"),
            TextWrapping = TextWrapping.Wrap,
            TextAlignment = TextAlignment.Center,
            Margin = new Thickness(12),
        };
        preview.Child = caption;
        if (background is null || current == "default")
        {
            caption.Text = "ตามแอป (ยังไม่มีฉากหลังของแชตนี้)";
            return preview;
        }
        switch (current)
        {
            case "none":
                caption.Text = "ไม่มีฉากหลัง";
                break;
            case "solid":
                preview.Background = new SolidColorBrush(Theme.Parse(background.Str("color")) ?? Microsoft.UI.Colors.Black);
                caption.Text = "";
                break;
            case "gradient":
                preview.Background = Gradient(background);
                caption.Text = "";
                break;
            case "preset":
                var preset = background.Str("preset");
                if (File.Exists(StageData.PresetFile(preset)))
                {
                    preview.Background = new ImageBrush { ImageSource = new BitmapImage(new Uri(StageData.PresetFile(preset))), Stretch = Stretch.UniformToFill };
                    caption.Text = "";
                }
                else caption.Text = "ยังไม่มีรูปฉากนี้";
                break;
            case "upload":
                var scene = stage?.Scenes.FirstOrDefault(item => item.S("id") == background.Str("upload") && item.S("image").Length > 0);
                if (scene is { ValueKind: JsonValueKind.Object } chosen)
                {
                    _ = SetPreviewImage(preview, $"/api/background-image/{Uri.EscapeDataString(chosen.S("id"))}?v={Uri.EscapeDataString(chosen.S("image"))}");
                    caption.Text = "";
                }
                else caption.Text = "ยังไม่มีรูปที่อัปโหลด";
                break;
        }
        return preview;
    }

    private async Task SetPreviewImage(Border preview, string path)
    {
        var bitmap = await (app?.Images.Get(path) ?? Task.FromResult<BitmapImage?>(null));
        if (bitmap is not null) preview.Background = new ImageBrush { ImageSource = bitmap, Stretch = Stretch.UniformToFill };
    }

    private static LinearGradientBrush Gradient(JsonObject background)
    {
        var from = Theme.Parse(background.Str("from")) ?? Microsoft.UI.Colors.Black;
        var to = Theme.Parse(background.Str("to")) ?? Microsoft.UI.Colors.Black;
        var angle = background["angle"] is JsonValue value && value.TryGetValue<double>(out var degrees) ? degrees : 135;
        var radians = (angle - 90) * Math.PI / 180;
        return new LinearGradientBrush
        {
            StartPoint = new Windows.Foundation.Point(0.5 - Math.Cos(radians) / 2, 0.5 - Math.Sin(radians) / 2),
            EndPoint = new Windows.Foundation.Point(0.5 + Math.Cos(radians) / 2, 0.5 + Math.Sin(radians) / 2),
            GradientStops =
            {
                new GradientStop { Color = from, Offset = 0 },
                new GradientStop { Color = to, Offset = 1 },
            },
        };
    }

    private void BackgroundKind(StackPanel panel, string current, JsonObject background, Action changed)
    {
        switch (current)
        {
            case "solid":
                panel.Children.Add(Ui.Field("สีพื้นหลัง", Swatch(background.Str("color"), value =>
                {
                    EditBackground("solid")["color"] = value;
                    changed();
                })));
                break;
            case "gradient":
                GradientEditor(panel, background, changed);
                break;
            case "preset":
                PresetGrid(panel, background, changed);
                break;
            case "upload":
                UploadGrid(panel, background, changed);
                break;
        }
    }

    /// <summary>The web's three-column row: start colour, end colour, angle (.bgedit.grid3).</summary>
    private void GradientEditor(StackPanel panel, JsonObject background, Action changed)
    {
        var angle = background["angle"] is JsonValue value && value.TryGetValue<double>(out var degrees) ? degrees : 135;
        var box = new NumberBox
        {
            Value = Math.Clamp(angle, 0, 360),
            Minimum = 0,
            Maximum = 360,
            SmallChange = 5,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Hidden,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            MinWidth = 0,
        };
        box.ValueChanged += (_, args) =>
        {
            if (double.IsNaN(args.NewValue) || Math.Abs(args.NewValue - args.OldValue) < 0.01) return;
            EditBackground("gradient")["angle"] = Math.Round(Math.Clamp(args.NewValue, 0, 360));
            changed();
        };
        var row = new Grid { ColumnSpacing = 8 };
        for (var column = 0; column < 3; column++) row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var from = Ui.Field("สีเริ่ม", Swatch(background.Str("from"), color =>
        {
            EditBackground("gradient")["from"] = color;
            changed();
        }));
        var to = Ui.Field("สีจบ", Swatch(background.Str("to"), color =>
        {
            EditBackground("gradient")["to"] = color;
            changed();
        }));
        var degreesField = Ui.Field("องศา", box);
        Grid.SetColumn(to, 1);
        Grid.SetColumn(degreesField, 2);
        row.Children.Add(from);
        row.Children.Add(to);
        row.Children.Add(degreesField);
        panel.Children.Add(row);
    }

    /// <summary>
    /// A colour as a full-width swatch with its hex (the web's input[type=color], 32 px high); a click opens the picker
    /// in a flyout instead of leaving a ring wheel bigger than the panel in the middle of it.
    /// </summary>
    private static FrameworkElement Swatch(string value, Action<string> set)
    {
        var color = Theme.Parse(value) ?? Microsoft.UI.Colors.Black;
        var hex = new TextBlock { FontFamily = new Microsoft.UI.Xaml.Media.FontFamily("Cascadia Mono, Consolas"), FontSize = 11, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var fill = new SolidColorBrush(color);
        void Show(Windows.UI.Color shown)
        {
            fill.Color = shown;
            hex.Text = $"#{shown.R:x2}{shown.G:x2}{shown.B:x2}";
            // Black text on a light swatch, white on a dark one.
            hex.Foreground = new SolidColorBrush((0.299 * shown.R + 0.587 * shown.G + 0.114 * shown.B) > 150 ? Microsoft.UI.Colors.Black : Microsoft.UI.Colors.White);
        }
        Show(color);
        var picker = new ColorPicker
        {
            Color = color,
            IsAlphaEnabled = false,
            IsMoreButtonVisible = false,
            ColorSpectrumShape = ColorSpectrumShape.Box,
            IsColorSliderVisible = true,
            IsColorChannelTextInputVisible = false,
            IsHexInputVisible = true,
        };
        picker.ColorChanged += (_, args) =>
        {
            Show(args.NewColor);
            set($"#{args.NewColor.R:x2}{args.NewColor.G:x2}{args.NewColor.B:x2}");
        };
        var button = new Button
        {
            Content = hex,
            Background = fill,
            BorderBrush = Theme.Brush("Line"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Height = 32,
            Padding = new Thickness(4, 0, 4, 0),
            Flyout = new Flyout { Content = picker },
        };
        return button;
    }

    /// <summary>The web's two-column grid (.bgpresets): every tile the same width, a 16:9 picture over its name.</summary>
    private static Grid TileGrid(IReadOnlyList<FrameworkElement> tiles)
    {
        var grid = new Grid { ColumnSpacing = 6, RowSpacing = 6 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (var index = 0; index < tiles.Count; index++)
        {
            if (index % 2 == 0) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            Grid.SetRow(tiles[index], index / 2);
            Grid.SetColumn(tiles[index], index % 2);
            grid.Children.Add(tiles[index]);
        }
        return grid;
    }

    /// <summary>One picture tile: the picture at 16:9 across the tile's width, its name under it, the chosen one outlined.</summary>
    private static Button PictureTile(Image image, string label, bool chosen, Action pick)
    {
        var frame = new Border { CornerRadius = new CornerRadius(7), Child = image, Background = Theme.Brush("Bg"), Height = 64 };
        frame.SizeChanged += (_, size) =>
        {
            var height = Math.Round(size.NewSize.Width * 9 / 16);
            if (height > 0 && Math.Abs(frame.Height - height) > 0.5) frame.Height = height;
        };
        image.Stretch = Stretch.UniformToFill;
        var body = new StackPanel { Spacing = 4 };
        body.Children.Add(frame);
        body.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 11.5,
            HorizontalAlignment = HorizontalAlignment.Center,
            Foreground = Theme.Brush("Ink2"),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        var tile = new Button
        {
            Content = body,
            Padding = new Thickness(4),
            CornerRadius = new CornerRadius(10),
            BorderThickness = new Thickness(chosen ? 2 : 1),
            BorderBrush = chosen ? Theme.Brush("Accent") : Theme.Brush("Line"),
            Background = Theme.Brush("Panel"),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
        };
        tile.Click += (_, _) => pick();
        return tile;
    }

    private void PresetGrid(StackPanel panel, JsonObject background, Action changed)
    {
        var current = background.Str("preset");
        var tiles = new List<FrameworkElement>();
        foreach (var (id, label) in StageData.Presets)
        {
            var image = new Image();
            if (File.Exists(StageData.PresetFile(id))) image.Source = new BitmapImage(new Uri(StageData.PresetFile(id)));
            var preset = id;
            tiles.Add(PictureTile(image, label, current == id, () =>
            {
                EditBackground("preset")["preset"] = preset;
                changed();
            }));
        }
        panel.Children.Add(TileGrid(tiles));
    }

    private void UploadGrid(StackPanel panel, JsonObject background, Action changed)
    {
        var current = background.Str("upload");
        var scenes = stage?.Scenes.Where(scene => scene.S("image").Length > 0).ToList() ?? [];
        panel.Children.Add(Ui.Button("อัปโหลดรูปจากเครื่อง…", () => _ = UploadBackground(changed), id: "chat-bg-upload"));
        panel.Children.Add(Ui.Hint("PNG, JPEG, WebP หรือ GIF ไม่เกิน 12 MB"));
        if (scenes.Count == 0)
        {
            panel.Children.Add(Ui.Hint("ยังไม่มีรูปที่อัปโหลดในแชตนี้"));
            return;
        }
        var tiles = new List<FrameworkElement>();
        foreach (var scene in scenes)
        {
            var id = scene.S("id");
            var image = new Image();
            _ = LoadBackgroundImage(image, $"/api/background-image/{Uri.EscapeDataString(id)}?v={Uri.EscapeDataString(scene.S("image"))}");
            tiles.Add(PictureTile(image, scene.S("name") is { Length: > 0 } shown ? shown : id, current == id, () =>
            {
                EditBackground("upload")["upload"] = id;
                changed();
            }));
        }
        panel.Children.Add(TileGrid(tiles));
    }

    private async Task LoadBackgroundImage(Image image, string path)
    {
        var bitmap = await (app?.Images.Get(path) ?? Task.FromResult<BitmapImage?>(null));
        if (bitmap is not null) image.Source = bitmap;
    }
}
