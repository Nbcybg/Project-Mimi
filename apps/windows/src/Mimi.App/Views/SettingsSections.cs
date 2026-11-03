using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
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
                Ui.Hint("ใช้กับทุกหน้าของแอป และทุกเครื่องของบัญชีนี้ — แชตไหนอยากต่างไป ตั้งได้ที่ \"ข้อมูล → หน้าตา\" ในแชตนั้น"),
                Ui.Seg<string>([("dark", "มืด"), ("light", "สว่าง")], Theme.Current == "light" && app.ChatThemeOverride is null ? "light" : config.Theme, theme => app.SetAppTheme(theme), "theme")));
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

    /// <summary>A switch for a screen setting shared by the account's devices (ui-set, "1"/"0").</summary>
    private static ToggleSwitch SharedToggle(App app, string key, string label, bool fallback)
    {
        var value = app.Session.UiValue(key);
        var toggle = new ToggleSwitch { Header = label, IsOn = value is null ? fallback : value == "1" };
        toggle.Toggled += (_, _) => app.Session.SetUi(key, toggle.IsOn ? "1" : "0");
        return toggle;
    }
}
