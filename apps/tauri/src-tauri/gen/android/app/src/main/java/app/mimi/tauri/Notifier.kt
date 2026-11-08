package app.mimi.tauri

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Where the shell keeps what the background connection needs: the core and the sign-in token. */
object ShellPrefs {
  fun of(context: Context): SharedPreferences = context.getSharedPreferences("mimi_shell", Context.MODE_PRIVATE)
}

/** System notifications of the Mimi shell, used by the page (while it is open) and by NotifyService. */
object Notifier {
  const val MESSAGES = "mimi_messages"
  const val CONNECTION = "mimi_connection"

  fun allowed(context: Context): Boolean =
    Build.VERSION.SDK_INT < 33 ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(MESSAGES) == null) {
      manager.createNotificationChannel(NotificationChannel(MESSAGES, "ข้อความและการแจ้งเตือน", NotificationManager.IMPORTANCE_HIGH))
    }
    if (manager.getNotificationChannel(CONNECTION) == null) {
      manager.createNotificationChannel(NotificationChannel(CONNECTION, "การเชื่อมต่อเบื้องหลัง", NotificationManager.IMPORTANCE_MIN))
    }
  }

  /** The prefix the page puts in front of a title, so the same notice gets the same text and id from both. */
  fun titleFor(kind: String?, title: String?): String {
    val icon = when (kind) {
      "reminder" -> "⏰ "
      "approval" -> "✋ "
      "message" -> "💬 "
      else -> "📋 "
    }
    return icon + (title ?: "")
  }

  /** The same chat and title replace one another instead of stacking up. */
  fun post(context: Context, title: String?, body: String?, chatId: Int) {
    if (!allowed(context)) return
    ensureChannels(context)
    val id = (chatId * 31 + (title ?: "").hashCode()) and 0x7fffffff
    val open = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra("mimi_chat", chatId)
    }
    val pending = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val text = (body ?: "").take(300)
    val notification = NotificationCompat.Builder(context, MESSAGES)
      .setSmallIcon(R.mipmap.ic_launcher_foreground)
      .setContentTitle(title ?: "Mimi")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setAutoCancel(true)
      .setContentIntent(pending)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()
    try {
      NotificationManagerCompat.from(context).notify(id, notification)
    } catch (_: SecurityException) {
      // permission withdrawn between the check and the call
    }
  }
}
