using System.Globalization;
using System.Text.RegularExpressions;

namespace Mimi.Core.Protocol;

/// <summary>
/// The voice direction line an answer may start with (<c>[emotion: …][speed: 0.9]</c>), as
/// packages/shared/src/speech.ts and the web client read it. The core already strips it from
/// streamed text; the app checks again in case an older core did not.
/// </summary>
public sealed record ParsedSpeech(string Text, SpeechStyle? Speech);

public static partial class Speech
{
    [GeneratedRegex(@"\[([a-z]+)\s*:\s*([^\]\n]*)]", RegexOptions.IgnoreCase)]
    private static partial Regex Tag();

    [GeneratedRegex(@"^\s*\[(emotion|tone|voice|speed)\b", RegexOptions.IgnoreCase)]
    private static partial Regex Opening();

    private static readonly HashSet<string> Keys = ["emotion", "tone", "voice", "speed"];

    public static ParsedSpeech Parse(string source, bool live = false)
    {
        var end = source.IndexOf('\n');
        var line = end == -1 ? source : source[..end];
        var tags = Tag().Matches(line);
        // While streaming, a first line still being typed may become a direction line: hold it back.
        if (live && end == -1 && Opening().IsMatch(line)) return new ParsedSpeech("", StyleOf(tags));
        if (tags.Count == 0 || tags.Any(tag => !Keys.Contains(tag.Groups[1].Value.ToLowerInvariant()))) return new ParsedSpeech(source, null);
        if (!string.IsNullOrWhiteSpace(Tag().Replace(line, ""))) return new ParsedSpeech(source, null);
        var style = StyleOf(tags);
        if (style is null) return new ParsedSpeech(source, null);
        return new ParsedSpeech(end == -1 ? "" : source[(end + 1)..], style);
    }

    private static SpeechStyle? StyleOf(MatchCollection tags)
    {
        var style = new SpeechStyle();
        foreach (Match tag in tags)
        {
            var key = tag.Groups[1].Value.ToLowerInvariant();
            var value = tag.Groups[2].Value.Trim();
            if (value.Length == 0) continue;
            var cut = value.Length > 80 ? value[..80] : value;
            style = key switch
            {
                "emotion" when style.Emotion is null => style with { Emotion = cut },
                "tone" when style.Tone is null => style with { Tone = cut },
                "voice" when style.Voice is null => style with { Voice = cut },
                "speed" when double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var speed) => style with { Speed = Math.Clamp(speed, 0.5, 2.0) },
                _ => style,
            };
        }
        return style == new SpeechStyle() ? null : style;
    }
}
