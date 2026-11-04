using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Controls;
using Mimi.App.Services;

namespace Mimi.App.Views;

/// <summary>
/// The native parts of Settings that are not lists on the server: the account card (โปรไฟล์ของฉัน → บัญชี)
/// and the look of the app (หน้าตา) — as the web's settings page words them.
/// </summary>
internal static class SettingsSections
{
    public static FrameworkElement Account(App app)
    {
        var where = Ui.Hint("");
        var card = Ui.Card(
            Ui.Section("บัญชี"),
            where,
            Ui.Hint("ออกจากระบบบนเครื่องนี้: ต้องใส่รหัสผ่านใหม่ครั้งหน้า เลิกส่งแจ้งเตือนมาเครื่องนี้ และลบข้อมูลของ Mimi ที่แอปเก็บไว้ในเครื่องนี้"),
            Ui.Row(8,
                Ui.Button("ออกจากระบบ", () => _ = app.SignOut("logout"), id: "SignOut"),
                Ui.Button("เปลี่ยนเซิร์ฟเวอร์…", () => _ = app.SignOut("server", then: "connect"), "ghost")));
        card.Loaded += (_, _) => where.Text = app.Session.Server is null ? "" :
            $"{app.Session.Server}{(app.Session.Username.Length > 0 ? $" · {app.Session.Username}" : " · core (token)")}";
        return card;
    }

