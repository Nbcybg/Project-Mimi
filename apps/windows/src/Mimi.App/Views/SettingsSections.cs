using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core;

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

    /// <summary>
    /// The language of the app (the web's settings → หน้าตาและภาษา): Thai or English, shared by the account's devices
    /// (<c>mimi.lang</c>). As on the web, only the texts that have a translation change; the rest stays Thai.
    /// </summary>
    private static FrameworkElement Language(App app)
    {
        return Ui.Card(
            Ui.Section(Loc.T("ภาษา")),
            Ui.Hint("ภาษาของหน้าจอและปุ่มในแอปเท่านั้น — agent ดูจากข้อความที่คุยและ system prompt เอง ไม่ได้ใช้ค่านี้เลือกภาษา"),
            Ui.Seg<string>(Loc.Languages.Select(language => (language.Code, language.Name)).ToList(), Loc.Language, code =>
            {
                Loc.Set(code);
                app.Session.SetUi("mimi.lang", code);
            }, "language"),
            Ui.Hint("มีผลกับข้อความที่แปลแล้วในหน้าที่เปิดใหม่ — เปิดแอปใหม่เพื่อให้ครบทุกหน้า"));
    }

    public static FrameworkElement Appearance(App app)
    {
        var holder = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch };
        void Paint()
        {
            var config = app.Config;
            var panel = new StackPanel { Spacing = 14 };
            panel.Children.Add(Language(app));
            panel.Children.Add(Ui.Card(
                Ui.Section("ธีมของแอป"),
                Ui.Hint("สีของทั้งแอป: เมนู แชต หน้าตั้งค่า และปุ่มต่าง ๆ · แต่ละห้องแชตตั้งธีมแยกได้ที่ \"ข้อมูล → หน้าตา\""),
                ThemeCards(app, Theme.Current == "light" && app.ChatThemeOverride is null ? "light" : config.Theme),
                Ui.Hint("ธีมนี้แชร์ให้ทุกเครื่องที่เข้าบัญชีเดียวกัน — ธีมเฉพาะห้องแชตยังอยู่ที่เครื่องนั้น")));
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
                Ui.Section(Loc.T("เสียง")),
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
        // The web's cards (app.css .themecard): a 135° gradient with "Aa" on it, the name, what it is like.
        var choices = new[]
        {
            ("light", "สว่าง", "ชมพูอ่อน กระดาษอุ่น อ่านสบาย", ("#fffafc", "#f8ebf0", "#cb6b8a"), "#3d2533"),
            ("dark", "มืด", "พลัมเข้ม โรส ตัดกับตัวละคร", ("#171215", "#33202e", "#e08aa7"), "#ffffff"),
        };
        for (var i = 0; i < choices.Length; i++)
        {
            var (value, label, note, stops, aa) = choices[i];
            var swatch = new Grid { Height = 58, CornerRadius = new CornerRadius(9) };
            swatch.Children.Add(new Border
            {
                CornerRadius = new CornerRadius(9),
                BorderBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(31, 0, 0, 0)),
                BorderThickness = new Thickness(1),
                Background = new LinearGradientBrush
                {
                    StartPoint = new Windows.Foundation.Point(0, 0),
                    EndPoint = new Windows.Foundation.Point(1, 1),
                    GradientStops =
                    {
                        new GradientStop { Color = Theme.Parse(stops.Item1)!.Value, Offset = 0 },
                        new GradientStop { Color = Theme.Parse(stops.Item2)!.Value, Offset = 0.52 },
                        new GradientStop { Color = Theme.Parse(stops.Item3)!.Value, Offset = 1 },
                    },
                },
            });
            swatch.Children.Add(new TextBlock
            {
                Text = "Aa",
                FontSize = 13,
                FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Theme.Parse(aa)!.Value),
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(10, 0, 0, 8),
            });
            var body = new StackPanel { Spacing = 5 };
            body.Children.Add(swatch);
            body.Children.Add(new TextBlock { Text = label, FontSize = 13, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Theme.Brush("Ink") });
            body.Children.Add(new TextBlock { Text = note, FontSize = 11.5, Foreground = Theme.Brush("Muted"), TextWrapping = TextWrapping.Wrap });
            var card = new Button
            {
                Content = body,
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Padding = new Thickness(7),
                CornerRadius = new CornerRadius(13),
                Background = Theme.Brush("Bg"),
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

    /// <summary>Credits in a window of their own (the web's creditsDialog), from the button at the head of Settings.</summary>
    public static async Task ShowCredits(App app)
    {
        if (app.DialogRoot is not { } root) return;
        var dialog = new ContentDialog
        {
            XamlRoot = root,
            RequestedTheme = Theme.Element,
            Content = new ScrollViewer { Content = Credits(), MaxHeight = 520, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
            CloseButtonText = Loc.T("ปิด"),
        };
        await dialog.ShowAsync();
    }

    /// <summary>
    /// Google, Microsoft, mail and the search keys are set in one place, the Hub's accounts (several at once);
    /// the settings only point there, as the web's do.
    /// </summary>
    public static FrameworkElement HubShortcut(App app) => Ui.Card(
        Ui.Section("บัญชีและคีย์บริการภายนอก"),
        Ui.Hint("Gmail, Outlook, ปฏิทิน, คีย์ค้นหา และคีย์พยากรณ์อากาศ ตั้งที่เดียวที่ Hub → บัญชี (ใช้ได้หลายบัญชีพร้อมกัน)"),
        Ui.Button("ไปที่ Hub → บัญชี", () => app.ShowHub("accounts"), "ghost", "goto-hub-accounts"));

    /// <summary>A switch for a screen setting shared by the account's devices (ui-set, "1"/"0").</summary>
    private static ToggleSwitch SharedToggle(App app, string key, string label, bool fallback)
    {
        var value = app.Session.UiValue(key);
        var toggle = new ToggleSwitch { Header = label, IsOn = value is null ? fallback : value == "1" };
        toggle.Toggled += (_, _) => app.Session.SetUi(key, toggle.IsOn ? "1" : "0");
        return toggle;
    }
}
