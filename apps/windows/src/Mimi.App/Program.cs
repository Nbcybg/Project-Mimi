using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Mimi.App;

/// <summary>
/// One Mimi per Windows account (remote.cjs requestSingleInstanceLock): a second start hands its
/// activation to the running app, which shows its window, and ends.
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        // A test install with its own folders (MIMI_WINDOWS_HOME) is its own instance.
        var home = Environment.GetEnvironmentVariable("MIMI_WINDOWS_HOME");
        var instance = AppInstance.FindOrRegisterForKey(string.IsNullOrEmpty(home) ? "app.mimi.windows" : $"app.mimi.windows.{Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(home.ToLowerInvariant())))[..12]}");
        if (!instance.IsCurrent)
        {
            var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            // Waiting on the STA would block the hand-over; wait from another thread.
            Task.Run(() => instance.RedirectActivationToAsync(activation).AsTask()).Wait();
            return 0;
        }
        Application.Start(callback =>
        {
            SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App(instance, args);
        });
        return 0;
    }
}
