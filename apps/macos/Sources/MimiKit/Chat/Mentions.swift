import Foundation

/// The "@na…" members list of a group's composer (app.js renderMention, Mentions.cs): while the text ends in
/// a word that starts with @, the members whose name or shown name starts with what was typed are offered.
public enum Mentions {
    private static let typing = try! NSRegularExpression(pattern: #"(^|\s)@([\p{L}\p{M}\p{N}_-]*)$"#)

    /// What was typed after the @ at the end of `text`, or nil when the text does not end in an @-word.
    public static func typed(_ text: String) -> String? {
        let ns = text as NSString
        guard let match = typing.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: match.range(at: 2))
    }

    public static func options(_ members: [(name: String, shown: String)], typed: String) -> [(name: String, shown: String)] {
        let lower = typed.lowercased()
        return members.filter { $0.name.hasPrefix(lower) || $0.shown.lowercased().hasPrefix(lower) }
    }

    /// The text with the name written over what was typed, and a space after it.
    public static func apply(_ text: String, name: String) -> String {
        guard let typed = typed(text) else { return text }
        return String(text.dropLast(typed.count)) + name + " "
    }
}
