package app.mimi.core.model

import java.text.BreakIterator

/**
 * The key the core files an expression picture under: the code points of one emoji in hex without the
 * emoji selector (FE0F), joined by `-` (feature-stage.js `emojiKey`). ❤️ is `2764`, 😊 is `1f60a`.
 */
fun emojiKey(emoji: String): String =
    emoji.codePoints().toArray().filter { it != 0xFE0F }.joinToString("-") { Integer.toHexString(it) }

/** Whether a grapheme starts with a picture: an emoji, a regional indicator (flag) or a keycap. */
private fun isPictograph(grapheme: String): Boolean {
    val first = grapheme.codePointAt(0)
    return first in 0x1F300..0x1FAFF || first in 0x2600..0x27BF || first in 0x1F1E6..0x1F1FF ||
        first in 0x2B00..0x2BFF || first == 0x2764 || first == 0x00A9 || first == 0x00AE ||
        (grapheme.length > 1 && grapheme.codePointAt(grapheme.offsetByCodePoints(0, 1)) == 0x20E3) ||
        (grapheme.length > 1 && grapheme.contains('️'))
}

/** The key of the last emoji in [text] (the mood of a reply), or null when there is none. */
fun lastEmojiKey(text: String): String? {
    if (text.isEmpty()) return null
    val iterator = BreakIterator.getCharacterInstance()
    iterator.setText(text)
    var last: String? = null
    var start = iterator.first()
    var end = iterator.next()
    while (end != BreakIterator.DONE) {
        val grapheme = text.substring(start, end)
        if (isPictograph(grapheme)) last = grapheme
        start = end
        end = iterator.next()
    }
    return last?.let(::emojiKey)
}
