import Foundation

/// The voice direction line an answer may start with (`[emotion: …][speed: 0.9]`), as
/// packages/shared/src/speech.ts and the other apps read it. The core already strips it from
/// streamed text; the app checks again in case an older core did not.
public enum Speech {
    private static let tag = try! NSRegularExpression(pattern: #"\[([a-z]+)\s*:\s*([^\]\n]*)]"#, options: [.caseInsensitive])
    private static let opening = try! NSRegularExpression(pattern: #"^\s*\[(emotion|tone|voice|speed)\b"#, options: [.caseInsensitive])
    private static let keys: Set<String> = ["emotion", "tone", "voice", "speed"]

    public static func parse(_ source: String, live: Bool = false) -> (text: String, speech: SpeechStyle?) {
        let newline = source.firstIndex(of: "\n")
        let line = newline.map { String(source[..<$0]) } ?? source
        let range = NSRange(line.startIndex..., in: line)
        let tags = tag.matches(in: line, range: range)
        // While streaming, a first line still being typed may become a direction line: hold it back.
        if live, newline == nil, opening.firstMatch(in: line, range: range) != nil { return ("", style(tags, line)) }
        let names = tags.map { (line as NSString).substring(with: $0.range(at: 1)).lowercased() }
        if tags.isEmpty || names.contains(where: { !keys.contains($0) }) { return (source, nil) }
        let rest = tag.stringByReplacingMatches(in: line, range: range, withTemplate: "")
        if !rest.trimmingCharacters(in: .whitespaces).isEmpty { return (source, nil) }
        guard let style = style(tags, line) else { return (source, nil) }
        return (newline.map { String(source[source.index(after: $0)...]) } ?? "", style)
    }

    private static func style(_ tags: [NSTextCheckingResult], _ line: String) -> SpeechStyle? {
        var style = SpeechStyle()
        let text = line as NSString
        for match in tags {
            let key = text.substring(with: match.range(at: 1)).lowercased()
            let value = text.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespaces)
            if value.isEmpty { continue }
            let cut = String(value.prefix(80))
            switch key {
            case "emotion" where style.emotion == nil: style.emotion = cut
            case "tone" where style.tone == nil: style.tone = cut
            case "voice" where style.voice == nil: style.voice = cut
            case "speed": if let speed = Double(value) { style.speed = min(2.0, max(0.5, speed)) }
            default: break
            }
        }
        return style.isEmpty ? nil : style
    }
}

/// How message text is shown, the same rules as the web client (app.js `renderText` / `inline`):
/// ``` blocks ```, `code`, **bold**, *actions*, links and @mentions — never HTML.
public enum Block: Equatable, Sendable {
    case code(String)
    case paragraph([Span])
}

public enum Span: Equatable, Sendable {
    case plain(String)
    case code(String)
    case bold(String)
    case action(String)
    case link(String)
    case mention(String)
}

public enum MessageFormat {
    private static let fence = try! NSRegularExpression(pattern: #"```(?:[\w-]*\n)?([\s\S]*?)```"#)
    private static let inline = try! NSRegularExpression(pattern: #"(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(https?://[^\s<>"')\]]+)|(@[\p{L}\p{M}\p{N}_-]+)"#)

    public static func blocks(_ text: String) -> [Block] {
        var blocks: [Block] = []
        let ns = text as NSString
        var last = 0
        for match in fence.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let before = ns.substring(with: NSRange(location: last, length: match.range.location - last))
            if !before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { blocks.append(.paragraph(spans(before.trimmingCharacters(in: .newlines)))) }
            var code = ns.substring(with: match.range(at: 1))
            while code.hasSuffix("\n") { code.removeLast() }
            blocks.append(.code(code))
            last = match.range.location + match.range.length
        }
        let rest = ns.substring(from: last)
        if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || blocks.isEmpty { blocks.append(.paragraph(spans(rest.trimmingCharacters(in: .newlines)))) }
        return blocks
    }

    public static func spans(_ text: String) -> [Span] {
        var spans: [Span] = []
        let ns = text as NSString
        var last = 0
        for match in inline.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > last { spans.append(.plain(ns.substring(with: NSRange(location: last, length: match.range.location - last)))) }
            let part = ns.substring(with: match.range)
            let inner = { (cut: Int) in String(part.dropFirst(cut).dropLast(cut)) }
            if match.range(at: 1).location != NSNotFound { spans.append(.code(inner(1))) }
            else if match.range(at: 2).location != NSNotFound { spans.append(.bold(inner(2))) }
            else if match.range(at: 3).location != NSNotFound { spans.append(.action(inner(1))) }
            else if match.range(at: 4).location != NSNotFound { spans.append(.link(part)) }
            else { spans.append(.mention(part)) }
            last = match.range.location + match.range.length
        }
        if last < ns.length { spans.append(.plain(ns.substring(from: last))) }
        return spans
    }

    /// One line for a list or a notification: no code fences, no markup characters.
    public static func preview(_ text: String, max: Int = 160) -> String {
        let flat = Speech.parse(text).text.replacingOccurrences(of: "```", with: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "**", with: "")
        return flat.count > max ? String(flat.prefix(max)) + "…" : flat
    }
}
