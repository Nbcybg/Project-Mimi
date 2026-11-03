package app.mimi.android.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import app.mimi.android.R
import app.mimi.core.data.repo.FileRepository
import app.mimi.core.model.MimiJson
import app.mimi.core.model.WidgetChat
import app.mimi.core.model.WidgetView
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Keeps the home-screen widget's list: `GET /api/widget` with the signed-in token, the answer
 * and round avatars kept on the device so the widget draws without the network.
 */
@Singleton
class WidgetSync @Inject constructor(
    @ApplicationContext private val context: Context,
    private val files: FileRepository,
    private val client: OkHttpClient,
) {
    private val prefs = context.getSharedPreferences("widget", Context.MODE_PRIVATE)

    fun chats(): List<WidgetChat> = runCatching {
        MimiJson.decodeFromString(WidgetView.serializer(), prefs.getString("view", null) ?: return emptyList()).chats
    }.getOrDefault(emptyList())

    suspend fun refresh() = withContext(Dispatchers.IO) {
        val view = files.widget()
        if (view != null) {
            view.chats.forEach { cacheAvatar(it) }
            prefs.edit().putString("view", MimiJson.encodeToString(WidgetView.serializer(), view)).apply()
        }
        redraw()
    }

    fun clear() {
        prefs.edit().clear().apply()
        File(context.cacheDir, "avatars").deleteRecursively()
        redraw()
    }

    fun redraw() {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, ChatWidget::class.java))
        if (ids.isEmpty()) return
        ChatWidget.draw(context, manager, ids, chats())
        @Suppress("DEPRECATION")
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widgetList)
    }

    fun avatarFile(agent: String): File = File(File(context.cacheDir, "avatars").apply { mkdirs() }, Integer.toHexString(agent.hashCode()) + ".png")

    /** Downloads an agent's picture once per version, cut to a circle. */
    private fun cacheAvatar(chat: WidgetChat) {
        val path = chat.avatar ?: return
        val file = avatarFile(chat.agent)
        if (prefs.getString("avatar:${chat.agent}", null) == path && file.exists()) return
        runCatching {
            val bytes = client.newCall(Request.Builder().url(files.url(path)).build()).execute().use { it.body!!.bytes() }
            val source = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
            file.outputStream().use { circle(source, 128).compress(Bitmap.CompressFormat.PNG, 100, it) }
            prefs.edit().putString("avatar:${chat.agent}", path).apply()
        }
    }

    private fun circle(source: Bitmap, size: Int): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        val side = minOf(source.width, source.height)
        val left = (source.width - side) / 2
        // A portrait keeps its top (the face).
        val top = if (source.height > source.width) 0 else (source.height - side) / 2
        canvas.drawBitmap(source, Rect(left, top, left + side, top + side), Rect(0, 0, size, size), paint)
        return out
    }
}
