using Microsoft.Win32;

namespace Mimi.App.Native;

/// <summary>
/// "เปิดตอนเข้าสู่ระบบ": the Run key of this Windows account. The value name is the one the Electron app
/// used (its AppUserModelId, <c>app.mimi</c>), so this app takes over that entry instead of adding a second one.
/// </summary>
internal static class StartAtLogin
{
    private const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string Name = "app.mimi";

    private static string Command => $"\"{Environment.ProcessPath}\" --background";

    public static bool Enabled
    {
        get
        {
            using var run = Registry.CurrentUser.OpenSubKey(Key);
            return run?.GetValue(Name) is string value && value.Contains(Path.GetFileName(Environment.ProcessPath!), StringComparison.OrdinalIgnoreCase);
        }
        set
        {
            using var run = Registry.CurrentUser.CreateSubKey(Key, writable: true);
            if (value) run.SetValue(Name, Command);
            else run.DeleteValue(Name, throwOnMissingValue: false);
        }
    }
}
