using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core.Hub;
using Windows.Storage;
using Windows.Storage.Pickers;

namespace Mimi.App.Views;

/// <summary>
/// The parts of the web's agent form that are not plain fields (app.js renderAgents): the avatar and
/// portrait pictures with their previews, the emoji sprite editor, and the per-tool permission matrix.
/// </summary>
public sealed partial class ManagePage
{
    private static readonly string[] QuickEmoji = ["😊", "😄", "😂", "🥰", "😍", "😉", "😳", "😮", "🤔", "😅", "😢", "😭", "😠", "😴", "🥺", "❤️"];

    private FrameworkElement AgentExtras(EntityList list, JsonObject agent)
    {
        var stack = new StackPanel { Spacing = 12 };
        stack.Children.Add(AgentPictures(list, agent));
        stack.Children.Add(AgentSprites(list, agent));
        stack.Children.Add(AgentTools(agent));
        stack.Children.Add(AgentWorkflows(agent));
        stack.Children.Add(AgentPermissions(agent));
        stack.Children.Add(AgentPromptPreview(agent));
        return stack;
    }

    // ---------- tools / Quick Work ----------

    private FrameworkElement AgentTools(JsonObject agent)
    {
        var name = agent.Str("name");
        var selected = new SortedSet<string>(StringComparer.Ordinal);
        if (agent["tools"] is JsonArray tools)
        {
            foreach (var tool in tools)
            {
                if (tool is JsonValue value && value.TryGetValue<string>(out var toolName) && toolName.Length > 0) selected.Add(toolName);
            }
        }
        var card = new Border
        {
            Background = Brush("MimiPanelBrush"),
            BorderBrush = Brush("MimiLineBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 10, 12, 12),
        };
        var body = new StackPanel { Spacing = 8 };
        body.Children.Add(Ui.Section("เครื่องมือ / Quick Work"));
        body.Children.Add(Ui.Hint("Quick Work คือ preset ที่ตั้งไว้ใน Hub → กองโมเดล · ติ๊กแล้ว agent เรียกใช้ได้เลย"));
        var lazy = new ToggleSwitch
        {
            Header = "Lazy tools (tool_search)",
            IsOn = agent["lazyTools"] is JsonValue lazyValue && lazyValue.TryGetValue<bool>(out var lazyOn) && lazyOn,
            OnContent = "เปิด",
            OffContent = "ปิด",
        };
        lazy.Toggled += (_, _) => agent["lazyTools"] = lazy.IsOn;
        body.Children.Add(lazy);
        body.Children.Add(Ui.Hint("เปิด = ส่งเฉพาะ tool_search แล้วโหลดเครื่องมือเมื่อโมเดลขอ (เหมาะกับเครื่องมือเยอะ)"));
        var search = new TextBox { PlaceholderText = "กรองชื่อเครื่องมือ", FontSize = 12 };
        body.Children.Add(search);
        var list = new StackPanel { Spacing = 2 };
        var scroller = new ScrollViewer { Content = list, MaxHeight = 260, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        body.Children.Add(scroller);

        void Store()
        {
            agent["tools"] = new JsonArray(selected.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
        }
        void Paint()
        {
            var presets = lookups.Get("presets");
            var available = presets.Select(entry => (Name: entry.Value, Label: entry.Label, Quick: true))
                .Concat(lookups.Get("tools").Select(entry => (Name: entry.Value, Label: entry.Label, Quick: false)))
                .GroupBy(entry => entry.Name).Select(group => group.First())
                .Concat(selected.Where(value => !presets.Any(entry => entry.Value == value) && !lookups.Get("tools").Any(entry => entry.Value == value))
                    .Select(value => (Name: value, Label: value, Quick: false)))
                .OrderByDescending(entry => entry.Quick).ThenBy(entry => entry.Name, StringComparer.Ordinal)
                .ToList();
            list.Children.Clear();
            var query = search.Text.Trim().ToLowerInvariant();
            foreach (var (tool, label, quick) in available)
            {
                if (query.Length > 0 && !tool.ToLowerInvariant().Contains(query) && !label.ToLowerInvariant().Contains(query)) continue;
                var check = new CheckBox { Content = quick ? $"⚡ {label}" : label, IsChecked = selected.Contains(tool), FontSize = 12, Tag = tool };
                check.Checked += (_, _) => { selected.Add(tool); Store(); };
                check.Unchecked += (_, _) => { selected.Remove(tool); Store(); };
                list.Children.Add(check);
            }
            if (list.Children.Count == 0) list.Children.Add(Ui.Hint("ไม่พบเครื่องมือที่ตรงกับคำค้น"));
        }
        search.TextChanged += (_, _) => Paint();
        Paint();
        lookups.Changed += Paint;
        card.Unloaded += (_, _) => lookups.Changed -= Paint;
        card.Child = body;
        return card;
    }

    // ---------- workflows ----------

    private FrameworkElement AgentWorkflows(JsonObject agent)
    {
        var name = agent.Str("name");
        var card = new Border
        {
            Background = Brush("MimiPanelBrush"),
            BorderBrush = Brush("MimiLineBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 10, 12, 12),
        };
        var body = new StackPanel { Spacing = 6 };
        body.Children.Add(Ui.Section("Workflow ของ agent นี้"));
        var list = new StackPanel { Spacing = 3 };
        void Paint()
        {
            list.Children.Clear();
            var flows = lookups.Items("workflows").Where(entry => entry.S("agent") == name).ToList();
            if (flows.Count == 0) list.Children.Add(Ui.Hint("ยังไม่มี workflow ของ agent นี้"));
            foreach (var flow in flows)
            {
                var title = flow.S("title") is { Length: > 0 } shown ? shown : flow.S("name");
                var row = new Button
                {
                    Content = $"{(flow.B("enabled") ? "●" : "○")} {title}",
                    HorizontalAlignment = HorizontalAlignment.Stretch,
                    HorizontalContentAlignment = HorizontalAlignment.Left,
                    FontSize = 12,
                    Padding = new Thickness(8, 4, 8, 4),
                    BorderThickness = new Thickness(0),
                    Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                };
                row.Click += (_, _) => App.Instance?.ShowManage(Page.Workflows);
                list.Children.Add(row);
            }
        }
        Paint();
        lookups.Changed += Paint;
        card.Unloaded += (_, _) => lookups.Changed -= Paint;
        body.Children.Add(list);
        body.Children.Add(Ui.Button("เปิดหน้า Workflow", () => App.Instance?.ShowManage(Page.Workflows), "ghost"));
        card.Child = body;
        return card;
    }

    // ---------- what the user's profile gives this agent's prompt ----------

    private FrameworkElement AgentPromptPreview(JsonObject agent)
    {
        var name = agent.Str("name");
        var card = new Border
        {
            Background = Brush("MimiPanelBrush"),
            BorderBrush = Brush("MimiLineBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 10, 12, 12),
        };
        var body = new StackPanel { Spacing = 6 };
        body.Children.Add(Ui.Section("ข้อมูลผู้ใช้ที่ agent เห็น"));
        body.Children.Add(Ui.Hint("มาจาก Settings → โปรไฟล์ของฉัน และถูกเติมใน {{user}} ตอนรัน"));
        var preview = Ui.Mono("กำลังโหลด…");
        body.Children.Add(preview);
        void Paint()
        {
            var profile = lookups.Profile;
            if (profile.ValueKind != JsonValueKind.Object)
            {
                preview.Text = "กำลังโหลด…";
                return;
            }
            var lines = new List<string>();
            foreach (var field in profile.A("fields"))
            {
                var value = field.S("value").Trim();
                if (value.Length == 0) continue;
                var visible = field.At("visibleTo") switch
                {
                    { ValueKind: JsonValueKind.String } text => text.GetString() == "*",
                    { ValueKind: JsonValueKind.Array } array => array.EnumerateArray().Any(entry => entry.GetString() == name),
                    _ => true,
                };
                if (!visible) continue;
                var label = field.S("label") is { Length: > 0 } labelText ? labelText : field.S("key");
                lines.Add($"- {label} ({field.S("key")}): {value.Replace("\r", " ").Replace("\n", " / ")}");
            }
            preview.Text = lines.Count > 0 ? string.Join("\n", lines) : "(ยังไม่มีข้อมูลผู้ใช้ที่ agent นี้เห็น)";
        }
        Paint();
        lookups.Changed += Paint;
        card.Unloaded += (_, _) => lookups.Changed -= Paint;
        card.Child = body;
        return card;
    }

    // ---------- avatar / portrait ----------

    private FrameworkElement AgentPictures(EntityList list, JsonObject agent)
    {
        var name = agent.Str("name");
        var card = new Border
        {
            Background = Brush("MimiPanelBrush"),
            BorderBrush = Brush("MimiLineBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 10, 12, 12),
        };
        var body = new StackPanel { Spacing = 8 };
        body.Children.Add(Ui.Section("รูปของ agent"));
        body.Children.Add(Ui.Hint("รูปโปรไฟล์ใช้ในรายการแชต · รูปเต็มตัวใช้เป็นตัวละครบนเวทีแชต"));
        var pictures = new WrapPanel { HorizontalSpacing = 12, VerticalSpacing = 12 };
        pictures.Children.Add(PictureCard(list, agent, "avatar", "รูปโปรไฟล์ (avatar)", 140, 140, Stretch.UniformToFill));
        pictures.Children.Add(PictureCard(list, agent, "portrait", "รูปเต็มตัว (portrait)", 140, 200, Stretch.Uniform));
        body.Children.Add(pictures);
        body.Children.Add(Ui.Hint("PNG, JPEG, WebP หรือ GIF ไม่เกิน 8 MB"));
        AutomationProperties.SetAutomationId(card, "agent-pictures");
        card.Child = body;
        return card;
    }

    private FrameworkElement PictureCard(EntityList list, JsonObject agent, string slot, string label, double width, double height, Stretch stretch)
    {
        var name = agent.Str("name");
        var e = Uri.EscapeDataString(name);
        var image = new Image { Stretch = stretch, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var empty = new TextBlock { Text = "ยังไม่มีรูป", FontSize = 12, Foreground = Brush("MimiFaintBrush"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var frame = new Grid { Width = width, Height = height };
        frame.Children.Add(image);
        frame.Children.Add(empty);
        var frameBorder = new Border { Background = Brush("MimiRaisedBrush"), CornerRadius = new CornerRadius(10), Child = frame };
        var status = new TextBlock { FontSize = 11, Foreground = Brush("MimiMutedBrush"), TextWrapping = TextWrapping.Wrap };
        var buttons = new WrapPanel { HorizontalSpacing = 4, VerticalSpacing = 4 };
        var choose = new Button { Content = "เลือกรูป", FontSize = 12, Padding = new Thickness(8, 3, 8, 3) };
        var remove = new Button { Content = "ลบ", FontSize = 12, Padding = new Thickness(8, 3, 8, 3) };
        buttons.Children.Add(choose);
        buttons.Children.Add(remove);
        var card = new StackPanel { Width = width, Spacing = 5 };
        card.Children.Add(frameBorder);
        card.Children.Add(new TextBlock { Text = label, FontSize = 12, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Brush("MimiInk2Brush"), TextWrapping = TextWrapping.Wrap });
        card.Children.Add(buttons);
        card.Children.Add(status);

        async void Load()
        {
            var stamp = agent.Str(slot);
            image.Source = null;
            if (stamp.Length == 0)
            {
                empty.Visibility = Visibility.Visible;
                remove.IsEnabled = false;
                return;
            }
            empty.Visibility = Visibility.Collapsed;
            remove.IsEnabled = true;
            var bitmap = await (App.Instance?.Images.Get($"/api/agent-image/{e}/{slot}?v={Uri.EscapeDataString(stamp)}") ?? Task.FromResult<BitmapImage?>(null));
            if (bitmap is not null) image.Source = bitmap;
            else empty.Visibility = Visibility.Visible;
        }

        choose.Click += async (_, _) =>
        {
            var file = await PickImage();
            if (file is null) return;
            choose.IsEnabled = false;
            status.Foreground = Brush("MimiMutedBrush");
            status.Text = "กำลังอัปโหลด…";
            try
            {
                await using var stream = await file.OpenStreamForReadAsync();
                var type = string.IsNullOrEmpty(file.ContentType) ? "image/png" : file.ContentType;
                await session.Api.SendBody(HttpMethod.Post, $"/api/agent-image/{e}/{slot}", stream, type);
                agent[slot] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
                status.Text = "อัปโหลดแล้ว";
                Load();
                list.Refresh();
            }
            catch (Exception error) when (error is HttpRequestException or InvalidOperationException or IOException)
            {
                status.Foreground = Brush("MimiBadBrush");
                status.Text = $"อัปโหลดไม่สำเร็จ: {error.Message}";
            }
            finally
            {
                choose.IsEnabled = true;
            }
        };
        remove.Click += async (_, _) =>
        {
            if (agent.Str(slot).Length == 0) return;
            remove.IsEnabled = false;
            status.Foreground = Brush("MimiMutedBrush");
            status.Text = "กำลังลบ…";
            try
            {
                await session.Api.SendBody(HttpMethod.Delete, $"/api/agent-image/{e}/{slot}");
                agent[slot] = "";
                status.Text = "ลบแล้ว";
                Load();
                list.Refresh();
            }
            catch (Exception error) when (error is HttpRequestException or InvalidOperationException)
            {
                status.Foreground = Brush("MimiBadBrush");
                status.Text = $"ลบไม่สำเร็จ: {error.Message}";
            }
            finally
            {
                remove.IsEnabled = true;
            }
        };

        Load();
        return card;
    }

    // ---------- emoji sprites ----------

    private FrameworkElement AgentSprites(EntityList list, JsonObject agent)
    {
        var name = agent.Str("name");
        var e = Uri.EscapeDataString(name);
        var known = agent["sprites"] is JsonObject sprites ? (JsonObject)sprites.DeepClone() : new JsonObject();
        var card = new Border
        {
            Background = Brush("MimiPanelBrush"),
            BorderBrush = Brush("MimiLineBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(12, 10, 12, 12),
        };
        var body = new StackPanel { Spacing = 8 };
        body.Children.Add(Ui.Section("รูปตามอีโมจิ (sprite)"));
        body.Children.Add(Ui.Hint("agent ส่งอีโมจิตัวไหน ตัวละครจะเปลี่ยนเป็นรูปนั้น · ถ้าไม่มีรูปของอีโมจินั้นจะใช้รูปเต็มตัว"));
        var grid = new WrapPanel { HorizontalSpacing = 6, VerticalSpacing = 8 };
        var status = new TextBlock { FontSize = 11, Foreground = Brush("MimiMutedBrush"), TextWrapping = TextWrapping.Wrap };

        void Paint()
        {
            grid.Children.Clear();
            var keys = known.Select(entry => entry.Key).OrderBy(key => key, StringComparer.Ordinal).ToList();
            if (keys.Count == 0)
            {
                grid.Children.Add(Ui.Hint("ยังไม่มีรูปตามอีโมจิ"));
                return;
            }
            foreach (var key in keys)
            {
                var image = new Image { Stretch = Stretch.UniformToFill };
                var frame = new Border { Width = 72, Height = 72, Background = Brush("MimiRaisedBrush"), CornerRadius = new CornerRadius(8), Child = image };
                var stamp = known[key] is JsonValue value && value.TryGetValue<string>(out var version) ? version : "";
                _ = LoadSprite(image, $"/api/sprite/agent/{e}/{key}?v={Uri.EscapeDataString(stamp)}");
                var tile = new StackPanel { Width = 80, Spacing = 2 };
                tile.Children.Add(frame);
                tile.Children.Add(new TextBlock { Text = StageData.EmojiOf(key), FontSize = 18, HorizontalAlignment = HorizontalAlignment.Center });
                var remove = new Button { Content = "×", FontSize = 12, MinHeight = 0, Padding = new Thickness(4, 0, 4, 2), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Center };
                ToolTipService.SetToolTip(remove, "ลบรูปนี้");
                remove.Click += async (_, _) =>
                {
                    try
                    {
                        await session.Api.SendBody(HttpMethod.Delete, $"/api/sprite/agent/{e}/{key}");
                        known.Remove(key);
                        agent["sprites"] = known.DeepClone();
                        status.Text = "ลบแล้ว";
                        Paint();
                        list.Refresh();
                    }
                    catch (Exception error) when (error is HttpRequestException or InvalidOperationException)
                    {
                        status.Foreground = Brush("MimiBadBrush");
                        status.Text = $"ลบไม่สำเร็จ: {error.Message}";
                    }
                };
                tile.Children.Add(remove);
                grid.Children.Add(tile);
            }
        }

        Paint();
        body.Children.Add(grid);

        var emoji = new TextBox { PlaceholderText = "พิมพ์หรือวางอีโมจิ เช่น 😊", Width = 190 };
        var quick = new WrapPanel { HorizontalSpacing = 2, VerticalSpacing = 2 };
        foreach (var item in QuickEmoji)
        {
            var button = new Button { Content = item, FontSize = 16, MinHeight = 0, Padding = new Thickness(6, 2, 6, 2), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
            button.Click += (_, _) => emoji.Text = item;
            quick.Children.Add(button);
        }
        var choose = new Button { Content = "เลือกรูปให้อีโมจินี้", FontSize = 12, Padding = new Thickness(8, 3, 8, 3) };
        choose.Click += async (_, _) =>
        {
            var key = StageData.LastEmojiKey(emoji.Text);
            if (key is null)
            {
                status.Foreground = Brush("MimiBadBrush");
                status.Text = "ใส่อีโมจิก่อน";
                return;
            }
            var file = await PickImage();
            if (file is null) return;
            choose.IsEnabled = false;
            status.Foreground = Brush("MimiMutedBrush");
            status.Text = "กำลังอัปโหลด…";
            try
            {
                await using var stream = await file.OpenStreamForReadAsync();
                var type = string.IsNullOrEmpty(file.ContentType) ? "image/png" : file.ContentType;
                await session.Api.SendBody(HttpMethod.Post, $"/api/sprite/agent/{e}/{key}", stream, type);
                known[key] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
                agent["sprites"] = known.DeepClone();
                status.Text = $"เพิ่มรูปแล้ว {StageData.EmojiOf(key)}";
                Paint();
                list.Refresh();
            }
            catch (Exception error) when (error is HttpRequestException or InvalidOperationException or IOException)
            {
                status.Foreground = Brush("MimiBadBrush");
                status.Text = $"อัปโหลดไม่สำเร็จ: {error.Message}";
            }
            finally
            {
                choose.IsEnabled = true;
            }
        };
        var row = new WrapPanel { HorizontalSpacing = 6, VerticalSpacing = 6 };
        row.Children.Add(emoji);
        row.Children.Add(choose);
        body.Children.Add(quick);
        body.Children.Add(row);
        body.Children.Add(status);
        AutomationProperties.SetAutomationId(card, "agent-sprites");
        card.Child = body;
        return card;
    }

    private async Task LoadSprite(Image image, string path)
    {
        var bitmap = await (App.Instance?.Images.Get(path) ?? Task.FromResult<BitmapImage?>(null));
        if (bitmap is not null) image.Source = bitmap;
    }

    // ---------- per-tool permissions ----------

    private FrameworkElement AgentPermissions(JsonObject agent)
    {
        var permissions = agent["permissions"] is JsonObject existing ? (JsonObject)existing.DeepClone() : new JsonObject();
        var names = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var (key, _) in permissions) names.Add(key);
        if (agent["tools"] is JsonArray tools)
        {
            foreach (var tool in tools)
            {
                if (tool is JsonValue value && value.TryGetValue<string>(out var name) && name.Length > 0) names.Add(name);
            }
        }
        var body = new StackPanel { Spacing = 6 };
        body.Children.Add(Ui.Hint("ต่อเครื่องมือ: default = ตามนโยบายความเสี่ยง, allow = ไม่ถาม, ask = ถามทุกครั้ง, deny = ห้าม"));
        if (names.Count == 0)
        {
            body.Children.Add(Ui.Hint("เลือกเครื่องมือด้านล่างก่อน สิทธิ์ของเครื่องมือนั้นจะมาแสดงที่นี่"));
        }
        else
        {
            var filter = new TextBox { PlaceholderText = "กรองเครื่องมือ", FontSize = 12 };
            body.Children.Add(filter);
            var rows = new StackPanel { Spacing = 4 };
            body.Children.Add(rows);
            void Paint()
            {
                rows.Children.Clear();
                var query = filter.Text.Trim().ToLowerInvariant();
                foreach (var name in names)
                {
                    if (query.Length > 0 && !name.ToLowerInvariant().Contains(query)) continue;
                    var row = new Grid { ColumnSpacing = 8 };
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    row.Children.Add(new TextBlock { Text = name, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis });
                    var select = new ComboBox { Width = 110, FontSize = 12 };
                    foreach (var choice in new[] { "default", "allow", "ask", "deny" }) select.Items.Add(choice);
                    var current = permissions[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";
                    select.SelectedItem = current is "allow" or "ask" or "deny" ? current : "default";
                    select.SelectionChanged += (_, _) =>
                    {
                        if (select.SelectedItem is not string chosen) return;
                        if (chosen == "default") permissions.Remove(name);
                        else permissions[name] = chosen;
                        agent["permissions"] = permissions.DeepClone();
                    };
                    Grid.SetColumn(select, 1);
                    row.Children.Add(select);
                    rows.Children.Add(row);
                }
            }
            filter.TextChanged += (_, _) => Paint();
            Paint();
        }
        var expander = new Expander
        {
            Header = "สิทธิ์ต่อเครื่องมือ (Agent permissions)",
            IsExpanded = false,
            Content = body,
        };
        AutomationProperties.SetAutomationId(expander, "agent-permissions");
        return expander;
    }

    private async Task<StorageFile?> PickImage()
    {
        var picker = new FileOpenPicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, window());
        foreach (var extension in new[] { ".png", ".jpg", ".jpeg", ".webp", ".gif" }) picker.FileTypeFilter.Add(extension);
        return await picker.PickSingleFileAsync();
    }
}
