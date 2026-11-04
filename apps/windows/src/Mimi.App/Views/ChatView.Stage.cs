using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core.Desktop;
using Mimi.Core.Hub;
using Mimi.Core.Protocol;
using Mimi.Core.ViewModels;

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
    private ScrollViewer? messagesScroll;
    private bool bubbleFadeQueued;

    private static readonly (string Key, string Label)[] StatusKeys = [("location", "ที่อยู่"), ("outfit", "ชุด"), ("current_task", "กำลังทำ"), ("mood", "อารมณ์")];

    internal void Attach(App owner, StageData data, string cache)
    {
        app = owner;
        stage = data;
        stageView = new StageView(owner.Images, () => owner.Session.Api, cache);
        StageHost.Children.Add(stageView);
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
        // How much of the chat shows over the character: none, the newest two (the bottom of the stage), all.
        var level = CharacterOn && DirectAgent() is not null ? look.Bubbles ?? 2 : 2;
        Messages.Visibility = level == 0 ? Visibility.Collapsed : Visibility.Visible;
        Messages.VerticalAlignment = level == 1 ? VerticalAlignment.Bottom : VerticalAlignment.Stretch;
        Messages.MaxHeight = level == 1 ? 260 : double.PositiveInfinity;
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
            element.Opacity = shown <= 0 ? 1 : Math.Clamp(((top + height / 2) / shown - 0.18) / (0.46 - 0.18), 0, 1);
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
            var panel = new StackPanel { Spacing = 14, Width = 330 };
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
        void StageChanged() => DispatcherQueue.TryEnqueue(Paint);
        if (stage is not null) stage.Changed += StageChanged;
        flyout.Closed += (_, _) =>
        {
            railPeek = null;
            if (stage is not null) stage.Changed -= StageChanged;
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
            Ui.Button("+ session ใหม่", () => ViewModel.NewSession(), "ghost", "rail-new-session")));

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
        foreach (var (key, label) in StatusKeys)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var caption = Ui.Hint(label);
            caption.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetRow(caption, rowIndex);
            grid.Children.Add(caption);
            var value = agent.S($"status.{key}");
            var box = new TextBox { Text = value, PlaceholderText = "ยังไม่ระบุ", FontSize = 13 };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, label);
            box.LostFocus += (_, _) =>
            {
                if (box.Text != value) app!.Session.Send(ClientFrames.Json("status-set", new JsonObject { ["agent"] = name, ["key"] = key, ["value"] = box.Text.Trim() }));
            };
            Grid.SetRow(box, rowIndex);
            Grid.SetColumn(box, 1);
            grid.Children.Add(box);
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

    /// <summary>The web's info tab: who the chat is with, the prompt switch, CSV and delete.</summary>
    private void InfoPanel(StackPanel panel)
    {
        var chat = ViewModel.Chat;
        if (chat is null) return;
        panel.Children.Add(Ui.Title(app!.Session.ChatTitle(chat)));
        panel.Children.Add(Ui.Hint(chat.Kind == "direct" ? "แชตตัวต่อตัว" : $"แชตกลุ่ม · สมาชิก {string.Join(", ", (chat.Agents ?? []).Select(app.Session.AgentName))}"));
        if (DirectAgent() is { } name && stage?.Agent(name) is { } agent)
        {
            var card = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
            card.Children.Add(new Avatar { Path = AvatarPath(name, agent), Initial = app.Session.AgentName(name) is { Length: > 0 } shown ? shown[..1].ToUpperInvariant() : "?", Size = 56 });
            var info = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
            info.Children.Add(new TextBlock { Text = app.Session.AgentName(name), FontSize = 15, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Theme.Brush("Ink") });
            if (agent.S("description").Length > 0) info.Children.Add(Ui.Hint(agent.S("description")));
            card.Children.Add(info);
            panel.Children.Add(card);
            panel.Children.Add(Ui.Button("แก้ไข agent", () => App.Instance?.ShowManage(Page.Agents), "ghost", "rail-edit-agent"));
        }
        else if (chat.Kind == "group")
        {
            panel.Children.Add(Ui.Section("สมาชิก"));
            foreach (var member in chat.AgentNames)
            {
                var info = stage?.Agent(member) is { } entry ? entry : default;
                var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                row.Children.Add(new Avatar { Path = info.ValueKind == JsonValueKind.Object ? AvatarPath(member, info) : null, Initial = app.Session.AgentName(member) is { Length: > 0 } shown ? shown[..1].ToUpperInvariant() : "?", Size = 28 });
                row.Children.Add(new TextBlock { Text = app.Session.AgentName(member), FontSize = 13, VerticalAlignment = VerticalAlignment.Center, Foreground = Theme.Brush("Ink2") });
                panel.Children.Add(row);
            }
            panel.Children.Add(Ui.Button("แก้ไขกลุ่ม", () => _ = EditChat(), "ghost"));
        }

        panel.Children.Add(Ui.Section("การแสดงผล"));
        var prompt = new ToggleSwitch { Header = "แสดง prompt / เครื่องมือ", IsOn = app.Config.ShowPrompt, OnContent = "เปิด", OffContent = "ปิด" };
        prompt.Toggled += (_, _) =>
        {
            app.Config.ShowPrompt = prompt.IsOn;
            app.SaveConfig(later: true);
            showPrompt = prompt.IsOn;
            RefreshRows();
        };
        panel.Children.Add(prompt);
        panel.Children.Add(Ui.Hint("ปิดเพื่อซ่อนบรรทัดเครื่องมือและ helper ในแชต"));
        panel.Children.Add(Ui.Button("ดาวน์โหลดแชตเป็น CSV", () => _ = App.Instance?.Download($"/api/export/chat/{ViewModel.ChatId}.csv", $"mimi-chat-{ViewModel.ChatId}.csv"), "ghost"));
        panel.Children.Add(Ui.Button("ลบแชต", () => _ = DeleteChat(), "ghost"));
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
            panel.Children.Add(Ui.Section("ตัวละคร"));
            panel.Children.Add(Ui.Seg<bool>([(true, "แสดง"), (false, "ซ่อน")], CharacterOn, on =>
            {
                EditLook().Character = on;
                Changed();
            }, "chat-character"));
            if (CharacterOn)
            {
                panel.Children.Add(Ui.Section("แชตบนตัวละคร"));
                panel.Children.Add(Ui.Seg<int>([(0, "ไม่แสดง"), (1, "2 ข้อความล่าสุด"), (2, "ทั้งหมด")], look.Bubbles ?? 2, level =>
                {
                    EditLook().Bubbles = level;
                    Changed();
                }, "chat-bubbles"));
                panel.Children.Add(Ui.Section("ตำแหน่งตัวละคร"));
                // The web's ranges: size 0.1–10× and slide ±300% of the stage.
                panel.Children.Add(Slider("ขนาด", look.Zoom * 100, 10, 1000, value => EditLook().Zoom = value / 100, "chat-zoom", "×"));
                panel.Children.Add(Slider("เลื่อนซ้าย/ขวา", look.X, -300, 300, value => EditLook().X = value, "chat-x"));
                panel.Children.Add(Slider("เลื่อนขึ้น/ลง", look.Y, -300, 300, value => EditLook().Y = value, "chat-y"));
                panel.Children.Add(Ui.Button("รีเซ็ตขนาด/ตำแหน่ง", () =>
                {
                    var edited = EditLook();
                    edited.Zoom = 1;
                    edited.X = 0;
                    edited.Y = 0;
                    Changed();
                }, "ghost", "chat-view-reset"));
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

    private static string Show(double value, string unit) => unit == "×" ? $"{value / 100:0.00}×" : $"{Math.Round(value)}%";

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
        }, "chat-bg"));
        var background = look.Background;
        if (background is null) return;
        BackgroundKind(panel, current, background, changed);
        // The time spans come after the main choice, whatever it is (feature-backgrounds.js scheduleBox).
        RulesPanel(panel, changed);
    }

    private FrameworkElement BackgroundPreview(JsonObject? background, string current)
    {
        var preview = new Border { Height = 150, CornerRadius = new CornerRadius(10), Background = Theme.Brush("Raised") };
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
                panel.Children.Add(ColorBox("สี", background.Str("color"), value =>
                {
                    EditBackground("solid")["color"] = value;
                    changed();
                }));
                break;
            case "gradient":
                panel.Children.Add(ColorBox("จากสี", background.Str("from"), value =>
                {
                    EditBackground("gradient")["from"] = value;
                    changed();
                }));
                panel.Children.Add(ColorBox("ไปสี", background.Str("to"), value =>
                {
                    EditBackground("gradient")["to"] = value;
                    changed();
                }));
                break;
            case "preset":
                PresetGrid(panel, background, changed);
                break;
            case "upload":
                UploadGrid(panel, background, changed);
                break;
        }
    }

    private void PresetGrid(StackPanel panel, JsonObject background, Action changed)
    {
        var current = background.Str("preset");
        var grid = new WrapPanel { HorizontalSpacing = 8, VerticalSpacing = 8 };
        foreach (var (id, label) in StageData.Presets)
        {
            var image = new Image { Width = 140, Height = 78, Stretch = Stretch.UniformToFill };
            if (File.Exists(StageData.PresetFile(id))) image.Source = new BitmapImage(new Uri(StageData.PresetFile(id)));
            var tile = new Button
            {
                Tag = id,
                Padding = new Thickness(4),
                CornerRadius = new CornerRadius(10),
                BorderThickness = new Thickness(current == id ? 2 : 1),
                BorderBrush = current == id ? Theme.Brush("Accent") : Theme.Brush("Line"),
                Background = Theme.Brush("Raised"),
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
            };
            var body = new StackPanel { Spacing = 4 };
            body.Children.Add(new Border { Width = 140, Height = 78, CornerRadius = new CornerRadius(8), Child = image });
            body.Children.Add(new TextBlock { Text = label, FontSize = 11, HorizontalAlignment = HorizontalAlignment.Center, Foreground = Theme.Brush("Ink2") });
            tile.Content = body;
            tile.Click += (_, _) =>
            {
                EditBackground("preset")["preset"] = id;
                changed();
            };
            grid.Children.Add(tile);
        }
        panel.Children.Add(grid);
    }

    private void UploadGrid(StackPanel panel, JsonObject background, Action changed)
    {
        var current = background.Str("upload");
        var scenes = stage?.Scenes.Where(scene => scene.S("image").Length > 0).ToList() ?? [];
        if (scenes.Count == 0) panel.Children.Add(Ui.Hint("ยังไม่มีรูปที่อัปโหลดสำหรับแชต — กดปุ่มด้านล่างเพื่อเพิ่ม"));
        else
        {
            var grid = new WrapPanel { HorizontalSpacing = 8, VerticalSpacing = 8 };
            foreach (var scene in scenes)
            {
                var id = scene.S("id");
                var image = new Image { Width = 140, Height = 78, Stretch = Stretch.UniformToFill };
                _ = LoadBackgroundImage(image, $"/api/background-image/{Uri.EscapeDataString(id)}?v={Uri.EscapeDataString(scene.S("image"))}");
                var tile = new Button
                {
                    Tag = id,
                    Padding = new Thickness(4),
                    CornerRadius = new CornerRadius(10),
                    BorderThickness = new Thickness(current == id ? 2 : 1),
                    BorderBrush = current == id ? Theme.Brush("Accent") : Theme.Brush("Line"),
                    Background = Theme.Brush("Raised"),
                    HorizontalContentAlignment = HorizontalAlignment.Stretch,
                };
                var body = new StackPanel { Spacing = 4 };
                body.Children.Add(new Border { Width = 140, Height = 78, CornerRadius = new CornerRadius(8), Child = image });
                body.Children.Add(new TextBlock
                {
                    Text = scene.S("name") is { Length: > 0 } shown ? shown : id,
                    FontSize = 11,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    Foreground = Theme.Brush("Ink2"),
                    TextTrimming = TextTrimming.CharacterEllipsis,
                    MaxWidth = 140,
                });
                tile.Content = body;
                tile.Click += (_, _) =>
                {
                    EditBackground("upload")["upload"] = id;
                    changed();
                };
                grid.Children.Add(tile);
            }
            panel.Children.Add(grid);
        }
        panel.Children.Add(Ui.Button("อัปโหลดรูปจากเครื่อง…", () => _ = UploadBackground(changed), id: "chat-bg-upload"));
        panel.Children.Add(Ui.Hint("PNG, JPEG, WebP หรือ GIF ไม่เกิน 12 MB"));
    }

    private async Task LoadBackgroundImage(Image image, string path)
    {
        var bitmap = await (app?.Images.Get(path) ?? Task.FromResult<BitmapImage?>(null));
        if (bitmap is not null) image.Source = bitmap;
    }

    private static FrameworkElement ColorBox(string label, string value, Action<string> set)
    {
        var picker = new ColorPicker
        {
            Color = Theme.Parse(value) ?? Microsoft.UI.Colors.Black,
            IsAlphaEnabled = false,
            IsMoreButtonVisible = false,
            ColorSpectrumShape = ColorSpectrumShape.Ring,
            IsColorSliderVisible = true,
            IsColorChannelTextInputVisible = false,
            IsHexInputVisible = true,
        };
        picker.ColorChanged += (_, args) => set($"#{args.NewColor.R:x2}{args.NewColor.G:x2}{args.NewColor.B:x2}");
        return Ui.Field(label, picker);
    }
}
