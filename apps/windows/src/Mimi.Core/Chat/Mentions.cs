using System.Text.RegularExpressions;

namespace Mimi.Core.Chat;

/// <summary>
/// The "@na…" members list of a group's composer (app.js renderMention): while the caret ends a word that
/// starts with @, the members whose name or shown name starts with what was typed are offered, and picking
/// one writes "@name " in its place.
/// </summary>
public static partial class Mentions
{
    [GeneratedRegex(@"(^|\s)@([\p{L}\p{M}\p{N}_-]*)$")]
    private static partial Regex Typing();

    /// <summary>The word being typed at the caret: where the name after @ starts and what is there so far; null when the caret is not in one.</summary>
    public static (int Start, string Typed)? At(string text, int caret)
    {
        if (caret < 0 || caret > text.Length) return null;
        var match = Typing().Match(text[..caret]);
        if (!match.Success) return null;
        var typed = match.Groups[2].Value;
        return (caret - typed.Length, typed);
    }

    /// <summary>The members that fit what was typed, in the order given.</summary>
    public static IReadOnlyList<(string Name, string Shown)> Options(IEnumerable<(string Name, string Shown)> members, string typed)
    {
        var lower = typed.ToLowerInvariant();
        return members.Where(member => member.Name.StartsWith(lower, StringComparison.Ordinal) || member.Shown.ToLowerInvariant().StartsWith(lower, StringComparison.Ordinal)).ToList();
    }

    /// <summary>The text with the name written over what was typed (and a space after it), and where the caret goes.</summary>
    public static (string Text, int Caret) Apply(string text, int caret, int start, string name)
    {
        caret = Math.Clamp(caret, start, text.Length);
        var written = $"{text[..start]}{name} {text[caret..]}";
        return (written, start + name.Length + 1);
    }
}
