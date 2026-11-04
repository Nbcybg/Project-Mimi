using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core.Hub;

namespace Mimi.App.Views;

public sealed partial class ManagePage
{
    /// <summary>
    /// The agent's 3D character (feature-vrm.js panel): the model with its Mixamo motions — play one (looped or
    /// once), stop, delete one — and which motion it plays while it stands (idleMotion, saved with the agent).
    /// </summary>
    private async Task Character(EntityList list, JsonElement agent)
    {
        var name = agent.S("name");
        var e = Uri.EscapeDataString(name);
        var preview = new VrmView(() => session.Api, ModelCache) { Width = 300, Height = 380 };
        var status = Ui.Hint("กำลังโหลดโมเดล…");
        AutomationProperties.SetAutomationId(status, "CharacterStatus");
        var motions = agent.A("motions").Where(motion => motion.S("name").Length > 0).Select(motion => (Name: motion.S("name"), Path: $"/api/agent-motion/{e}/{Uri.EscapeDataString(motion.S("name"))}?v={motion.S("version")}")).ToList();
        var idle = agent.S("idleMotion");
        var loop = new CheckBox { Content = "เล่นวน", IsChecked = true };
        var buttons = new StackPanel { Spacing = 4 };
        var idleBox = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetName(idleBox, "ท่าตอนยืนเฉย");
        idleBox.Items.Add(new ComboBoxItem { Content = "— ไม่มี (หายใจเบา ๆ) —", Tag = "" });
        foreach (var motion in motions) idleBox.Items.Add(new ComboBoxItem { Content = motion.Name, Tag = motion.Name });
        idleBox.SelectedItem = idleBox.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == idle) ?? idleBox.Items[0];

        preview.StateChanged += () => DispatcherQueue.TryEnqueue(() =>
        {
            status.Text = preview.State switch
            {
                "ready" => motions.Count == 0 ? "ยังไม่มีท่า — เพิ่มท่า (Mixamo .fbx) ได้จากรายการคำสั่งของ agent" : "กำลังโหลดท่า…",
                "failed" => "แสดงโมเดลไม่ได้ (ไม่มี WebView2 หรือไฟล์ไม่ใช่ VRM)",
                _ => status.Text,
            };
        });
        preview.MotionsLoaded += (loaded, failed) => DispatcherQueue.TryEnqueue(() =>
        {
            status.Text = failed.Count == 0 ? $"พร้อม {loaded.Count} ท่า" : $"พร้อม {loaded.Count} ท่า · ใช้ไม่ได้: {string.Join(", ", failed.Select(entry => $"{entry.Name} ({entry.Message})"))}";
            foreach (var button in buttons.Children.OfType<Grid>().SelectMany(row => row.Children.OfType<Button>()).Where(button => button.Tag is string))
            {
                button.IsEnabled = loaded.Contains((string)button.Tag);
            }
        });
        preview.Playing += playing => DispatcherQueue.TryEnqueue(() =>
        {
            if (playing is not null) status.Text = $"กำลังเล่น: {playing}";
        });

        foreach (var motion in motions)
        {
            var row = new Grid { ColumnSpacing = 4 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var play = new Button { Content = $"▶ {motion.Name}", Tag = motion.Name, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, IsEnabled = false };
            AutomationProperties.SetName(play, $"เล่นท่า {motion.Name}");
            play.Click += (_, _) => preview.Play(motion.Name, loop.IsChecked == true);
            var remove = new Button { Content = "🗑", Padding = new Thickness(8, 4, 8, 4) };
            AutomationProperties.SetName(remove, $"ลบท่า {motion.Name}");
            ToolTipService.SetToolTip(remove, "ลบท่านี้");
            remove.Click += async (_, _) =>
            {
                try
                {
                    await session.Api.SendBody(HttpMethod.Delete, $"/api/agent-motion/{e}/{Uri.EscapeDataString(motion.Name)}");
                    buttons.Children.Remove(row);
                    status.Text = $"ลบท่า {motion.Name} แล้ว";
                    list.Refresh();
                }
                catch (Exception error) when (error is HttpRequestException or InvalidOperationException)
                {
                    status.Text = $"ลบไม่ได้: {error.Message}";
                }
            };
            Grid.SetColumn(remove, 1);
            row.Children.Add(play);
            row.Children.Add(remove);
            buttons.Children.Add(row);
        }

        var side = new StackPanel { Spacing = 8, Width = 240 };
        side.Children.Add(Ui.Section("ท่าทาง (Mixamo)"));
        side.Children.Add(buttons);
        side.Children.Add(Ui.Row(6, loop, Ui.Button("■ หยุด", () => preview.Play(null), "ghost")));
        side.Children.Add(Ui.Field("ท่าตอนยืนเฉย (บนหน้าแชต)", idleBox, "เล่นวนตอนตัวละครยืนอยู่บนหน้าแชต"));
        var body = new Grid { ColumnSpacing = 16 };
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var left = new StackPanel { Spacing = 6 };
        left.Children.Add(new Border { Child = preview, Background = Theme.Brush("Raised"), CornerRadius = new CornerRadius(12) });
        left.Children.Add(status);
        Grid.SetColumn(side, 1);
        body.Children.Add(left);
        body.Children.Add(side);

        preview.Show($"/api/agent-model/{e}?v={agent.S("model")}");
        preview.Motions(motions, idle.Length > 0 ? idle : null);
        idleBox.SelectionChanged += (_, _) => preview.Motions(motions, idleBox.SelectedItem is ComboBoxItem { Tag: string { Length: > 0 } chosen } ? chosen : null);

        var dialog = new ContentDialog
        {
            Title = $"ตัวละคร 3D ของ {(agent.S("displayName") is { Length: > 0 } shown ? shown : name)}",
            Content = body,
            PrimaryButtonText = "บันทึกท่ายืนเฉย",
            CloseButtonText = "ปิด",
            DefaultButton = ContentDialogButton.Close,
        };
        var result = await ShowDialog(dialog);
        preview.Hide();
        if (result != ContentDialogResult.Primary) return;
        var chosenIdle = idleBox.SelectedItem is ComboBoxItem { Tag: string tag } ? tag : "";
        if (chosenIdle == idle) return;
        var edited = agent.Obj();
        edited["idleMotion"] = chosenIdle.Length > 0 ? chosenIdle : null;
        list.Save(edited, name);
    }
}