    public static FrameworkElement Appearance(App app)
    {
        var holder = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch };
        void Paint()
        {
            var config = app.Config;
            var panel = new StackPanel { Spacing = 14 };
            panel.Children.Add(Ui.Card(
                Ui.Section("ธีม"),
                Ui.Hint("เปลี่ยนแล้วเห็นทันที ทุกหน้าต่างและทุกหน้า — ค่าที่เลือกจะถูกจำไว้กับบัญชี Mimi (ไม่ใช่แค่เครื่องนี้)"),
                ThemeCards(app, Theme.Current == "light" && app.ChatThemeOverride is null ? "light" : config.Theme)));
            panel.Children.Add(Ui.Card(
                Ui.Section("ขนาดข้อความในแชต"),
                Ui.Hint("ค่าเริ่มต้นของทุกแชต (แต่ละแชตตั้งของตัวเองได้)"),
                Ui.Seg<int>([(0, "เล็ก"), (1, "ปกติ"), (2, "ใหญ่")], config.TextSize, size =>
                {
                    config.TextSize = size;
                    app.SaveConfig();
                    app.LookChanged();
                }, "textsize")));
            panel.Children.Add(Ui.Card(
                Ui.Section("ตัวละครในแชต"),
                Ui.Hint("รูปตัวละคร (2D หรือโมเดล 3D VRM) หลังแชตตัวต่อตัว เปลี่ยนตามอีโมจิในคำตอบ · ปิดเพื่ออ่านแชตได้มากขึ้น"),
                Ui.Seg<bool>([(true, "แสดง"), (false, "ซ่อน")], config.Character, on =>
                {
                    config.Character = on;
                    app.SaveConfig();
                    app.LookChanged();
                }, "character")));
            panel.Children.Add(Ui.Card(
                Ui.Section("เสียง"),
                SharedToggle(app, "mimi.autoSpeak", "อ่านคำตอบออกเสียงอัตโนมัติ", false),
                SharedToggle(app, "mimi.chatSound", "เสียงเมื่อส่ง/ได้รับข้อความ", true),
                SharedToggle(app, "mimi.notifySound", "เสียงของการแจ้งเตือน", true)));
            holder.Content = panel;
        }
        Paint();
        holder.Loaded += (_, _) => Paint();
        Theme.Changed += Paint;
        return holder;
    }

    /// <summary>The web's two theme cards: a swatch, the name and what it is for.</summary>
    private static FrameworkElement ThemeCards(App app, string current)
    {
        var grid = new Grid { ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var choices = new[] { ("dark", "มืด", "พื้นหลังเข้ม ถนอมสายตา"), ("light", "สว่าง", "สว่าง อ่านง่าย") };
        for (var i = 0; i < choices.Length; i++)
        {
            var (value, label, note) = choices[i];
            var swatch = new Grid { Height = 52 };
            swatch.Children.Add(new Border { Background = new SolidColorBrush(Theme.ColorOf("Bg", value)), CornerRadius = new CornerRadius(8) });
            swatch.Children.Add(new Border
            {
                Width = 18,
                Height = 18,
                CornerRadius = new CornerRadius(9),
                Background = new SolidColorBrush(Theme.ColorOf("Accent", value)),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(8),
            });
            var body = new StackPanel { Spacing = 4 };
            body.Children.Add(swatch);
            body.Children.Add(new TextBlock { Text = label, FontSize = 13, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Theme.Brush("Ink") });
            body.Children.Add(new TextBlock { Text = note, FontSize = 11, Foreground = Theme.Brush("Muted"), TextWrapping = TextWrapping.Wrap });
            var card = new Button
            {
                Content = body,
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Padding = new Thickness(8),
                CornerRadius = new CornerRadius(10),
                Background = Theme.Brush("Raised"),
                BorderBrush = value == current ? Theme.Brush("Accent") : Theme.Brush("Line"),
                BorderThickness = new Thickness(value == current ? 2 : 1),
            };
            card.Click += (_, _) => app.SetAppTheme(value);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(card, $"theme-{value}");
            Grid.SetColumn(card, i);
            grid.Children.Add(card);
        }
        return grid;
    }

    /// <summary>Credits, as the web's settings page lists them.</summary>
    public static FrameworkElement Credits()
    {
        var link = new HyperlinkButton
        {
            Content = "github.com/Nbcybg/Project-Mimi",
            NavigateUri = new Uri("https://github.com/Nbcybg/Project-Mimi"),
            Padding = new Thickness(0),
            FontSize = 12,
        };
        return Ui.Card(
            Ui.Section("Credits"),
            Ui.Hint("Mimi ใช้โมเดล รูป เสียง และเครื่องมือของคนอื่น — ขอบคุณทุกคนที่แบ่งปัน"),
            Ui.Row(6, new TextBlock { Text = "Coding", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, FontSize = 12, Foreground = Theme.Brush("Ink2") }, new TextBlock { Text = "DeepSeek · Claude · MiMo", FontSize = 12, Foreground = Theme.Brush("Muted") }),
            Ui.Row(6, new TextBlock { Text = "Sound", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, FontSize = 12, Foreground = Theme.Brush("Ink2") }, new TextBlock { Text = "ElevenLabs", FontSize = 12, Foreground = Theme.Brush("Muted") }),
            Ui.Row(6, new TextBlock { Text = "Image", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, FontSize = 12, Foreground = Theme.Brush("Ink2") }, new TextBlock { Text = "Anima · Krea 2", FontSize = 12, Foreground = Theme.Brush("Muted") }),
            Ui.Row(6, new TextBlock { Text = "Built with", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, FontSize = 12, Foreground = Theme.Brush("Ink2") }, new TextBlock { Text = "Node.js · TypeScript · .NET 10 · WinUI 3 / Windows App SDK · SQLite · Three.js + VRM · Vercel AI SDK · Zod", FontSize = 12, Foreground = Theme.Brush("Muted"), TextWrapping = TextWrapping.Wrap, MaxWidth = 260 }),
            Ui.Row(6, new TextBlock { Text = "Project", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, FontSize = 12, Foreground = Theme.Brush("Ink2") }, link));
    }

    /// <summary>A switch for a screen setting shared by the account's devices (ui-set, "1"/"0").</summary>
    private static ToggleSwitch SharedToggle(App app, string key, string label, bool fallback)
    {
        var value = app.Session.UiValue(key);
        var toggle = new ToggleSwitch { Header = label, IsOn = value is null ? fallback : value == "1" };
        toggle.Toggled += (_, _) => app.Session.SetUi(key, toggle.IsOn ? "1" : "0");
        return toggle;
    }
}
