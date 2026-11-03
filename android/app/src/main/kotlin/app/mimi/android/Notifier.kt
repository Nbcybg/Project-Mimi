package app.mimi.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.mimi.core.model.NotificationSyncItem

/** Native notifications of the core's inbox (reminders, replies, approvals). */
object Notifier {
    private const val CHANNEL = "notifications_high"
    private const val REPLIES = "replies_high"

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.channelNotifications), NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(REPLIES, context.getString(R.string.channelReplies), NotificationManager.IMPORTANCE_HIGH))
    }

    fun allowed(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** One notification; the same id for the same item, so push and poll never show it twice. */
    fun show(context: Context, item: NotificationSyncItem) {
        if (!allowed(context)) return
        val icon = when (item.kind) { "message" -> "💬 "; "reminder" -> "⏰ "; "approval" -> "✋ "; else -> "" }
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        item.chatId?.let { open.putExtra("chat", it) }
        val tap = PendingIntent.getActivity(context, item.id.toInt(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val body = item.body.ifBlank { context.getString(R.string.newMessage) }
        val notification = NotificationCompat.Builder(context, if (item.kind == "message") REPLIES else CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFFE08AA7.toInt())
            .setContentTitle(icon + item.title.ifBlank { context.getString(R.string.appName) })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(if (item.kind == "message") NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(item.id.toInt(), notification) }
    }

    fun cancel(context: Context, ids: List<Long>) {
        val manager = NotificationManagerCompat.from(context)
        ids.forEach { manager.cancel(it.toInt()) }
    }
}
