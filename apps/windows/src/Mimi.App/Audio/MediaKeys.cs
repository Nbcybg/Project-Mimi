using Windows.Media;
using Windows.Media.Playback;

namespace Mimi.App.Audio;

/// <summary>
/// The media keys and the volume flyout / lock screen card (System Media Transport Controls), media.md 1.5.
/// A desktop app gets its own controls from an idle MediaPlayer whose command manager is switched off;
/// the sound itself plays through <see cref="AudioPlayer"/>.
/// </summary>
internal sealed class MediaKeys : IDisposable
{
    private readonly MediaPlayer holder = new();
    private readonly SystemMediaTransportControls controls;

    public event Action? PlayPause;
    public event Action? Next;
    public event Action? Previous;
    public event Action? Stop;

    public MediaKeys()
    {
        holder.CommandManager.IsEnabled = false;
        controls = holder.SystemMediaTransportControls;
        controls.IsEnabled = true;
        controls.IsPlayEnabled = true;
        controls.IsPauseEnabled = true;
        controls.IsNextEnabled = true;
        controls.IsPreviousEnabled = true;
        controls.IsStopEnabled = true;
        controls.ButtonPressed += (_, args) =>
        {
            switch (args.Button)
            {
                case SystemMediaTransportControlsButton.Play:
                case SystemMediaTransportControlsButton.Pause:
                    PlayPause?.Invoke();
                    break;
                case SystemMediaTransportControlsButton.Next:
                    Next?.Invoke();
                    break;
                case SystemMediaTransportControlsButton.Previous:
                    Previous?.Invoke();
                    break;
                case SystemMediaTransportControlsButton.Stop:
                    Stop?.Invoke();
                    break;
            }
        };
    }

    public void Show(string title, string artist, bool playing)
    {
        var display = controls.DisplayUpdater;
        display.Type = MediaPlaybackType.Music;
        display.MusicProperties.Title = title;
        display.MusicProperties.Artist = artist;
        display.MusicProperties.AlbumTitle = "Mimiamp";
        display.Update();
        controls.PlaybackStatus = title.Length == 0 ? MediaPlaybackStatus.Closed : playing ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;
    }

    public void Dispose()
    {
        controls.IsEnabled = false;
        holder.Dispose();
    }
}
