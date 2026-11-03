using NAudio.Wave;

namespace Mimi.App.Services;

/// <summary>The chat's sounds (media.md 6), bundled with the app: sent, answer done, permission asked.</summary>
internal static class Sounds
{
    public static void Play(string what)
    {
        var name = what switch { "sent" => "chat_1.mp3", "done" => "chat_2.mp3", "permission" => "chat_3.mp3", _ => null };
        if (name is null) return;
        var file = Path.Combine(AppContext.BaseDirectory, "Assets", name);
        if (!File.Exists(file)) return;
        Task.Run(() =>
        {
            try
            {
                using var reader = new MediaFoundationReader(file);
                using var output = new WasapiOut();
                output.Init(new NAudio.Wave.SampleProviders.VolumeSampleProvider(reader.ToSampleProvider()) { Volume = 0.6f });
                output.Play();
                while (output.PlaybackState == PlaybackState.Playing) Thread.Sleep(50);
            }
            catch (Exception)
            {
                // no sound device: the chat works without
            }
        });
    }
}
