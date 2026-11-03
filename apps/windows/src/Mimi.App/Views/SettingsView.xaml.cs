using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Mimi.Core.Desktop;

namespace Mimi.App.Views;

/// <summary>The choices of this computer — the same ones as the tray menu (remote.cjs buildMenu).</summary>
public sealed partial class SettingsView : UserControl
{
    private readonly App app;
    private bool loading;

    internal SettingsView(App app)
    {
        this.app = app;
        InitializeComponent();
        foreach (var minutes in AppConfig.LockChoices) AutoLock.Items.Add(minutes == 0 ? "ปิด" : $"ไม่ได้ใช้ {minutes} นาที");
        Loaded += (_, _) => Refresh();
    }

    /// <summary>Fills the screen from the current state (each time it is shown).</summary>
    public void Refresh()
    {
        loading = true;
        var config = app.Config;
        AtLogin.IsOn = Native.StartAtLogin.Enabled;
        AutoLock.SelectedIndex = Array.IndexOf(AppConfig.LockChoices, config.AutoLockMinutes);
        HideOnBlur.IsOn = config.Window.HideOnBlur;
        OnTop.IsOn = config.Window.OnTop;
        PcAgent.IsOn = config.PcAgent.Enabled;
        PcShell.IsOn = config.PcAgent.Shell;
        PcShell.IsEnabled = config.PcAgent.Enabled;
        PcStatus.Text = $"สถานะ: {app.PcStatus}";
        Folders.Items.Clear();
        foreach (var folder in config.PcAgent.Folders) Folders.Items.Add(folder);
        Version.Text = $"Mimi สำหรับ Windows {App.Version}" + (app.Session.Server is null ? "" : $" · เซิร์ฟเวอร์ API {app.Session.CoreApi}");
        Update.Visibility = app.PendingUpdate is null ? Visibility.Collapsed : Visibility.Visible;
        Update.Content = app.PendingUpdate is { } update ? $"อัปเดตเป็น {update.Version}" : "อัปเดต";
        loading = false;
    }

    private void OnAtLogin(object sender, RoutedEventArgs e)
    {
        if (!loading) Native.StartAtLogin.Enabled = AtLogin.IsOn;
    }

    private void OnAutoLock(object sender, SelectionChangedEventArgs e)
    {
        if (loading || AutoLock.SelectedIndex < 0) return;
        app.Config.AutoLockMinutes = AppConfig.LockChoices[AutoLock.SelectedIndex];
        app.SaveConfig();
    }

    private void OnHideOnBlur(object sender, RoutedEventArgs e)
    {
        if (loading) return;
        app.Config.Window.HideOnBlur = HideOnBlur.IsOn;
        app.SaveConfig();
    }

    private void OnOnTop(object sender, RoutedEventArgs e)
    {
        if (!loading) app.SetOnTop(OnTop.IsOn);
    }

    private async void OnPcAgent(object sender, RoutedEventArgs e)
    {
        if (loading) return;
        await app.SetPcAgent(PcAgent.IsOn);
        Refresh();
    }

    private async void OnPcShell(object sender, RoutedEventArgs e)
    {
        if (loading) return;
        await app.SetPcShell(PcShell.IsOn);
        Refresh();
    }

    private async void OnAddFolder(object sender, RoutedEventArgs e)
    {
        await app.AddFolder();
        Refresh();
    }

    private async void OnRemoveFolder(object sender, RoutedEventArgs e)
    {
        if (Folders.SelectedItem is string folder) await app.RemoveFolder(folder);
        Refresh();
    }

    private void OnUpdate(object sender, RoutedEventArgs e) => _ = app.InstallUpdate();

    private void OnOpenWeb(object sender, RoutedEventArgs e) => app.OpenWeb();
}
