namespace Mimi.Core.Mimiamp;

/// <summary>
/// Mimiamp's ten-band EQ, the same as the web player (feature-mimiamp.js EQ_BANDS / EQ_PRESETS): peaking
/// filters with Q = 1 at 60 Hz … 16 kHz, ±12 dB each, plus a stereo pan. Plain maths on float samples,
/// so the Windows player can run it in its audio chain and the tests can measure it.
/// </summary>
public sealed class Equalizer
{
    public static readonly int[] Bands = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

    public static readonly string[] BandLabels = ["60", "170", "310", "600", "1K", "3K", "6K", "12K", "14K", "16K"];

    public static readonly IReadOnlyDictionary<string, float[]> Presets = new Dictionary<string, float[]>
    {
        ["Flat"] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ["Classical"] = [0, 0, 0, 0, 0, 0, -4.8f, -4.8f, -4.8f, -6],
        ["Club"] = [0, 0, 4.8f, 3.6f, 3.6f, 3.6f, 2.4f, 0, 0, 0],
        ["Dance"] = [5.8f, 4.8f, 3, 0, 0, -3, -4.8f, -4.8f, 0, 0],
        ["Full Bass"] = [7.2f, 7.2f, 7.2f, 5.4f, 3.6f, 0, -3.6f, -5.4f, -6, -6.6f],
        ["Full Bass & Treble"] = [5.4f, 4.8f, 4.2f, 2.4f, 0, -3.6f, -4.8f, -4.8f, 2.4f, 5.4f],
        ["Full Treble"] = [-6, -6, -6, -4.2f, -1.2f, 3.6f, 7.2f, 8.4f, 8.4f, 8.4f],
        ["Headphones"] = [3.6f, 4.8f, 2.4f, 0, -1.8f, 0, 2.4f, 5.4f, 6.6f, 7.2f],
        ["Large Hall"] = [6, 6, 3.6f, 3.6f, 0, -3.6f, -3.6f, -3.6f, 0, 0],
        ["Live"] = [-3.6f, 0, 2.4f, 3.6f, 4.2f, 4.2f, 3, 2.4f, 2.4f, 2.4f],
        ["Party"] = [4.8f, 4.8f, 0, 0, 0, 0, 0, 0, 4.8f, 4.8f],
        ["Pop"] = [-1.2f, 3, 4.8f, 4.8f, 3.6f, 0, -1.8f, -1.8f, -1.2f, -1.2f],
        ["Reggae"] = [0, 0, 0, -3, 0, 4.2f, 4.2f, 0, 0, 0],
        ["Rock"] = [5.4f, 3.6f, -2.4f, -3.6f, -1.8f, 2.4f, 5.4f, 6.6f, 6.6f, 6.6f],
        ["Ska"] = [-1.8f, -3.6f, -2.4f, 0, 2.4f, 3.6f, 5.4f, 5.4f, 6.6f, 6],
        ["Soft"] = [3, 0, -1.2f, -2.4f, -1.8f, 0, 2.4f, 4.8f, 5.4f, 5.4f],
        ["Soft Rock"] = [2.4f, 2.4f, 1.2f, 0, -2.4f, -3, -1.8f, 0, 2.4f, 4.2f],
        ["Techno"] = [4.8f, 3.6f, 0, -3.6f, -3, 0, 4.8f, 5.4f, 5.4f, 4.8f],
        ["Vocal"] = [-1.8f, -3, -3, 0, 3.6f, 4.8f, 4.8f, 3.6f, 0, -1.8f],
        ["Bass Boost"] = [9, 7.2f, 4.8f, 2.4f, 0, 0, 0, 0, 0, 0],
        ["Treble Boost"] = [0, 0, 0, 0, 0, 2.4f, 5.4f, 7.2f, 7.8f, 8.4f],
    };

    private readonly object gate = new();
    private readonly float[] gains = new float[Bands.Length];
    private Biquad[][] filters = [];
    private int sampleRate;
    private int channels;
    private bool enabled;
    private float pan;

    public bool Enabled
    {
        get => enabled;
        set
        {
            lock (gate) enabled = value;
        }
    }

    /// <summary>-1 (left) … 1 (right).</summary>
    public float Pan
    {
        get => pan;
        set
        {
            lock (gate) pan = Math.Clamp(value, -1, 1);
        }
    }

    public float[] Gains
    {
        get
        {
            lock (gate) return (float[])gains.Clone();
        }
    }

