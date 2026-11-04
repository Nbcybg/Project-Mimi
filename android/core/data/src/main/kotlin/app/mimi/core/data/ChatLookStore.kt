package app.mimi.core.data

import app.mimi.core.model.MimiJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/** A chat's own background, in the web's own format (`mimi.chat.<id>.background`, feature-backgrounds.js). */
data class ChatBackground(
    /** none | solid | gradient | preset (an uploaded picture is not shown by this app yet). */
    val type: String = "none",
    val preset: String? = null,
    val color: String? = null,
    val from: String? = null,
    val to: String? = null,
    val angle: Float = 135f,
)

/**
 * How one chat looks (the web's "Chat setting → หน้าตา"). Read from and written to the settings the account's
 * devices share ([UiSettings], `ui-set`) under the web's own keys, so a change here shows on the web and back.
 */
data class ChatLook(
    /** 0 small, 1 normal, 2 large. */
    val textSize: Int = 1,
    /** The character behind a direct chat. */
    val character: Boolean = true,
    /** How much chat shows over the character: 0 none, 1 the two newest, 2 all (the usual). */
    val bubbles: Int = 2,
    /** Where the character stands: size and slide, percent of the stage; y is up-negative (screen direction). */
    val zoom: Float = 1f,
    val x: Float = 0f,
    val y: Float = 0f,
    val background: ChatBackground? = null,
)

private const val MODE = "mobile"
private val LEGACY_PRESETS = mapOf("night" to "starlight", "cafe" to "crimson", "forest" to "mint", "room" to "blush", "ocean" to "waves", "sunset" to "dawn")

private fun chatKey(chatId: Long, name: String) = "mimi.chat.$chatId.$name"

/** The 2D position of an agent on the stage, per mode (feature-stage.js `viewKey`). */
private fun viewKey(agent: String) = "mimi.view.$MODE.$agent.2d"

private fun level(raw: String?, allowed: Set<Int>, fallback: Int): Int = raw?.toIntOrNull()?.takeIf { it in allowed } ?: fallback

private fun parseObject(raw: String?): JsonObject? =
    raw?.let { runCatching { MimiJson.parseToJsonElement(it) as? JsonObject }.getOrNull() }

private fun parseBackground(raw: String?): ChatBackground? {
    val json = parseObject(raw) ?: return null
    val type = (json["type"] as? JsonPrimitive)?.contentOrNull
    fun text(key: String) = (json[key] as? JsonPrimitive)?.contentOrNull
    return when (type) {
        "preset" -> ChatBackground("preset", preset = text("preset")?.let { LEGACY_PRESETS[it] ?: it })
        "solid" -> ChatBackground("solid", color = text("color"))
        "gradient" -> ChatBackground("gradient", from = text("from"), to = text("to"), angle = (json["angle"] as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: 135f)
        else -> null
    }
}

/** The look of [chatId] from the shared settings: the chat's own keys, else the device defaults, else the usual. */
fun chatLookFrom(values: Map<String, String>, chatId: Long, agent: String?): ChatLook {
    val view = agent?.let { parseObject(values[viewKey(it)]) }
    fun number(key: String, fallback: Float) = ((view?.get(key) as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: fallback)
    return ChatLook(
        textSize = level(values[chatKey(chatId, "textSize")] ?: values["mimi.textSize"], setOf(0, 2), 1),
        character = (values[chatKey(chatId, "character")] ?: values["mimi.character.$MODE"]) != "0",
        bubbles = level(values[chatKey(chatId, "bubbles")] ?: values["mimi.bubbles.$MODE"], setOf(0, 1), 2),
        zoom = number("zoom", 1f).coerceIn(0.5f, 1.8f),
        x = number("x", 0f).coerceIn(-50f, 50f),
        // The web's y is up-positive (`--vy: -y%`); here it is screen-down-positive.
        y = (0f - number("y", 0f)).coerceIn(-40f, 40f), // not -number(): that would give -0.0
        background = parseBackground(values[chatKey(chatId, "background")]),
    )
}

/** The keys that change when [old] becomes [new]; a null value removes the key. */
fun chatLookChanges(old: ChatLook, new: ChatLook, chatId: Long, agent: String?): Map<String, String?> = buildMap {
    if (new.textSize != old.textSize) put(chatKey(chatId, "textSize"), new.textSize.toString())
    if (new.character != old.character) put(chatKey(chatId, "character"), if (new.character) "1" else "0")
    if (new.bubbles != old.bubbles) put(chatKey(chatId, "bubbles"), new.bubbles.toString())
    if (new.background != old.background) {
        put(
            chatKey(chatId, "background"),
            new.background?.let { bg ->
                buildJsonObject {
                    put("type", bg.type)
                    bg.preset?.let { put("preset", it) }
                    bg.color?.let { put("color", it) }
                    bg.from?.let { put("from", it) }
                    bg.to?.let { put("to", it) }
                }.toString()
            },
        )
    }
    if (agent != null && (new.zoom != old.zoom || new.x != old.x || new.y != old.y)) {
        val reset = new.zoom == 1f && new.x == 0f && new.y == 0f
        put(
            viewKey(agent),
            if (reset) null else buildJsonObject {
                put("zoom", new.zoom.toDouble())
                put("x", new.x.toDouble())
                put("y", (-new.y).toDouble())
            }.toString(),
        )
    }
}

/** The chat settings, as a look per chat on top of the shared settings. */
@Singleton
class ChatLookStore @Inject constructor(private val ui: UiSettings) {
    /** Every shared setting: a screen derives its chat's look with [chatLookFrom]. */
    val values: StateFlow<Map<String, String>> get() = ui.values

    fun look(chatId: Long, agent: String?): Flow<ChatLook> = ui.values.map { chatLookFrom(it, chatId, agent) }.distinctUntilChanged()

    fun update(chatId: Long, agent: String?, change: (ChatLook) -> ChatLook) {
        val old = chatLookFrom(ui.values.value, chatId, agent)
        val changes = chatLookChanges(old, change(old), chatId, agent)
        if (changes.isNotEmpty()) ui.set(changes)
    }
}
