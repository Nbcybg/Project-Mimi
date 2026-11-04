package app.mimi.core.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The signed-in connection: which server, the token (secret) and the display name. */
data class Session(
    val server: String = "",
    val token: String? = null,
    val username: String = "",
)

interface SessionStore {
    val session: StateFlow<Session>

    /** Saves the session in memory; only `remember` writes it to the device. */
    fun save(session: Session, remember: Boolean = true)

    fun signOut()
}

/** In memory only, for tests and for a process that must not persist anything. */
class MemorySessionStore : SessionStore {
    private val state = MutableStateFlow(Session())
    override val session: StateFlow<Session> = state.asStateFlow()

    override fun save(session: Session, remember: Boolean) {
        state.value = session
    }

    override fun signOut() {
        state.value = Session()
    }
}

/**
 * The session that survives a restart (auth-and-session.md 8): server and username are not secret
 * and live in plain preferences; the token is sealed by the Android Keystore through
 * [EncryptedSharedPreferences] and is never written anywhere else or logged.
 */
class PersistentSessionStore(context: Context) : SessionStore {
    private val appContext = context.applicationContext
    private val prefs: SharedPreferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val secure: SharedPreferences? = openSecure(appContext)
    private val state = MutableStateFlow(load())

    override val session: StateFlow<Session> = state.asStateFlow()

    override fun save(session: Session, remember: Boolean) {
        state.value = session
        if (!remember) {
            clearStorage()
            return
        }
        prefs.edit().putString(KEY_SERVER, session.server).putString(KEY_USERNAME, session.username).apply()
        runCatching { secure?.edit()?.putString(KEY_TOKEN, session.token)?.apply() }
    }

    // The server address is not secret: it stays so the sign-in screen offers it again.
    override fun signOut() {
        state.value = Session(server = state.value.server)
        prefs.edit().remove(KEY_USERNAME).apply()
        runCatching { secure?.edit()?.remove(KEY_TOKEN)?.apply() }
    }

    private fun load(): Session {
        val server = prefs.getString(KEY_SERVER, "").orEmpty()
        val token = runCatching { secure?.getString(KEY_TOKEN, null) }.getOrNull()?.takeIf { it.isNotBlank() } ?: return Session(server = server)
        return Session(
            server = server,
            token = token,
            username = prefs.getString(KEY_USERNAME, "").orEmpty(),
        )
    }

    private fun clearStorage() {
        prefs.edit().remove(KEY_SERVER).remove(KEY_USERNAME).apply()
        runCatching { secure?.edit()?.remove(KEY_TOKEN)?.apply() }
    }

    private fun openSecure(context: Context): SharedPreferences? = runCatching {
        val key = MasterKey.Builder(context, MasterKey.DEFAULT_MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            SECURE_PREFS,
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.onFailure {
        // A broken Keystore must not crash the app: the session then lasts for this process only.
        Log.w("MimiSession", "secure preferences unavailable; the token will not be persisted")
    }.getOrNull()

    private companion object {
        const val PREFS = "mimi.session"
        const val SECURE_PREFS = "mimi.session.secure"
        const val KEY_SERVER = "server"
        const val KEY_USERNAME = "username"
        const val KEY_TOKEN = "token"
    }
}