    public void SetGain(int band, float db)
    {
        lock (gate)
        {
            gains[band] = Math.Clamp(db, -12, 12);
            Rebuild();
        }
    }

    public void SetGains(IReadOnlyList<float> values)
    {
        lock (gate)
        {
            for (var i = 0; i < gains.Length; i++) gains[i] = i < values.Count ? Math.Clamp(values[i], -12, 12) : 0;
            Rebuild();
        }
    }

    /// <summary>Called by the player when the format of the audio changes.</summary>
    public void Prepare(int rate, int channelCount)
    {
        lock (gate)
        {
            sampleRate = rate;
            channels = channelCount;
            Rebuild();
        }
    }

    private void Rebuild()
    {
        if (sampleRate <= 0 || channels <= 0)
        {
            filters = [];
            return;
        }
        var next = new Biquad[channels][];
        for (var c = 0; c < channels; c++)
        {
            next[c] = new Biquad[Bands.Length];
            for (var b = 0; b < Bands.Length; b++)
            {
                var filter = Biquad.Peaking(sampleRate, Bands[b], 1.0, gains[b]);
                // Keep the running state of the old filter so a slider move does not click.
                if (filters.Length == channels) filter.TakeStateFrom(filters[c][b]);
                next[c][b] = filter;
            }
        }
        filters = next;
    }

    /// <summary>Runs the EQ and the pan over interleaved samples in place.</summary>
    public void Process(Span<float> samples)
    {
        lock (gate)
        {
            if (channels <= 0) return;
            var eq = enabled && filters.Length == channels;
            var (left, right) = channels == 2 && pan != 0 ? (Math.Min(1, 1 - pan), Math.Min(1, 1 + pan)) : (1f, 1f);
            for (var i = 0; i < samples.Length; i++)
            {
                var c = i % channels;
                var value = samples[i];
                if (eq)
                {
                    foreach (var filter in filters[c]) value = filter.Run(value);
                }
                if (channels == 2) value *= c == 0 ? left : right;
                samples[i] = value;
            }
        }
    }

    /// <summary>The gain in dB the EQ applies at one frequency (for tests and a curve on screen).</summary>
    public double ResponseDb(double frequency)
    {
        lock (gate)
        {
            if (sampleRate <= 0) return 0;
            var total = 0.0;
            for (var b = 0; b < Bands.Length; b++) total += Biquad.Peaking(sampleRate, Bands[b], 1.0, gains[b]).MagnitudeDb(frequency, sampleRate);
            return total;
        }
    }

    /// <summary>One second-order filter (RBJ audio EQ cookbook), direct form I.</summary>
    internal sealed class Biquad
    {
        private double b0, b1, b2, a1, a2;
        private double x1, x2, y1, y2;

        public static Biquad Peaking(int rate, double frequency, double q, double gainDb)
        {
            // Above Nyquist the band does nothing (a 16 kHz band at a 22.05 kHz rate).
            var f = Math.Min(frequency, rate * 0.49);
            var a = Math.Pow(10, gainDb / 40);
            var w0 = 2 * Math.PI * f / rate;
            var alpha = Math.Sin(w0) / (2 * q);
            var cos = Math.Cos(w0);
            var a0 = 1 + alpha / a;
            return new Biquad
            {
                b0 = (1 + alpha * a) / a0,
                b1 = -2 * cos / a0,
                b2 = (1 - alpha * a) / a0,
                a1 = -2 * cos / a0,
                a2 = (1 - alpha / a) / a0,
            };
        }

        public void TakeStateFrom(Biquad other) => (x1, x2, y1, y2) = (other.x1, other.x2, other.y1, other.y2);

        public float Run(float input)
        {
            var output = b0 * input + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = input;
            y2 = y1;
            y1 = output;
            return (float)output;
        }

        public double MagnitudeDb(double frequency, int rate)
        {
            var w = 2 * Math.PI * frequency / rate;
            var (cos1, sin1, cos2, sin2) = (Math.Cos(w), Math.Sin(w), Math.Cos(2 * w), Math.Sin(2 * w));
            var numRe = b0 + b1 * cos1 + b2 * cos2;
            var numIm = -(b1 * sin1 + b2 * sin2);
            var denRe = 1 + a1 * cos1 + a2 * cos2;
            var denIm = -(a1 * sin1 + a2 * sin2);
            var magnitude = Math.Sqrt((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm));
            return 20 * Math.Log10(magnitude);
        }
    }
}
