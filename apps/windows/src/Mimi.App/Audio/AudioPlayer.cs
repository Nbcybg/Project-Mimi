using Mimi.Core.Mimiamp;
using Mimi.Core.Net;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Mimi.App.Audio;

/// <summary>Runs Mimiamp's ten-band EQ (Mimi.Core) inside NAudio's chain.</summary>
internal sealed class EqualizedProvider : ISampleProvider
{
    private readonly ISampleProvider source;
    private readonly Equalizer equalizer;
    private readonly AudioPlayer player;

    public EqualizedProvider(ISampleProvider source, Equalizer equalizer, AudioPlayer player)
    {
        this.source = source;
        this.equalizer = equalizer;
        this.player = player;
        equalizer.Prepare(source.WaveFormat.SampleRate, source.WaveFormat.Channels);
    }

    public WaveFormat WaveFormat => source.WaveFormat;

    public int Read(float[] buffer, int offset, int count)
    {
        var read = source.Read(buffer, offset, count);
        var span = buffer.AsSpan(offset, read);
        equalizer.Process(span);
        // The balance (stereo only), then what the visualizer shows.
        var channels = WaveFormat.Channels;
        if (channels == 2 && player.Pan != 0)
        {
            var (left, right) = Spectrum.PanGains(player.Pan);
            for (var i = 0; i + 1 < span.Length; i += 2)
            {
                span[i] *= left;
                span[i + 1] *= right;
            }
        }
        player.Spectrum.Feed(span, channels, WaveFormat.SampleRate);
        return read;
    }
}

/// <summary>
/// Mimiamp's player: the song is read through <see cref="HttpRangeStream"/> (Range + Bearer: media.md 1.3,
/// on both a core and the gateway), decoded by Media Foundation (mp3, m4a/aac, wav, flac; ogg/opus/webm
/// need Windows' Web Media Extensions), run through the EQ and played with WASAPI shared mode.
/// Audio work happens off the UI thread (Media Foundation wants a free-threaded apartment).
/// </summary>
internal sealed class AudioPlayer(Func<MimiApi> api) : IAudioPlayer
{
    private readonly object gate = new();
    private WasapiOut? output;
    private WaveStream? reader;
    private HttpRangeStream? stream;
    private VolumeSampleProvider? volumeStage;
    private float volume = 0.8f;
    private bool stoppedByUs;
    private int generation;

    public Equalizer Equalizer { get; } = new();
    public Spectrum Spectrum { get; } = new();
    public float Pan { get; set; }

    public event Action? Ended;
    public event Action? StateChanged;

    public float Volume
    {
        get => volume;
        set
        {
            volume = Math.Clamp(value, 0, 1);
            lock (gate)
            {
                if (volumeStage is not null) volumeStage.Volume = volume;
            }
        }
    }

    public bool Playing
    {
        get
        {
            lock (gate) return output?.PlaybackState == PlaybackState.Playing;
        }
    }

    public TimeSpan Position
    {
        get
        {
            lock (gate)
            {
                try
                {
                    return reader?.CurrentTime ?? TimeSpan.Zero;
                }
                catch (Exception error) when (error is InvalidOperationException or System.Runtime.InteropServices.COMException)
                {
                    return TimeSpan.Zero;
                }
            }
        }
    }

    public TimeSpan Duration
    {
        get
        {
            lock (gate) return reader?.TotalTime ?? TimeSpan.Zero;
        }
    }

    public async Task Play(Uri url, CancellationToken cancel = default)
    {
        var mine = Interlocked.Increment(ref generation);
        Close();
        var client = api();
        await Task.Run(async () =>
        {
            // A song of this computer is read from disk; the server's through Range requests with the token.
            var source = url.IsFile ? null : await HttpRangeStream.Open(client.Http, (from, to) => client.RangeRequest(url, from, to), cancel).ConfigureAwait(false);
            cancel.ThrowIfCancellationRequested();
            WaveStream decoded;
            try
            {
                decoded = source is null ? new MediaFoundationReader(url.LocalPath) : new StreamMediaFoundationReader(source);
            }
            catch (Exception error)
            {
                source?.Dispose();
                throw new InvalidOperationException($"เปิดไฟล์เสียงนี้ไม่ได้ ({source?.ContentType ?? Path.GetExtension(url.LocalPath)}): {error.Message}", error);
            }
            var stage = new VolumeSampleProvider(new EqualizedProvider(decoded.ToSampleProvider(), Equalizer, this)) { Volume = volume };
            var device = new WasapiOut(AudioClientShareMode.Shared, useEventSync: true, latency: 120);
            device.Init(stage);
            lock (gate)
            {
                if (mine != generation || cancel.IsCancellationRequested)
                {
                    device.Dispose();
                    decoded.Dispose();
                    source?.Dispose();
                    return;
                }
                stream = source;
                reader = decoded;
                volumeStage = stage;
                output = device;
                stoppedByUs = false;
            }
            device.PlaybackStopped += (_, _) => OnStopped(mine);
            device.Play();
        }, cancel).ConfigureAwait(false);
        StateChanged?.Invoke();
    }

    private void OnStopped(int which)
    {
        bool ended;
        lock (gate)
        {
            if (which != generation) return;
            // Stopped by itself at the end of the song (not by pause/stop/another song).
            ended = !stoppedByUs && reader is not null && reader.TotalTime - reader.CurrentTime < TimeSpan.FromSeconds(1.5);
        }
        StateChanged?.Invoke();
        if (ended) Ended?.Invoke();
    }

    public void Pause()
    {
        lock (gate) output?.Pause();
        StateChanged?.Invoke();
    }

    public void Resume()
    {
        lock (gate)
        {
            if (output is not null && output.PlaybackState != PlaybackState.Playing) output.Play();
        }
        StateChanged?.Invoke();
    }

    public void Stop()
    {
        Interlocked.Increment(ref generation);
        Close();
        StateChanged?.Invoke();
    }

    public void Seek(TimeSpan position)
    {
        _ = Task.Run(() =>
        {
            lock (gate)
            {
                if (reader is null) return;
                var to = position < TimeSpan.Zero ? TimeSpan.Zero : position > reader.TotalTime ? reader.TotalTime : position;
                try
                {
                    reader.CurrentTime = to;
                }
                catch (Exception error) when (error is InvalidOperationException or System.Runtime.InteropServices.COMException or IOException)
                {
                }
            }
        });
    }

    private void Close()
    {
        WasapiOut? device;
        WaveStream? decoded;
        HttpRangeStream? source;
        lock (gate)
        {
            stoppedByUs = true;
            (device, decoded, source) = (output, reader, stream);
            (output, reader, stream, volumeStage) = (null, null, null, null);
        }
        if (device is null && decoded is null) return;
        // Media Foundation objects go on a free-threaded thread too.
        Task.Run(() =>
        {
            try
            {
                device?.Stop();
            }
            catch (Exception)
            {
            }
            device?.Dispose();
            decoded?.Dispose();
            source?.Dispose();
        });
    }

    public void Dispose() => Stop();
}
