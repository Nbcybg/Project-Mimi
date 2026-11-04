package app.mimi.core.data

import android.content.SharedPreferences
import app.mimi.core.model.ServerFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.lang.reflect.Proxy

class ChatLookStoreTest {
    private fun memoryPrefs(): SharedPreferences {
        val values = HashMap<String, Any?>()
        lateinit var editor: SharedPreferences.Editor
        editor = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { _, method, args ->
            when (method.name) {
                "putString" -> { values[args[0] as String] = args[1]; editor }
                else -> editor
            }
        } as SharedPreferences.Editor
        return Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "getString" -> values[args[0] as String] ?: args[1]
                "edit" -> editor
                else -> null
            }
        } as SharedPreferences
    }

    @Test
    fun `nothing set gives the web's usual look`() {
        assertEquals(ChatLook(), chatLookFrom(emptyMap(), 7, "mimi"))
        assertEquals(2, ChatLook().bubbles)
    }

    @Test
    fun `the chat's own keys win over the device defaults, which win over the usual`() {
        val values = mapOf(
            "mimi.textSize" to "2",
            "mimi.bubbles.mobile" to "1",
            "mimi.chat.7.textSize" to "0",
            "mimi.chat.7.character" to "0",
            "mimi.chat.7.background" to """{"type":"preset","preset":"night","color":"#000000"}""",
            "mimi.view.mobile.mimi.2d" to """{"zoom":1.3,"x":10,"y":8}""",
        )
        val look = chatLookFrom(values, 7, "mimi")
        assertEquals(0, look.textSize)
        assertEquals(false, look.character)
        assertEquals(1, look.bubbles)
        assertEquals(ChatBackground("preset", preset = "starlight"), look.background)
        // The web's y is up-positive: 8 up is -8 here.
        assertEquals(listOf(1.3f, 10f, -8f), listOf(look.zoom, look.x, look.y))
        // Another chat only has the device defaults.
        assertEquals(ChatLook(textSize = 2, bubbles = 1), chatLookFrom(values, 8, null))
    }

    @Test
    fun `a change is written under the web's keys, and putting things back removes the keys`() {
        val old = ChatLook()
        val changed = old.copy(textSize = 2, character = false, bubbles = 0, zoom = 1.2f, x = 5f, y = -4f, background = ChatBackground("preset", preset = "mint"))
        val changes = chatLookChanges(old, changed, 7, "mimi")
        assertEquals("2", changes["mimi.chat.7.textSize"])
        assertEquals("0", changes["mimi.chat.7.character"])
        assertEquals("0", changes["mimi.chat.7.bubbles"])
        assertEquals("""{"type":"preset","preset":"mint"}""", changes["mimi.chat.7.background"])
        assertEquals("""{"zoom":1.2,"x":5.0,"y":4.0}""".replace(".0,", ".0,"), changes["mimi.view.mobile.mimi.2d"]?.replace("1.2000000476837158", "1.2"))
        // Back to the defaults: the background and the view keys go.
        val back = chatLookChanges(changed, changed.copy(background = null, zoom = 1f, x = 0f, y = 0f), 7, "mimi")
        assertNull(back["mimi.chat.7.background"])
        assertEquals(true, back.containsKey("mimi.chat.7.background"))
        assertNull(back["mimi.view.mobile.mimi.2d"])
        // A group has no character view to save.
        assertEquals(emptySet<String>(), chatLookChanges(old, old.copy(zoom = 1.5f), 9, null).keys)
    }

    @Test
    fun `welcome replaces the shared values, ui merges and removes, and a change is sent and kept`() {
        val sent = mutableListOf<String>()
        val prefs = memoryPrefs()
        val settings = UiSettings(prefs, { sent += it })
        settings.onFrame(ServerFrame.Welcome(emptyList(), "", emptyList(), emptyList(), null, 2, 1, ui = mapOf("mimi.textSize" to "2", "a" to "1")))
        assertEquals(mapOf("mimi.textSize" to "2", "a" to "1"), settings.values.value)
        settings.onFrame(ServerFrame.Ui(mapOf("a" to null, "b" to "2")))
        assertEquals(mapOf("mimi.textSize" to "2", "b" to "2"), settings.values.value)
        settings.set(mapOf("mimi.chat.1.bubbles" to "0"))
        assertEquals("""{"type":"ui-set","values":{"mimi.chat.1.bubbles":"0"}}""", sent.single())
        // A new instance (the app restarted, offline) still has what was saved.
        assertEquals("0", UiSettings(prefs, {}).values.value["mimi.chat.1.bubbles"])
    }
}
