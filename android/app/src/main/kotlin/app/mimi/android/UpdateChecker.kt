package app.mimi.android

import app.mimi.core.model.MimiJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import javax.inject.Inject
import javax.inject.Singleton

data class AppUpdate(val version: String, val url: String)

/** 1.2.10 > 1.2.9; anything after "-" is ignored (the web client's rule, feature-update.js). */
fun newerVersion(candidate: String, installed: String): Boolean {
    fun parts(text: String) = text.removePrefix("v").substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
    val (a, b) = parts(candidate) to parts(installed)
    for (i in 0 until maxOf(a.size, b.size)) {
        val (x, y) = a.getOrElse(i) { 0 } to b.getOrElse(i) { 0 }
        if (x != y) return x > y
    }
    return false
}

/**
 * Asks GitHub (read only, no token) whether the latest Mimi release carries a newer APK; the
 * download opens in the browser and installs over this app (same key, android/README.md).
 */
@Singleton
class UpdateChecker @Inject constructor(private val client: OkHttpClient) {
    private val found = MutableStateFlow<AppUpdate?>(null)
    val update: StateFlow<AppUpdate?> = found.asStateFlow()

    suspend fun check(installed: String) = withContext(Dispatchers.IO) {
        if (installed.isBlank() || installed == "0.0.0") return@withContext
        runCatching {
            val request = Request.Builder().url("https://api.github.com/repos/$REPO/releases/latest").header("accept", "application/vnd.github+json").build()
            val release = client.newCall(request).execute().use { MimiJson.parseToJsonElement(it.body!!.string()).jsonObject }
            val tag = release["tag_name"]?.jsonPrimitive?.contentOrNull ?: return@runCatching
            val apk = (release["assets"] as? JsonArray)?.map { it.jsonObject }?.firstOrNull { asset: JsonObject ->
                asset["name"]?.jsonPrimitive?.contentOrNull?.endsWith("android.apk", ignoreCase = true) == true
            } ?: return@runCatching
            val url = apk["browser_download_url"]?.jsonPrimitive?.contentOrNull ?: return@runCatching
            if (newerVersion(tag, installed)) found.value = AppUpdate(tag, url)
        }
    }

    fun dismiss() {
        found.value = null
    }

    private companion object {
        const val REPO = "Nbcybg/Project-Mimi"
    }
}
