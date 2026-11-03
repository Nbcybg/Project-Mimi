namespace Mimi.Core.Mimiamp;

/// <summary>
/// The sound side of Mimiamp, behind an interface so the view model is tested without audio. The app's
/// player reads the song through <see cref="Net.HttpRangeStream"/> (Range + Bearer), runs it through the
/// <see cref="Equalizer"/> and plays it with WASAPI.
/// </summary>
public interface IAudioPlayer : IDisposable
{
    /// <summary>Starts a song from the beginning (a server URL, or a file: URI of this computer); throws when it cannot be opened.</summary>
    Task Play(Uri url, CancellationToken cancel = default);
    void Pause();
    void Resume();
    void Stop();
    void Seek(TimeSpan position);
    /// <summary>0–1.</summary>
    float Volume { get; set; }
    bool Playing { get; }
    TimeSpan Position { get; }
    TimeSpan Duration { get; }
    Equalizer Equalizer { get; }
    /// <summary>Left/right balance, -1..1.</summary>
    float Pan { get; set; }
    /// <summary>What went to the speakers lately, for the visualizer.</summary>
    Spectrum Spectrum { get; }
    /// <summary>The song played to its end.</summary>
    event Action? Ended;
    /// <summary>Started, paused, stopped.</summary>
    event Action? StateChanged;
}
