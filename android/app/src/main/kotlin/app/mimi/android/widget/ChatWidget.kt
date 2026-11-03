package app.mimi.android.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import app.mimi.android.MainActivity
import app.mimi.android.R
import app.mimi.android.push.NotificationWorker
import app.mimi.core.data.SessionStore
import app.mimi.core.model.WidgetChat
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.Date
import javax.inject.Inject
import kotlin.math.abs

/** Home-screen widget: the newest chats (picture, name, time, last message, unread badge); a row opens its chat. */
@AndroidEntryPoint
class ChatWidget : AppWidgetProvider() {
    @Inject lateinit var sync: WidgetSync
    @Inject lateinit var sessions: SessionStore

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        draw(context, manager, ids, sync.chats(), sessions.session.value.token != null)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try { sync.refresh() } finally { pending.finish() }
        }
    }

    override fun onEnabled(context: Context) = NotificationWorker.schedule(context)

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == REFRESH) NotificationWorker.now(context)
    }

    companion object {
        const val REFRESH = "app.mimi.android.WIDGET_REFRESH"

        fun draw(context: Context, manager: AppWidgetManager, ids: IntArray, chats: List<WidgetChat>, signedIn: Boolean = true) {
            val unread = chats.sumOf { it.unread }
            val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            for (id in ids) {
                val views = RemoteViews(context.packageName, R.layout.widget_chats)
                val service = Intent(context, ChatWidgetService::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                service.data = Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME))
                @Suppress("DEPRECATION")
                views.setRemoteAdapter(R.id.widgetList, service)
                views.setEmptyView(R.id.widgetList, R.id.widgetEmpty)
                views.setViewVisibility(R.id.widgetTotal, if (unread > 0) View.VISIBLE else View.GONE)
                views.setTextViewText(R.id.widgetTotal, if (unread > 99) "99+" else unread.toString())
                val home = PendingIntent.getActivity(context, 2, Intent(context, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                views.setOnClickPendingIntent(R.id.widgetHeader, home)
                views.setOnClickPendingIntent(R.id.widgetEmpty, home)
                views.setTextViewText(R.id.widgetEmpty, context.getString(if (signedIn) R.string.widgetEmpty else R.string.widgetSignIn))
                // A row fills in its chat id; the template opens the app.
                val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                views.setPendingIntentTemplate(R.id.widgetList, PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or mutable))
                manager.updateAppWidget(id, views)
            }
        }
    }
}

@AndroidEntryPoint
class ChatWidgetService : RemoteViewsService() {
    @Inject lateinit var sync: WidgetSync

    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Rows()

    private inner class Rows : RemoteViewsFactory {
        private var chats: List<WidgetChat> = emptyList()
        private val colors = intArrayOf(0xFFE08A5B.toInt(), 0xFF5B9BE0.toInt(), 0xFF63B37A.toInt(), 0xFFB57AD6.toInt(), 0xFFD6A13C.toInt(), 0xFFD0647A.toInt())

        override fun onCreate() = Unit
        override fun onDataSetChanged() { chats = sync.chats() }
        override fun onDestroy() { chats = emptyList() }
        override fun getCount() = chats.size
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun getItemId(position: Int) = chats.getOrNull(position)?.id ?: position.toLong()
        override fun hasStableIds() = true

        override fun getViewAt(position: Int): RemoteViews {
            val row = RemoteViews(packageName, R.layout.widget_row)
            val chat = chats.getOrNull(position) ?: return row
            val title = chat.title.ifBlank { "Mimi" }
            row.setTextViewText(R.id.rowTitle, title)
            row.setTextViewText(R.id.rowPreview, chat.preview.replace(Regex("[*`#]"), ""))
            row.setTextViewText(R.id.rowTime, time(chat.lastMessageAt))
            row.setViewVisibility(R.id.rowBadge, if (chat.unread > 0) View.VISIBLE else View.GONE)
            row.setTextViewText(R.id.rowBadge, if (chat.unread > 99) "99+" else chat.unread.toString())
            val avatar = sync.avatarFile(chat.agent)
            row.setImageViewBitmap(R.id.rowAvatar, (if (avatar.exists()) BitmapFactory.decodeFile(avatar.path) else null) ?: letter(title))
            row.setOnClickFillInIntent(R.id.rowRoot, Intent().putExtra("chat", chat.id))
            return row
        }

        private fun time(iso: String?): String {
            val date = iso?.let { runCatching { Date.from(Instant.parse(it)) }.getOrNull() } ?: return ""
            val age = System.currentTimeMillis() - date.time
            return if (DateFormat.format("yyyyMMdd", date) == DateFormat.format("yyyyMMdd", Date())) DateFormat.getTimeFormat(this@ChatWidgetService).format(date)
            else if (age < 6L * 24 * 3600 * 1000) DateFormat.format("EEE", date).toString()
            else DateFormat.getDateFormat(this@ChatWidgetService).format(date)
        }

        /** A coloured circle with the first letter, for an agent without a picture. */
        private fun letter(title: String): Bitmap {
            val size = 128
            val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = colors[abs(title.hashCode()) % colors.size] }
            canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
            paint.color = Color.WHITE
            paint.textSize = size * 0.46f
            paint.textAlign = Paint.Align.CENTER
            val first = if (title.isEmpty()) "M" else title.substring(0, title.offsetByCodePoints(0, 1)).uppercase()
            canvas.drawText(first, size / 2f, size / 2f - (paint.descent() + paint.ascent()) / 2, paint)
            return out
        }
    }
}
