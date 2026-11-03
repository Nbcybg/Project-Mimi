using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
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
    private string? mood;

    private static readonly (string Key, string Label)[] StatusKeys = [("location", "ที่อยู่"), ("outfit", "ชุด"), ("current_task", "กำลังทำ"), ("mood", "อารมณ์")];

    internal void Attach(App owner, StageData data, string cache)
    {
        app = owner;
        stage = data;
        stageView = new StageView(owner.Images, () => owner.Session.Api, cache);
        StageHost.Children.Add(stageView);
        data.Changed += () => DispatcherQueue.TryEnqueue(RefreshStage);
        ViewModel.Grew += () => DispatcherQueue.TryEnqueue(OnGrew);
        ViewModel.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(ChatViewModel.ContextLabel)) Meter();
        };
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
        Messages.FontSize = size switch { 0 => 12.5, 2 => 17, _ => 14 };
        CharacterButton.IsChecked = CharacterOn;
        CharacterButton.Visibility = DirectAgent() is null ? Visibility.Collapsed : Visibility.Visible;
        // How much of the chat shows over the character: none, the newest two (the bottom of the stage), all.
        var level = CharacterOn && DirectAgent() is not null ? look.Bubbles ?? 2 : 2;
        Messages.Visibility = level == 0 ? Visibility.Collapsed : Visibility.Visible;
        Messages.VerticalAlignment = level == 1 ? VerticalAlignment.Bottom : VerticalAlignment.Stretch;
        Messages.MaxHeight = level == 1 ? 260 : double.PositiveInfinity;
        Meter();
        mood = null;
        for (var i = ViewModel.Items.Count - 1; i >= 0 && mood is null; i--)
        {
            if (ViewModel.Items[i] is MessageItem { IsUser: false } message) mood = StageData.LastEmojiKey(message.Text);
        }
        RefreshStage();
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
            return;
        }
        stageView.Visibility = Visibility.Visible;
        stageView.Update(stage, Look, CharacterOn, DirectAgent(), mood);
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
        var tab = "info";
        var flyout = new Flyout { Placement = FlyoutPlacementMode.BottomEdgeAlignedRight };
        void Paint()
        {
            var panel = new StackPanel { Spacing = 14, Width = 330 };
            panel.Children.Add(Ui.Seg<string>([("info", "ข้อมูล"), ("look", "หน้าตา")], tab, next =>
            {
                tab = next;
                Paint();
            }, "rail"));
            if (tab == "info") InfoPanel(panel);
            else LookPanel(panel, Paint);
            body.Content = panel;
        }
        Paint();
        flyout.Content = Ui.Scroll(body, 560);
        flyout.ShowAt(RailButton);
    }

    private void InfoPanel(StackPanel panel)
    {
        var chat = ViewModel.Chat;
        if (chat is null) return;
        panel.Children.Add(Ui.Title(app!.Session.ChatTitle(chat)));
        panel.Children.Add(Ui.Hint(chat.Kind == "direct" ? "แชตตัวต่อตัว" : $"แชตกลุ่ม · สมาชิก {string.Join(", ", (chat.Agents ?? []).Select(app.Session.AgentName))}"));
        if (ViewModel.ContextLabel.Length > 0) panel.Children.Add(Ui.Mono(ViewModel.ContextLabel));
        if (DirectAgent() is not { } name || stage?.Agent(name) is not { } agent) return;
        if (agent.S("description").Length > 0) panel.Children.Add(Ui.Hint(agent.S("description")));
        panel.Children.Add(Ui.Section("สถานะตอนนี้"));
        var grid = new Grid { ColumnSpacing = 10, RowSpacing = 6 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var row = 0;
        foreach (var (key, label) in StatusKeys)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var caption = Ui.Hint(label);
            caption.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetRow(caption, row);
            grid.Children.Add(caption);
            var value = agent.S($"status.{key}");
            var box = new TextBox { Text = value, PlaceholderText = "ยังไม่ระบุ", FontSize = 13 };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, label);
            box.LostFocus += (_, _) =>
            {
                if (box.Text != value) app!.Session.Send(ClientFrames.Json("status-set", new JsonObject { ["agent"] = name, ["key"] = key, ["value"] = box.Text.Trim() }));
            };
            Grid.SetRow(box, row);
            Grid.SetColumn(box, 1);
            grid.Children.Add(box);
            row++;
        }
        panel.Children.Add(grid);
        panel.Children.Add(Ui.Hint("แก้ได้ (ปกติ agent อัปเดตเองระหว่างคุย)"));
        if (agent.S("status.situation").Length > 0)
        {
            panel.Children.Add(Ui.Button("เอาภาพสถานการณ์ออกจากแชต", () =>
                app!.Session.Send(ClientFrames.Json("status-set", new JsonObject { ["agent"] = name, ["key"] = "situation", ["value"] = "" })), "ghost"));
        }
    }

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
                panel.Children.Add(Slider("ขนาด", look.Zoom * 100, 40, 250, value => EditLook().Zoom = value / 100));
                panel.Children.Add(Slider("เลื่อนซ้าย/ขวา", look.X, -50, 50, value => EditLook().X = value));
                panel.Children.Add(Slider("เลื่อนขึ้น/ลง", look.Y, -50, 50, value => EditLook().Y = value));
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

    private Slider Slider(string label, double value, double min, double max, Action<double> set)
    {
        var slider = new Slider { Header = label, Minimum = min, Maximum = max, Value = value, StepFrequency = 1 };
        slider.ValueChanged += (_, args) =>
        {
            set(args.NewValue);
            app!.SaveConfig(later: true);
            RefreshStage();
        };
        return slider;
    }

    /// <summary>The chat's own background (feature-backgrounds.js chatPanel): none, a colour, a gradient, a preset scene or an uploaded one.</summary>
    private void BackgroundPanel(StackPanel panel, Action changed)
    {
        var look = Look;
        var current = look.Background?.Str("type") is { Length: > 0 } type ? type : "default";
        panel.Children.Add(Ui.Section("ฉากหลังของแชตนี้"));
        JsonObject Edit(string kind)
        {
            var edited = EditLook();
            edited.Background ??= new JsonObject { ["color"] = "#1b1d22", ["from"] = "#1b1d22", ["to"] = "#3a2d28", ["angle"] = 135, ["preset"] = "floral" };
            edited.Background["type"] = kind;
            return edited.Background;
        }
        var kinds = new List<(string, string)> { ("default", "ตามแอป"), ("none", "ไม่มี"), ("solid", "สีเดียว"), ("gradient", "ไล่สี"), ("preset", "ฉาก") };
        if (stage!.Scenes.Any(scene => scene.S("image").Length > 0)) kinds.Add(("upload", "อัปโหลด"));
        panel.Children.Add(Ui.Seg<string>(kinds, current, kind =>
        {
            if (kind == "default")
            {
                EditLook().Background = null;
            }
            else
            {
                var background = Edit(kind);
                if (kind == "upload" && background.Str("upload").Length == 0) background["upload"] = stage.Scenes.First(scene => scene.S("image").Length > 0).S("id");
            }
            changed();
        }, "chat-bg"));
        var background = look.Background;
        if (background is null) return;
        switch (current)
        {
            case "solid":
                panel.Children.Add(ColorBox("สี", background.Str("color"), value =>
                {
                    Edit("solid")["color"] = value;
                    app!.LookChanged();
                }));
                break;
            case "gradient":
                panel.Children.Add(ColorBox("จากสี", background.Str("from"), value =>
                {
                    Edit("gradient")["from"] = value;
                    app!.LookChanged();
                }));
                panel.Children.Add(ColorBox("ไปสี", background.Str("to"), value =>
                {
                    Edit("gradient")["to"] = value;
                    app!.LookChanged();
                }));
                break;
            case "preset":
                var presets = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
                foreach (var (id, label) in StageData.Presets) presets.Items.Add(new ComboBoxItem { Content = label, Tag = id });
                presets.SelectedItem = presets.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == background.Str("preset"));
                presets.SelectionChanged += (_, _) =>
                {
                    if (presets.SelectedItem is not ComboBoxItem item) return;
                    Edit("preset")["preset"] = (string)item.Tag;
                    changed();
                };
                panel.Children.Add(Ui.Field("ฉาก", presets));
                break;
            case "upload":
                var uploads = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
                foreach (var scene in stage!.Scenes.Where(scene => scene.S("image").Length > 0)) uploads.Items.Add(new ComboBoxItem { Content = scene.S("name") is { Length: > 0 } shown ? shown : scene.S("id"), Tag = scene.S("id") });
                uploads.SelectedItem = uploads.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == background.Str("upload"));
                uploads.SelectionChanged += (_, _) =>
                {
                    if (uploads.SelectedItem is not ComboBoxItem item) return;
                    Edit("upload")["upload"] = (string)item.Tag;
                    changed();
                };
                panel.Children.Add(Ui.Field("ฉากที่อัปโหลด (Hub → ฉากหลัง)", uploads));
                break;
        }
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
