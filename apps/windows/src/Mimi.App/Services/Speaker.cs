using Mimi.Core.Protocol;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Media.SpeechSynthesis;

namespace Mimi.App.Services;

/// <summary>
/// Reads answers aloud with the voices of Windows (feature-inventory #20; the web uses the browser's speech).
/// A Thai voice is used when Windows has one (Settings → Time &amp; language → Speech); a new answer stops the last.
/// </summary>
internal sealed class Speaker : IDisposable
{
    private readonly SpeechSynthesizer synthesizer = new();
    private readonly MediaPlayer player = new();

    public Speaker()
    {
        var thai = SpeechSynthesizer.AllVoices.FirstOrDefault(voice => voice.Language.StartsWith("th", StringComparison.OrdinalIgnoreCase));
        if (thai is not null) synthesizer.Voice = thai;
    }

    /// <summary>True when Windows has a Thai voice; otherwise Thai text is read by the default voice (badly).</summary>
    public bool HasThai => synthesizer.Voice.Language.StartsWith("th", StringComparison.OrdinalIgnoreCase);

    public async Task Say(string text, SpeechStyle? style)
    {
        var plain = MessageFormat.Preview(text, 4000);
        if (plain.Length == 0) return;
        synthesizer.Options.SpeakingRate = Math.Clamp(style?.Speed ?? 1.0, 0.5, 2.0);
        var stream = await synthesizer.SynthesizeTextToStreamAsync(plain);
        player.Source = MediaSource.CreateFromStream(stream, stream.ContentType);
        player.Play();
    }

    public void Stop() => player.Pause();

    public void Dispose()
    {
        player.Dispose();
        synthesizer.Dispose();
    }
}
