package app.mimi.core.data.repo

import android.content.Context
import app.mimi.core.data.SessionStore
import app.mimi.core.data.net.MimiHttpException
import app.mimi.core.data.net.httpCall
import app.mimi.core.data.net.toError
import app.mimi.core.model.AttachmentView
import app.mimi.core.model.MimiJson
import app.mimi.core.model.WidgetView
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.net.URLEncoder
import javax.inject.Inject
import javax.inject.Singleton

/** Files of the chat and of the widget over HTTP (api-contract.md A.3, A.4, A.6). */
@Singleton
class FileRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val client: OkHttpClient,
    private val sessions: SessionStore,
) {
    /** A path the server handed out, made absolute; an empty server leaves it as it is. */
    fun url(path: String): String {
        if (path.isBlank() || path.startsWith("http://") || path.startsWith("https://")) return path
        val server = sessions.session.value.server
        if (server.isBlank()) return path
        return server.trimEnd('/') + "/" + path.trimStart('/')
    }

    fun fileUrl(attachment: AttachmentView): String = url("/api/files/${attachment.id}")

    suspend fun upload(name: String, mime: String, bytes: ByteArray): AttachmentView {
        if (bytes.size > MAX_BYTES) throw MimiHttpException(413, "ไฟล์ใหญ่เกิน 25 MB")
        val encoded = URLEncoder.encode(name, "UTF-8").replace("+", "%20")
        val url = required("/api/upload?name=$encoded")
        val body = bytes.toRequestBody(mime.ifBlank { "application/octet-stream" }.toMediaTypeOrNull())
        return httpCall {
            val request = Request.Builder().url(url).post(body).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw response.toError()
                val text = response.body?.string().orEmpty()
                MimiJson.decodeFromString(AttachmentView.serializer(), text)
            }
        }
    }

    /** Downloads a file to `cacheDir/files` and reuses it when it is already there. */
    suspend fun download(attachment: AttachmentView): File = httpCall {
        val directory = File(context.cacheDir, "files").apply { mkdirs() }
        val file = File(directory, "${attachment.id}-${safeName(attachment.name)}")
        if (file.exists() && file.length() > 0) return@httpCall file

        val request = Request.Builder().url(required("/api/files/${attachment.id}")).build()
        client.newCall(request).execute().use { response ->
            if (response.code == 410) throw MimiHttpException(410, "ไฟล์นี้ถูกลบตามระยะเวลาเก็บแล้ว")
            if (!response.isSuccessful) throw response.toError()
            val stream = response.body?.byteStream() ?: throw MimiHttpException(0, "เซิร์ฟเวอร์ไม่ได้ส่งไฟล์มา")
            val partial = File(directory, "${file.name}.part")
            try {
                stream.use { input -> partial.outputStream().use { output -> input.copyTo(output) } }
                if (!partial.renameTo(file)) {
                    partial.copyTo(file, overwrite = true)
                    partial.delete()
                }
            } finally {
                if (partial.exists()) partial.delete()
            }
        }
        file
    }

    /** The home-screen widget's chats; null when the server cannot answer. */
    suspend fun widget(): WidgetView? = try {
        httpCall {
            val request = Request.Builder().url(required("/api/widget")).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw response.toError()
                val text = response.body?.string().orEmpty()
                MimiJson.decodeFromString(WidgetView.serializer(), text)
            }
        }
    } catch (cancel: CancellationException) {
        throw cancel
    } catch (_: Exception) {
        null
    }

    private fun required(path: String): String {
        val server = sessions.session.value.server
        if (server.isBlank()) throw MimiHttpException(0, "ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์")
        return server.trimEnd('/') + "/" + path.trimStart('/')
    }

    private fun safeName(name: String): String {
        val plain = name.substringAfterLast('/').substringAfterLast('\\').trim()
        return plain.ifBlank { "file" }.take(120)
    }

    private companion object {
        const val MAX_BYTES = 25 * 1024 * 1024
    }
}
