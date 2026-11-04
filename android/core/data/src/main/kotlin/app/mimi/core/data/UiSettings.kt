package app.mimi.core.data

import android.content.Context
import android.content.SharedPreferences
import app.mimi.core.data.di.AppScope
import app.mimi.core.data.net.MimiSocket
import app.mimi.core.model.ClientFrames
import app.mimi.core.model.MimiJson
import app.mimi.core.model.ServerFrame
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The screen settings the account's devices share (realtime.md 8, `ui-set`): every key with its string, kept on
 * this device too so they are there offline. A change here is sent at once; the core's `welcome.ui` (on every
 * connect) and `ui` frames (another device changed something) bring the rest.
 */
@Singleton
class UiSettings internal constructor(
    private val prefs: SharedPreferences,
    private val send: (String) -> Unit,
) {
    @Inject
    constructor(@ApplicationContext context: Context, socket: MimiSocket, @AppScope scope: CoroutineScope) :
        this(context.getSharedPreferences("mimi.ui", Context.MODE_PRIVATE), { socket.send(it) }) {
        // UNDISPATCHED so the collection exists before the app starts the socket.
        scope.launch(start = CoroutineStart.UNDISPATCHED) { socket.frames.collect(::onFrame) }
    }

    private val state = MutableStateFlow(load())
    val values: StateFlow<Map<String, String>> = state.asStateFlow()

    internal fun onFrame(frame: ServerFrame) {
        when (frame) {
            is ServerFrame.Welcome -> replace(frame.ui)
            is ServerFrame.Ui -> merge(frame.values)
            else -> Unit
        }
    }

    /** Changes some keys (a null value removes one) here and on the account's other devices. */
    fun set(changes: Map<String, String?>) {
        if (changes.isEmpty()) return
        merge(changes)
        send(ClientFrames.uiSet(changes))
    }

    private fun replace(values: Map<String, String>) {
        state.value = values
        persist()
    }

    private fun merge(changes: Map<String, String?>) {
        state.update { current ->
            current.toMutableMap().also { map -> changes.forEach { (key, value) -> if (value == null) map.remove(key) else map[key] = value } }
        }
        persist()
    }

    private fun persist() {
        val json = buildJsonObject { state.value.forEach { (key, value) -> put(key, value) } }
        prefs.edit().putString(KEY, json.toString()).apply()
    }

    private fun load(): Map<String, String> {
        val raw = prefs.getString(KEY, null) ?: return emptyMap()
        val json = runCatching { MimiJson.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return emptyMap()
        return json.mapNotNull { (key, value) -> (value as? JsonPrimitive)?.contentOrNull?.let { key to it } }.toMap()
    }

    private companion object {
        const val KEY = "values"
    }
}
