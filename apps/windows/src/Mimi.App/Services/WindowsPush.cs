using System.Text;
using Microsoft.Windows.PushNotifications;

namespace Mimi.App.Services;

/// <summary>
/// WNS through the Windows App SDK (push-and-background.md 2): a raw push wakes the app — or starts it in the tray
/// when it is not running — and the app fetches the text from <c>/api/notifications</c> and shows the toast
/// itself, so the words never pass through Microsoft. Without push support (an older Windows, the Windows App
/// Runtime's push service missing, a server without WNS keys) the app keeps doing what it did before: the
/// socket while it sits in the tray, and a catch-up after reconnecting.
/// </summary>
internal sealed class WindowsPush
{
    private bool listening;

    public bool Supported { get; private set; }

    /// <summary>A push arrived while the app runs (on a background thread): its raw payload.</summary>
    public event Action<string>? Received;

    /// <summary>Early in the start, before anything waits on the network (the SDK asks for it before the window).</summary>
    public void Start()
    {
        try
        {
            if (!PushNotificationManager.IsSupported()) return;
            if (!listening) PushNotificationManager.Default.PushReceived += (_, args) => Received?.Invoke(Encoding.UTF8.GetString(args.Payload));
            listening = true;
            PushNotificationManager.Default.Register();
            Supported = true;
        }
        catch (Exception)
        {
            Supported = false;
        }
    }

    /// <summary>The channel URI for the server's Entra ID app (it lives 30 days: asked again at each sign-in), or null.</summary>
    public async Task<string?> Channel(Guid remoteId)
    {
        if (!Supported) return null;
        try
        {
            var result = await PushNotificationManager.Default.CreateChannelAsync(remoteId);
            return result.Status == PushNotificationChannelStatus.CompletedSuccess ? result.Channel.Uri.AbsoluteUri : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Signed out: this computer is no longer woken for that account.</summary>
    public void Stop()
    {
        try
        {
            if (Supported) PushNotificationManager.Default.UnregisterAll();
        }
        catch (Exception)
        {
            // nothing registered
        }
        Supported = false;
    }
}
