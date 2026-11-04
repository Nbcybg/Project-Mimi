using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core.Desktop;
using Mimi.Core.Hub;
using Mimi.Core.Protocol;
using Windows.Storage.Pickers;

namespace Mimi.App.Views;

/// <summary>
/// The rest of a chat's own background (feature-backgrounds.js chatPanel): a picture uploaded from this
/// computer for this chat only (<c>POST /api/chat-background</c>), and time spans that switch the background.
/// </summary>
public sealed partial class ChatView
{
    private const long MaxBackgroundBytes = 12 * 1024 * 1024;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? ruleTimer;

    /// <summary>A span can start or end while the chat stays open: look again twice a minute (the web's 30 s).</summary>
    private void StartRuleTimer()
    {
        ruleTimer = DispatcherQueue.CreateTimer();
        ruleTimer.Interval = TimeSpan.FromSeconds(30);
        ruleTimer.Tick += (_, _) =>
        {
            if (ViewModel.ChatId != 0 && Look.BackgroundRules is { Count: > 0 }) RefreshStage();
        };
        ruleTimer.Start();
    }

    private async Task UploadBackground(Action changed)
    {
        if (app is null || ViewModel.ChatId == 0) return;
        var picker = new FileOpenPicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, window());
        foreach (var type in new[] { ".png", ".jpg", ".jpeg", ".webp", ".gif" }) picker.FileTypeFilter.Add(type);
        var file = await picker.PickSingleFileAsync();
        if (file is null) return;
        var properties = await file.GetBasicPropertiesAsync();
        if (properties.Size > MaxBackgroundBytes)
        {
            ViewModel.Error = "รูปใหญ่เกินไป (ไม่เกิน 12 MB)";
            return;
        }
        var chatId = ViewModel.ChatId;
        try
        {
            await using var stream = await file.OpenStreamForReadAsync();
            var mime = string.IsNullOrEmpty(file.ContentType) ? "image/png" : file.ContentType;
            var reply = await app.Session.Api.SendBody(HttpMethod.Post, $"/api/chat-background?chat={chatId}&name={Uri.EscapeDataString(file.Name)}", stream, mime);
            var id = reply.ValueKind == JsonValueKind.Object && reply.TryGetProperty("id", out var made) ? made.GetString() ?? "" : "";
            if (id.Length == 0) throw new InvalidOperationException("the server gave no id");
            if (ViewModel.ChatId != chatId) return;
            EditBackground("upload")["upload"] = id;
            // The core tells every screen about the new picture; ask once more so this panel lists it.
            app.Session.Send(ClientFrames.Simple("backgrounds-list"));
            changed();
        }
        catch (Exception error) when (error is HttpRequestException or InvalidOperationException or IOException or Mimi.Core.Net.MimiHttpException)
        {
            ViewModel.Error = $"อัปโหลดไม่สำเร็จ: {error.Message}";
        }
    }

    /// <summary>"ตั้งเวลาสลับฉากหลัง": the spans in order, the first that holds the time wins.</summary>
    private void RulesPanel(StackPanel panel, Action changed)
    {
        panel.Children.Add(Ui.Section("ตั้งเวลาสลับฉากหลัง"));
        panel.Children.Add(Ui.Hint("เช่น 06:00–18:00 ใช้ห้องทำงาน, 18:00–06:00 ใช้กลางคืน · ถ้าซ้อนกัน รายการแรกที่ตรงเวลาจะถูกใช้"));
        var rules = Look.BackgroundRules ?? [];
        void Save(JsonArray next)
        {
            EditLook().BackgroundRules = next.Count > 0 ? next : null;
            app!.LookChanged();
            RefreshStage();
        }
        if (rules.Count == 0) panel.Children.Add(Ui.Hint("ยังไม่มีช่วงเวลา — ใช้พื้นหลังหลักตลอด", "Faint"));
        var index = 0;
        foreach (var rule in rules.OfType<JsonObject>().ToList())
        {
            var at = index++;
            panel.Children.Add(RuleRow(rule, () =>
            {
                var next = (JsonArray)rules.DeepClone();
                next[at] = rule.DeepClone();
                Save(next);
            }, () =>
            {
                var next = (JsonArray)rules.DeepClone();
                next.RemoveAt(at);
                Save(next);
                changed();
            }));
        }
        panel.Children.Add(Ui.Button("+ เพิ่มช่วงเวลา", () =>
        {
            var next = (JsonArray)rules.DeepClone();
            next.Add(BackgroundRules.New());
            Save(next);
            changed();
        }, "ghost", "chat-bg-rule-add"));
    }

    private FrameworkElement RuleRow(JsonObject rule, Action saved, Action removed)
    {
        TextBox Clock(string key)
        {
            var box = new TextBox { Text = rule.Str(key), Width = 66, PlaceholderText = "HH:mm" };
            box.LostFocus += (_, _) =>
            {
                var clock = BackgroundRules.Clock(box.Text);
                if (clock.Length == 0)
                {
                    box.Text = rule.Str(key);
                    return;
                }
                box.Text = clock;
                if (clock == rule.Str(key)) return;
                rule[key] = clock;
                saved();
            };
            return box;
        }
        var choice = new ComboBox { MinWidth = 150 };
        void Add(string value, string label) => choice.Items.Add(new ComboBoxItem { Content = label, Tag = value });
        Add("default", "ตามพื้นหลังหลัก");
        Add("solid", "สีเดียว (ค่าหลัก)");
        Add("gradient", "ไล่เฉด (ค่าหลัก)");
        foreach (var (id, label) in StageData.Presets) Add($"preset:{id}", $"รูป: {label}");
        foreach (var scene in stage!.Scenes.Where(scene => scene.S("image").Length > 0)) Add($"upload:{scene.S("id")}", $"อัปโหลด: {(scene.S("name") is { Length: > 0 } name ? name : scene.S("id"))}");
        var kind = rule.Str("type");
        var current = kind switch { "preset" => $"preset:{rule.Str("preset")}", "upload" => $"upload:{rule.Str("upload")}", _ => kind };
        choice.SelectedItem = choice.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == current) ?? choice.Items[0];
        choice.SelectionChanged += (_, _) =>
        {
            if (choice.SelectedItem is not ComboBoxItem item) return;
            var value = (string)item.Tag;
            var split = value.IndexOf(':');
            var type = split < 0 ? value : value[..split];
            rule["type"] = type;
            if (type is "preset" or "upload") rule[type] = value[(split + 1)..];
            saved();
        };
        var remove = Ui.Button("✕", removed, "ghost", tip: "ลบช่วงเวลานี้");
        return Ui.Row(6, Clock("from"), new TextBlock { Text = "–", VerticalAlignment = VerticalAlignment.Center }, Clock("to"), choice, remove);
    }
}
