namespace Mimi.Core.Mimiamp;

/// <summary>
/// Mimiamp's visualizer (the web's analyser bars): the newest samples that went to the speakers, turned into
/// a few bars on a log frequency scale. The audio thread writes, the screen reads a few times a second.
/// </summary>
public sealed class Spectrum
{
    public const int Size = 1024;
    private readonly float[] ring = new float[Size];
    private readonly object gate = new();
    private int at;
    private int sampleRate = 44100;

    /// <summary>Called by the player with interleaved samples (mixed down to mono here).</summary>
    public void Feed(ReadOnlySpan<float> samples, int channels, int rate)
    {
        sampleRate = rate;
        channels = Math.Max(1, channels);
        lock (gate)
        {
            for (var i = 0; i + channels <= samples.Length; i += channels)
            {
                var sum = 0f;
                for (var c = 0; c < channels; c++) sum += samples[i + c];
                ring[at] = sum / channels;
                at = (at + 1) % Size;
            }
        }
    }

    public void Clear()
    {
        lock (gate) Array.Clear(ring);
    }

    /// <summary><paramref name="bars"/> levels, 0–1, from 40 Hz to 16 kHz.</summary>
    public float[] Bars(int bars)
    {
        var re = new double[Size];
        var im = new double[Size];
        lock (gate)
        {
            for (var i = 0; i < Size; i++)
            {
                // Hann window over the samples in time order.
                var window = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (Size - 1));
                re[i] = ring[(at + i) % Size] * window;
            }
        }
        Fft(re, im);
        var result = new float[bars];
        var bin = (double)sampleRate / Size;
        for (var b = 0; b < bars; b++)
        {
            var low = 40 * Math.Pow(16000.0 / 40, (double)b / bars);
            var high = 40 * Math.Pow(16000.0 / 40, (double)(b + 1) / bars);
            var from = Math.Clamp((int)(low / bin), 1, Size / 2 - 1);
            var to = Math.Clamp((int)Math.Ceiling(high / bin), from + 1, Size / 2);
            var peak = 0.0;
            for (var k = from; k < to; k++) peak = Math.Max(peak, Math.Sqrt(re[k] * re[k] + im[k] * im[k]));
            // dB, -60..0 → 0..1
            var db = 20 * Math.Log10(peak / (Size / 4.0) + 1e-9);
            result[b] = (float)Math.Clamp((db + 60) / 60, 0, 1);
        }
        return result;
    }

    /// <summary>In-place radix-2 FFT.</summary>
    public static void Fft(double[] re, double[] im)
    {
        var n = re.Length;
        for (int i = 1, j = 0; i < n; i++)
        {
            var bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j)
            {
                (re[i], re[j]) = (re[j], re[i]);
                (im[i], im[j]) = (im[j], im[i]);
            }
        }
        for (var len = 2; len <= n; len <<= 1)
        {
            var angle = -2 * Math.PI / len;
            var wr = Math.Cos(angle);
            var wi = Math.Sin(angle);
            for (var i = 0; i < n; i += len)
            {
                double cr = 1, ci = 0;
                for (var k = 0; k < len / 2; k++)
                {
                    var ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                    var ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                    re[i + k + len / 2] = re[i + k] - ar;
                    im[i + k + len / 2] = im[i + k] - ai;
                    re[i + k] += ar;
                    im[i + k] += ai;
                    (cr, ci) = (cr * wr - ci * wi, cr * wi + ci * wr);
                }
            }
        }
    }

    /// <summary>Left/right balance for stereo: -1 left only … 1 right only, constant at the centre.</summary>
    public static (float Left, float Right) PanGains(float pan)
    {
        pan = Math.Clamp(pan, -1, 1);
        return (pan > 0 ? 1 - pan : 1, pan < 0 ? 1 + pan : 1);
    }
}
