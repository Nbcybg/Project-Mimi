using System.Text.RegularExpressions;

namespace Mimi.Core.Protocol;

/// <summary>
/// How message text is shown, the same rules as the web client (app.js <c>renderText</c> / <c>inline</c>):
/// ``` blocks ```, `code`, **bold**, *actions*, links and @mentions — never HTML.
/// </summary>
public abstract record Block
{
    public sealed record Code(string Text) : Block;
    public sealed record Paragraph(IReadOnlyList<Span> Spans) : Block;
}

public abstract record Span(string Text)
{
    public sealed record Plain(string Value) : Span(Value);
    public sealed record Code(string Value) : Span(Value);
    public sealed record Bold(string Value) : Span(Value);
    public sealed record Action(string Value) : Span(Value);
    public sealed record Link(string Url) : Span(Url);
    public sealed record Mention(string Value) : Span(Value);
}

public static partial class MessageFormat
{
    [GeneratedRegex(@"```(?:[\w-]*\n)?([\s\S]*?)```")]
    private static partial Regex Fence();

    [GeneratedRegex(@"(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(https?://[^\s<>""')\]]+)|(@[\p{L}\p{M}\p{N}_-]+)")]
    private static partial Regex Inline();

    public static IReadOnlyList<Block> Blocks(string text)
    {
        var blocks = new List<Block>();
        var last = 0;
        foreach (Match match in Fence().Matches(text))
        {
            var before = text[last..match.Index];
            if (!string.IsNullOrWhiteSpace(before)) blocks.Add(new Block.Paragraph(Spans(before.Trim('\n'))));
            blocks.Add(new Block.Code(match.Groups[1].Value.TrimEnd('\n')));
            last = match.Index + match.Length;
        }
        var rest = text[last..];
        if (!string.IsNullOrWhiteSpace(rest) || blocks.Count == 0) blocks.Add(new Block.Paragraph(Spans(rest.Trim('\n'))));
        return blocks;
    }

    public static IReadOnlyList<Span> Spans(string text)
    {
        var spans = new List<Span>();
        var last = 0;
        foreach (Match match in Inline().Matches(text))
        {
            if (match.Index > last) spans.Add(new Span.Plain(text[last..match.Index]));
            var part = match.Value;
            spans.Add(
                match.Groups[1].Success ? new Span.Code(part[1..^1])
                : match.Groups[2].Success ? new Span.Bold(part[2..^2])
                : match.Groups[3].Success ? new Span.Action(part[1..^1])
                : match.Groups[4].Success ? new Span.Link(part)
                : new Span.Mention(part));
            last = match.Index + match.Length;
        }
        if (last < text.Length) spans.Add(new Span.Plain(text[last..]));
        return spans;
    }

    /// <summary>
    /// A search snippet cut into plain and matched parts: every word of the query, case-insensitive,
    /// the earliest match first (app.js renderSearch).
    /// </summary>
    public static IReadOnlyList<(string Text, bool Match)> Highlight(string snippet, string query)
    {
        var terms = query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var parts = new List<(string, bool)>();
        var rest = snippet;
        while (rest.Length > 0)
        {
            var at = -1;
            var length = 0;
            foreach (var term in terms)
            {
                var found = rest.IndexOf(term, StringComparison.OrdinalIgnoreCase);
                if (found >= 0 && (at < 0 || found < at))
                {
                    at = found;
                    length = term.Length;
                }
            }
            if (at < 0)
            {
                parts.Add((rest, false));
                break;
            }
            if (at > 0) parts.Add((rest[..at], false));
            parts.Add((rest.Substring(at, length), true));
            rest = rest[(at + length)..];
        }
        return parts;
    }

    /// <summary>One line for a list or a notification: no code fences, no markup characters.</summary>
    public static string Preview(string text, int max = 160)
    {
        var flat = Regex.Replace(Speech.Parse(text).Text.Replace("```", " "), @"\s+", " ").Trim();
        flat = flat.Replace("**", "");
        return flat.Length > max ? flat[..max] + "…" : flat;
    }
}
