package app.mimi.core.ui

/**
 * How message text is shown, the same rules as the web client (app.js `renderText` / `inline`):
 * ``` blocks ```, `code`, **bold**, *actions*, links and @mentions — never HTML.
 */
sealed interface Block {
    data class Code(val text: String) : Block
    data class Paragraph(val spans: List<Span>) : Block
}

sealed interface Span {
    data class Plain(val text: String) : Span
    data class Code(val text: String) : Span
    data class Bold(val text: String) : Span
    data class Action(val text: String) : Span
    data class Link(val url: String) : Span
    data class Mention(val text: String) : Span
}

private val FENCE = Regex("```(?:[\\w-]*\\n)?([\\s\\S]*?)```")
private val INLINE = Regex("(`[^`\\n]+`)|(\\*\\*[^*\\n]+\\*\\*)|(\\*[^*\\n]+\\*)|(https?://[^\\s<>\"')\\]]+)|(@[\\p{L}\\p{M}\\p{N}_-]+)")

fun parseBlocks(text: String): List<Block> {
    val blocks = mutableListOf<Block>()
    var last = 0
    for (match in FENCE.findAll(text)) {
        val before = text.substring(last, match.range.first)
        if (before.isNotBlank()) blocks += Block.Paragraph(parseInline(before.trim('\n')))
        blocks += Block.Code(match.groupValues[1].trimEnd('\n'))
        last = match.range.last + 1
    }
    val rest = text.substring(last)
    if (rest.isNotBlank() || blocks.isEmpty()) blocks += Block.Paragraph(parseInline(rest.trim('\n')))
    return blocks
}

fun parseInline(text: String): List<Span> {
    val spans = mutableListOf<Span>()
    var last = 0
    for (match in INLINE.findAll(text)) {
        if (match.range.first > last) spans += Span.Plain(text.substring(last, match.range.first))
        val part = match.value
        spans += when {
            match.groups[1] != null -> Span.Code(part.substring(1, part.length - 1))
            match.groups[2] != null -> Span.Bold(part.substring(2, part.length - 2))
            match.groups[3] != null -> Span.Action(part.substring(1, part.length - 1))
            match.groups[4] != null -> Span.Link(part)
            else -> Span.Mention(part)
        }
        last = match.range.last + 1
    }
    if (last < text.length) spans += Span.Plain(text.substring(last))
    return spans
}
