package app.mimi.core.model

/**
 * The voice direction line an answer may start with (`[emotion: …][speed: 0.9]`), as
 * packages/shared/src/speech.ts and the web client read it. The core already strips it from
 * streamed text; the app checks again in case an older core did not.
 */
data class ParsedSpeech(val text: String, val speech: SpeechStyle?)

private val TAG = Regex("""\[([a-z]+)\s*:\s*([^\]\n]*)]""", RegexOption.IGNORE_CASE)
private val KEYS = setOf("emotion", "tone", "voice", "speed")

fun parseSpeech(source: String, live: Boolean = false): ParsedSpeech {
    val end = source.indexOf('\n')
    val line = if (end == -1) source else source.substring(0, end)
    val tags = TAG.findAll(line).toList()
    // While streaming, a first line still being typed may become a direction line: hold it back.
    if (live && end == -1 && Regex("""^\s*\[(emotion|tone|voice|speed)\b""", RegexOption.IGNORE_CASE).containsMatchIn(line)) {
        return ParsedSpeech("", styleOf(tags))
    }
    if (tags.isEmpty() || tags.any { it.groupValues[1].lowercase() !in KEYS }) return ParsedSpeech(source, null)
    if (line.replace(TAG, "").isNotBlank()) return ParsedSpeech(source, null)
    val style = styleOf(tags) ?: return ParsedSpeech(source, null)
    return ParsedSpeech(if (end == -1) "" else source.substring(end + 1), style)
}

private fun styleOf(tags: List<MatchResult>): SpeechStyle? {
    var style = SpeechStyle()
    for (tag in tags) {
        val key = tag.groupValues[1].lowercase()
        val value = tag.groupValues[2].trim()
        if (value.isEmpty()) continue
        style = when (key) {
            "emotion" -> if (style.emotion == null) style.copy(emotion = value.take(80)) else style
            "tone" -> if (style.tone == null) style.copy(tone = value.take(80)) else style
            "voice" -> if (style.voice == null) style.copy(voice = value.take(80)) else style
            "speed" -> value.toDoubleOrNull()?.let { style.copy(speed = it.coerceIn(0.5, 2.0)) } ?: style
            else -> style
        }
    }
    return if (style == SpeechStyle()) null else style
}
