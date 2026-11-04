package app.mimi.core.data.repo

import android.content.Context
import android.content.SharedPreferences
import app.mimi.core.data.AppInfo
import app.mimi.core.data.SessionStore
import app.mimi.core.data.net.MimiHttpException
import app.mimi.core.data.net.httpCall
import app.mimi.core.data.net.toError
import app.mimi.core.model.MimiJson
import app.mimi.core.model.NativePushRegistration
import app.mimi.core.model.NotificationSyncItem
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Singleton

/** The small device-side store the notification cursor and push token need. */
internal interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
    fun remove(key: String)
}

internal class PreferenceStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putString(key: String, value: String) = prefs.edit().putString(key, value).apply()
    override fun remove(key: String) = prefs.edit().remove(key).apply()
}

/**
 * Native push registration and the notification poll (api-contract.md A.6, A.6.1;
 * push-and-background.md 2). The first poll reports only unread items; later polls report
 * everything newer than the highest id already seen.
 */
@Singleton
class PushRepository internal constructor(
    private val client: OkHttpClient,
    private val sessions: SessionStore,
    private val info: AppInfo,
    private val store: KeyValueStore,
) {
    constructor(client: OkHttpClient, sessions: SessionStore, info: AppInfo, context: Context) : this(
        client,
        sessions,
        info,
        PreferenceStore(context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)),
    )

    private val mutex = Mutex()

    suspend fun register(token: String, label: String) {
        val registration = NativePushRegistration(
            platform = "fcm",
            token = token,
            label = label,
            appVersion = info.versionName,
        )
        val body = MimiJson.encodeToString(NativePushRegistration.serializer(), registration)
            .toRequestBody(JSON)
        val request = Request.Builder().url(required("/api/push/register")).post(body).build()
        httpCall {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw response.toError()
            }
        }
        store.putString(KEY_TOKEN, token)
    }

    /** Removes this device's token; signing out must not fail because the server is offline. */
    suspend fun unregister() {
        val token = store.getString(KEY_TOKEN) ?: return
        runCatching {
            val body = buildJsonObject { put("token", token) }.toString().toRequestBody(JSON)
            val request = Request.Builder().url(required("/api/push/unregister")).post(body).build()
            httpCall {
                client.newCall(request).execute().use { }
            }
        }
        store.remove(KEY_TOKEN)
    }

    suspend fun newNotifications(): List<NotificationSyncItem> = mutex.withLock {
        val remembered = store.getString(KEY_LAST_ID)?.toLongOrNull()
        val afterId = remembered ?: 0L
        val request = Request.Builder().url(required("/api/notifications?afterId=$afterId")).build()
        val items = httpCall {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw response.toError()
                val text = response.body?.string().orEmpty()
                if (text.isBlank()) emptyList()
                else MimiJson.decodeFromString(ListSerializer(NotificationSyncItem.serializer()), text)
            }
        }
        val highest = items.maxOfOrNull { it.id } ?: 0L
        // After the first successful look the cursor exists even when the answer was empty, so the
        // next look is no longer treated as a first run.
        store.putString(KEY_LAST_ID, maxOf(remembered ?: 0L, highest).toString())
        // The first look must not replay months of old, already-read notifications.
        if (remembered == null) items.filter { !it.read } else items
    }

    private fun required(path: String): String {
        val server = sessions.session.value.server
        if (server.isBlank()) throw MimiHttpException(0, "ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์")
        return server.trimEnd('/') + "/" + path.trimStart('/')
    }

    private companion object {
        const val PREFS = "mimi.push"
        const val KEY_TOKEN = "push.token"
        const val KEY_LAST_ID = "notifications.lastId"
        val JSON = "application/json".toMediaType()
    }
}
