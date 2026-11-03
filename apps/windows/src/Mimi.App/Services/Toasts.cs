using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace Mimi.App.Services;

/// <summary>
/// Windows notifications (toasts) through the Windows App SDK. Until WNS exists on the server
/// (push-and-background.md 2: "Windows: tray + WS first"), they come from the open socket while the app
/// sits in the tray, and from <c>/api/notifications?afterId=</c> after a reconnect.
/// A click opens the chat (argument <c>chat=&lt;id&gt;</c>).
/// </summary>
internal sealed class Toasts : IDisposable
{
    private bool registered;

    public event Action<long?>? Opened;

    public void Register()
    {
        try
        {
            AppNotificationManager.Default.NotificationInvoked += (_, args) =>
            {
                long? chat = args.Arguments.TryGetValue("chat", out var value) && long.TryParse(value, out var id) ? id : null;
                Opened?.Invoke(chat);
            };
            AppNotificationManager.Default.Register();
            registered = true;
        }
        catch (Exception)
        {
            // No notifications on this Windows (or a policy blocks them): the app works without.
            registered = false;
        }
    }

    public void Show(string title, string body, long? chatId)
    {
        if (!registered) return;
        try
        {
            var builder = new AppNotificationBuilder().AddText(title.Length > 0 ? title : "Mimi");
            if (body.Length > 0) builder.AddText(body.Length > 300 ? body[..300] + "…" : body);
            builder.AddArgument("chat", chatId?.ToString() ?? "");
            AppNotificationManager.Default.Show(builder.BuildNotification());
        }
        catch (Exception)
        {
        }
    }

    /// <summary>Clears this app's notifications (signing out).</summary>
    public void Clear()
    {
        if (!registered) return;
        try
        {
            _ = AppNotificationManager.Default.RemoveAllAsync();
        }
        catch (Exception)
        {
        }
    }

    public void Dispose()
    {
        if (!registered) return;
        try
        {
            AppNotificationManager.Default.Unregister();
        }
        catch (Exception)
        {
        }
    }
}
