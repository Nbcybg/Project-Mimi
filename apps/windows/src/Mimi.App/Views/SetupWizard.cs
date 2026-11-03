using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core;
using Mimi.Core.Hub;
using Mimi.Core.Protocol;

namespace Mimi.App.Views;

/// <summary>
/// The first-run wizard (feature-setup.js), one step at a time: a model provider and the main model → a starter
/// agent → the folders agents may use → the PC agent of this computer → a test chat. It sends the same frames as
/// the settings pages, so the result is the same as setting things up by hand; "mimi.setupDone" is shared by the
/// account's devices.
/// </summary>
internal sealed partial class SetupWizard : UserControl
{
    private static readonly string[] Steps = ["ผู้ให้บริการ", "Agent", "โฟลเดอร์", "PC agent", "ทดสอบแชต"];
    private const string TestText = "สวัสดี แนะนำตัวหน่อย";
    private readonly App app;
    private readonly MimiSession session;
    private readonly Lookups lookups;
    private readonly StackPanel chips = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
    private readonly ContentControl body = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch };
    private readonly Button back;
    private readonly Button next;
    private readonly TextBlock note = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap };
    private JsonElement settings;
    private List<JsonElement> presets = [];
    private List<JsonElement> agents = [];
    private int step;
    private string presetId = "secretary";
    private string created = "";
    private string? authUrl;

    public SetupWizard(App app, MimiSession session, Lookups lookups)
    {
        this.app = app;
        this.session = session;
        this.lookups = lookups;
        AutomationProperties.SetAutomationId(this, "SetupWizard");
        back = Ui.Button("ย้อนกลับ", () => Go(step - 1), "ghost", "SetupBack");
        next = Ui.Button("ถัดไป", () => Go(step + 1), "pri", "SetupNext");
        var close = Ui.Button("ข้าม / ปิด", Finish, "ghost", "SetupClose", "ปิดตัวช่วย (เปิดใหม่ได้ที่เมนู ☰ → ตัวช่วยตั้งค่า)");
        var head = new StackPanel { Spacing = 8, Padding = new Thickness(16, 14, 16, 8) };
        head.Children.Add(Ui.Title("ตั้งค่าเริ่มต้น Mimi", 18));
        head.Children.Add(new ScrollViewer { Content = chips, HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden, HorizontalScrollMode = ScrollMode.Enabled, VerticalScrollMode = ScrollMode.Disabled });
        var foot = new Grid { Padding = new Thickness(16, 8, 16, 12), ColumnSpacing = 6, BorderBrush = Theme.Brush("Line"), BorderThickness = new Thickness(0, 1, 0, 0) };
        foot.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        foot.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        foot.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        foot.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        foot.Children.Add(close);
        Grid.SetColumn(back, 2);
        Grid.SetColumn(next, 3);
        foot.Children.Add(back);
        foot.Children.Add(next);
        var root = new Grid { Background = Theme.Brush("Bg") };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var scroll = new ScrollViewer { Content = body, Padding = new Thickness(16, 4, 16, 16), VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(scroll, 1);
        var noteBox = new Border { Child = note, Padding = new Thickness(16, 0, 16, 4) };
        Grid.SetRow(noteBox, 2);
        Grid.SetRow(foot, 3);
        root.Children.Add(head);
        root.Children.Add(scroll);
        root.Children.Add(noteBox);
        root.Children.Add(foot);
        Content = root;
        session.Raw += OnRaw;
    }

    /// <summary>Closed (finished or skipped): the chat list opens.</summary>
    public event Action? Closed;

    public void Open(int at = 0)
    {
        step = at;
        created = "";
        session.Send(ClientFrames.Simple("settings-get"));
        session.Send(ClientFrames.Simple("agent-presets"));
        session.Send(ClientFrames.Simple("agents-list"));
        Paint();
    }

    private void OnRaw(string type, JsonElement json)
    {
        switch (type)
        {
            case "settings":
                settings = json.At("settings").Clone();
                break;
            case "agent-presets":
                presets = json.A("presets").Select(preset => preset.Clone()).ToList();
                break;
            case "agents":
                agents = json.A("agents").Where(agent => agent.S("name") != "overseer").Select(agent => agent.Clone()).ToList();
                break;
            case "provider-auth-url":
                authUrl = json.S("url");
                if (authUrl.Length > 0) Process.Start(new ProcessStartInfo(authUrl) { UseShellExecute = true });
                break;
            case "error" when Visibility == Visibility.Visible:
                Note(json.S("message"), "Bad");
                return;
            default:
                return;
        }
        if (Visibility == Visibility.Visible) Paint();
    }

    private IEnumerable<JsonElement> Connected => settings.A("providers").Where(provider => provider.B("connected"));

    private bool Ready(int index) => index switch
    {
        0 => Connected.Any() && settings.S("defaults.model").Length > 0,
        1 => agents.Count > 0,
        _ => true,
    };

    private void Note(string text, string brush = "Muted")
    {
        note.Text = text;
        note.Foreground = Theme.Brush(brush);
    }

    private void Go(int to)
    {
        if (to < 0 || to >= Steps.Length) return;
        if (to > step && !Ready(step))
        {
            Note(step == 0 ? "เชื่อมต่อผู้ให้บริการและเลือกโมเดลหลักก่อน" : "สร้าง agent อย่างน้อยหนึ่งตัวก่อน", "Warn");
            return;
        }
        step = to;
        Note("");
        Paint();
    }

    private void Finish()
    {
        session.SetUi("mimi.setupDone", "1");
        Closed?.Invoke();
    }

    private void Paint()
    {
        chips.Children.Clear();
        for (var i = 0; i < Steps.Length; i++)
        {
            var index = i;
            var done = i < 2 ? Ready(i) : i < step;
            var chip = new Button
            {
                Content = $"{(done ? "✓ " : "")}{i + 1}. {Steps[i]}",
                FontSize = 12,
                CornerRadius = new CornerRadius(14),
                Padding = new Thickness(10, 3, 10, 3),
                Background = Theme.Brush(i == step ? "AccentSoft" : "Panel"),
                BorderBrush = Theme.Brush(i == step ? "Accent" : "Line"),
                Foreground = Theme.Brush(i == step ? "AccentText" : done ? "Ok" : "Ink2"),
            };
            AutomationProperties.SetAutomationId(chip, $"setup-step-{i}");
            chip.Click += (_, _) => Go(index);
            chips.Children.Add(chip);
        }
        back.Visibility = step == 0 ? Visibility.Collapsed : Visibility.Visible;
        next.Visibility = step == Steps.Length - 1 ? Visibility.Collapsed : Visibility.Visible;
        var panel = new StackPanel { Spacing = 12 };
        switch (step)
        {
            case 0:
                ProviderStep(panel);
                break;
            case 1:
                AgentStep(panel);
                break;
            case 2:
                FolderStep(panel);
                break;
            case 3:
                PcStep(panel);
                break;
            default:
                TestStep(panel);
                break;
        }
        body.Content = panel;
    }

    private void ProviderStep(StackPanel panel)
    {
        panel.Children.Add(Ui.Hint("เลือกวิธีที่ Mimi ใช้คุยกับโมเดล: แผนรายเดือนของ Claude หรือ ChatGPT (ไม่ต้องใช้ API key) หรือใส่ API key ของผู้ให้บริการใดก็ได้ เช่น anthropic, openai, deepseek, google · คีย์เก็บในเครื่องที่รัน Mimi เท่านั้น"));
        var connected = Connected.ToList();
        if (connected.Count > 0)
        {
            panel.Children.Add(Ui.Pill($"เชื่อมต่อแล้ว: {string.Join(", ", connected.Select(provider => provider.S("name") is { Length: > 0 } name ? name : provider.S("id")))}", "Ok"));
            var model = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch, PlaceholderText = "เลือกโมเดลหลักสำหรับแชต" };
            AutomationProperties.SetAutomationId(model, "SetupModel");
            foreach (var (value, label) in lookups.Get("models-only")) model.Items.Add(new ComboBoxItem { Content = label, Tag = value });
            model.SelectedItem = model.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == settings.S("defaults.model"));
            model.SelectionChanged += (_, _) =>
            {
                if (model.SelectedItem is ComboBoxItem item) session.Send(ClientFrames.Json("settings-save", new JsonObject { ["defaults"] = new JsonObject { ["model"] = (string)item.Tag } }));
            };
            panel.Children.Add(Ui.Field("โมเดลหลัก (ใช้กับ agent ที่ไม่ได้เลือกโมเดลเอง)", model, settings.S("defaults.model").Length == 0 ? "เลือกโมเดลหลักก่อนไปขั้นต่อไป" : null));
        }
        panel.Children.Add(Ui.Card(
            Ui.Section("แผนรายเดือน"),
            Ui.Hint("ChatGPT: เปิดหน้าล็อกอินของ OpenAI ในเบราว์เซอร์ · Claude: ใช้ Claude Code ที่ล็อกอินไว้บนเครื่องที่รัน Mimi"),
            Ui.Row(6,
                Ui.Button("เชื่อมต่อ ChatGPT", () =>
                {
                    session.Send(ClientFrames.Simple("chatgpt-plan-connect"));
                    Note("เปิดหน้าล็อกอินในเบราว์เซอร์… ล็อกอินเสร็จแล้วกลับมาที่นี่", "Muted");
                }),
                Ui.Button("ใช้ Claude (Claude Code)", () =>
                {
                    session.Send(ClientFrames.Json("provider-connect", new JsonObject { ["id"] = "claude-subscription" }));
                    Note("กำลังเชื่อมต่อ…", "Muted");
                    Later();
                }))));
        var provider = new ComboBox { IsEditable = true, HorizontalAlignment = HorizontalAlignment.Stretch, PlaceholderText = "เช่น anthropic, openai, deepseek" };
        AutomationProperties.SetName(provider, "ผู้ให้บริการ");
        foreach (var (value, label) in lookups.Get("catalog")) provider.Items.Add(new ComboBoxItem { Content = label, Tag = value });
        var key = new PasswordBox { PlaceholderText = "API key" };
        AutomationProperties.SetName(key, "API key");
        panel.Children.Add(Ui.Card(
            Ui.Section("API key"),
            Ui.Field("ผู้ให้บริการ", provider),
            Ui.Field("API key", key),
            Ui.Button("เชื่อมต่อและดึงโมเดล", () =>
            {
                var id = (provider.SelectedItem as ComboBoxItem)?.Tag as string ?? provider.Text.Trim().ToLowerInvariant();
                if (id.Length == 0)
                {
                    Note("เลือกหรือพิมพ์ชื่อผู้ให้บริการก่อน", "Warn");
                    return;
                }
                session.Send(ClientFrames.Json("provider-connect", new JsonObject { ["id"] = id, ["apiKey"] = key.Password.Length > 0 ? key.Password : null }));
                key.Password = "";
                Note($"กำลังเชื่อมต่อ {id} และดึงรายชื่อโมเดล…", "Muted");
                Later();
            }, "pri", "SetupConnect")));
    }

    /// <summary>A connection takes a moment: the settings are asked again.</summary>
    private async void Later()
    {
        await Task.Delay(2500);
        session.Send(ClientFrames.Simple("settings-get"));
    }

    private void AgentStep(StackPanel panel)
    {
        if (agents.Count > 0 && created.Length == 0)
        {
            panel.Children.Add(Ui.Pill($"มี agent แล้ว: {string.Join(", ", agents.Select(agent => agent.S("displayName") is { Length: > 0 } shown ? shown : agent.S("name")))} · ข้ามขั้นนี้ได้", "Ok"));
        }
        if (created.Length > 0) panel.Children.Add(Ui.Pill($"สร้าง {created} แล้ว ✓", "Ok"));
        panel.Children.Add(Ui.Hint("เลือกแบบตั้งต้น แล้วแก้ชื่อ คำสั่ง และเครื่องมือได้ภายหลังที่หน้า Agent · agent ที่อ่านเว็บ/อีเมลจะไม่มีสิทธิ์รันคำสั่งบนเครื่อง"));
        if (presets.Count == 0)
        {
            panel.Children.Add(Ui.Hint("กำลังโหลดแบบตั้งต้น…", "Faint"));
            return;
        }
        foreach (var preset in presets)
        {
            var on = preset.S("id") == presetId;
            var card = new Button
            {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
                Padding = new Thickness(12, 9, 12, 9),
                CornerRadius = new CornerRadius(10),
                Background = Theme.Brush(on ? "AccentSoft" : "Panel"),
                BorderBrush = Theme.Brush(on ? "Accent" : "Line"),
            };
            var text = new StackPanel { Spacing = 2 };
            text.Children.Add(new TextBlock { Text = preset.S("label"), FontWeight = FontWeights.SemiBold, Foreground = Theme.Brush("Ink") });
            text.Children.Add(Ui.Hint(preset.S("summary")));
            text.Children.Add(Ui.Hint($"{preset.A("tools").Count()} เครื่องมือ", "Faint"));
            card.Content = text;
            AutomationProperties.SetName(card, preset.S("label"));
            var id = preset.S("id");
            card.Click += (_, _) =>
            {
                presetId = id;
                Paint();
            };
            panel.Children.Add(card);
        }
        var chosen = presets.FirstOrDefault(entry => entry.S("id") == presetId);
        if (chosen.ValueKind != JsonValueKind.Object) chosen = presets[0];
        var taken = agents.Select(agent => agent.S("name")).Append("overseer").ToHashSet();
        var suggested = chosen.S("name");
        for (var n = 2; taken.Contains(suggested); n++) suggested = $"{chosen.S("name")}{n}";
        var name = new TextBox { Text = suggested };
        AutomationProperties.SetName(name, "ชื่อ agent");
        panel.Children.Add(Ui.Field("ชื่อ agent (a-z, 0-9, - และ _)", name));
        panel.Children.Add(Ui.Button($"สร้าง {chosen.S("label")}", () =>
        {
            var id = name.Text.Trim().ToLowerInvariant();
            if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-z][a-z0-9_-]*$"))
            {
                Note("ชื่อ agent ใช้ได้แค่ a-z, 0-9, - และ _ (ขึ้นต้นด้วยตัวอักษร)", "Warn");
                return;
            }
            if (taken.Contains(id))
            {
                Note($"มี agent ชื่อ \"{id}\" แล้ว", "Warn");
                return;
            }
            created = id;
            session.Send(ClientFrames.Json("agent-save", new JsonObject
            {
                ["agent"] = new JsonObject
                {
                    ["name"] = id,
                    ["displayName"] = chosen.S("displayName"),
                    ["description"] = chosen.S("description"),
                    ["systemPrompt"] = chosen.S("systemPrompt"),
                    ["models"] = new JsonObject(),
                    ["tools"] = new JsonArray(chosen.Strings("tools").Select(tool => (JsonNode)tool).ToArray()),
                    ["canMessage"] = new JsonArray(),
                    ["budgets"] = new JsonObject { ["maxRounds"] = 12, ["maxTokens"] = 200000 },
                },
            }));
            Note($"กำลังสร้าง {id}…", "Muted");
        }, "pri", "SetupCreateAgent"));
    }

    private void FolderStep(StackPanel panel)
    {
        panel.Children.Add(Ui.Hint("agent อ่าน/เขียนไฟล์และรันคำสั่งได้เฉพาะในโฟลเดอร์เหล่านี้ (และโฟลเดอร์ย่อย) บนเครื่องที่รัน Mimi · หนึ่งโฟลเดอร์ต่อบรรทัด · ใส่เท่าที่จำเป็น"));
        var dirs = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 90, Text = string.Join("\r", settings.Strings("allowedDirs")), FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12 };
        AutomationProperties.SetName(dirs, "โฟลเดอร์ที่อนุญาต");
        panel.Children.Add(dirs);
        panel.Children.Add(Ui.Button("บันทึกโฟลเดอร์", () =>
        {
            var list = dirs.Text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (list.Length == 0)
            {
                Note("ต้องมีอย่างน้อยหนึ่งโฟลเดอร์", "Warn");
                return;
            }
            session.Send(ClientFrames.Json("settings-save", new JsonObject { ["allowedDirs"] = new JsonArray(list.Select(dir => (JsonNode)dir).ToArray()) }));
            Note("บันทึกแล้ว", "Ok");
        }));
        panel.Children.Add(Ui.Hint($"โฟลเดอร์ที่ PC agent ของเครื่องนี้ใช้ได้: {string.Join(", ", app.Config.PcAgent.Folders)} (แก้ได้ที่ตั้งค่า → แอปและระบบ)", "Faint"));
    }

    private void PcStep(StackPanel panel)
    {
        var online = session.PcOnline;
        panel.Children.Add(Ui.Pill(online ? "PC agent เชื่อมต่ออยู่ ✓" : $"PC agent ยังไม่ได้เชื่อมต่อ ({app.PcStatus})", online ? "Ok" : "Warn"));
        panel.Children.Add(Ui.Hint("PC agent ให้ Mimi ใช้ไฟล์ หน้าจอ และเบราว์เซอร์บนเครื่องนี้ · ไม่ใช้ก็ข้ามได้ แชต งานอัตโนมัติ และ connector ยังทำงานได้"));
        var toggle = new ToggleSwitch { Header = "ให้ Mimi ใช้เครื่องนี้ (PC agent)", IsOn = app.Config.PcAgent.Enabled };
        toggle.Toggled += async (_, _) =>
        {
            await app.SetPcAgent(toggle.IsOn);
            await Task.Delay(1500);
            Paint();
        };
        panel.Children.Add(toggle);
    }

    private void TestStep(StackPanel panel)
    {
        if (agents.Count == 0)
        {
            panel.Children.Add(Ui.Hint("ยังไม่มี agent — ย้อนกลับไปสร้างในขั้น Agent", "Bad"));
            return;
        }
        var pick = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var agent in agents) pick.Items.Add(new ComboBoxItem { Content = agent.S("displayName") is { Length: > 0 } shown ? shown : agent.S("name"), Tag = agent.S("name") });
        pick.SelectedItem = pick.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == created) ?? pick.Items[0];
        var text = new TextBox { Text = TestText };
        AutomationProperties.SetName(text, "ข้อความทดสอบ");
        panel.Children.Add(Ui.Hint(settings.B("ready") ? "พร้อมแล้ว ลองทักดู — ถ้าโมเดลตอบกลับ แปลว่าตั้งค่าครบ" : "ยังไม่พร้อม: ต้องมี agent และผู้ให้บริการของโมเดลแชตที่เชื่อมต่อแล้ว", settings.B("ready") ? "Ok" : "Warn"));
        panel.Children.Add(Ui.Field("คุยกับ", pick));
        panel.Children.Add(Ui.Field("ข้อความ", text));
        panel.Children.Add(Ui.Button("เปิดแชตและส่งข้อความ", () =>
        {
            session.SetUi("mimi.setupDone", "1");
            app.StartTestChat((string)((ComboBoxItem)pick.SelectedItem).Tag, text.Text.Trim() is { Length: > 0 } typed ? typed : TestText);
        }, "pri", "SetupTest"));
    }
}
