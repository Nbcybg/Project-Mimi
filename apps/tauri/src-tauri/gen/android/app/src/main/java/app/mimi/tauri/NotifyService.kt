package app.mimi.tauri

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Keeps one WebSocket to the core while someone is signed in, so a notification (an agent's
 * message when it finishes, a reminder, an approval) reaches the phone while the app is in the
 * background, where Android pauses the page's own JavaScript. It only speaks while the app is
 * out of sight: with the page on screen, the page hands the same notice to MimiAndroid.notify.
 *
 * The service needs a foreground notification (silent, lowest priority) to stay alive; it stops
 * when the person signs out or the core refuses the token. It does not survive a reboot or the
 * system killing the app: the old native app also used FCM and periodic polling for that.
 */
class NotifyService : Service() {
  private val client = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
  private val handler = Handler(Looper.getMainLooper())
  private var socket: WebSocket? = null
  private var retryMs = 1000L
  private var stopped = false

  override fun onCreate() {
    super.onCreate()
    Notifier.ensureChannels(this)
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(this, Notifier.CONNECTION)
      .setSmallIcon(R.mipmap.ic_launcher_foreground)
      .setContentTitle("Mimi")
      .setContentText("เชื่อมต่ออยู่ เพื่อรอการแจ้งเตือน")
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(open)
      .build()
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    ServiceCompat.startForeground(this, FOREGROUND_ID, notification, type)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (socket == null) connect()
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    stopped = true
    handler.removeCallbacksAndMessages(null)
    socket?.close(1000, null)
    socket = null
    client.dispatcher.executorService.shutdown()
    super.onDestroy()
  }

  private fun connect() {
    if (stopped) return
    val prefs = ShellPrefs.of(this)
    val core = prefs.getString("core", null)
    val token = prefs.getString("token", null)
    if (core.isNullOrBlank() || token.isNullOrBlank()) {
      stopSelf()
      return
    }
    val url = core.trimEnd('/').replaceFirst(Regex("^http"), "ws") + "/ws"
    val request = try {
      Request.Builder().url(url).build()
    } catch (_: IllegalArgumentException) {
      stopSelf()
      return
    }
    socket = client.newWebSocket(
      request,
      object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          retryMs = 1000
          webSocket.send(JSONObject().put("type", "hello").put("role", "client").put("token", token).put("name", "tauri-android").toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          handle(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
          webSocket.close(code, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
          if (code == 4003) signedOut() else retry()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          retry()
        }
      },
    )
  }

  private fun retry() {
    if (stopped) return
    socket = null
    handler.postDelayed({ connect() }, retryMs)
    retryMs = minOf(retryMs * 2, 60_000L)
  }

  /** The core no longer accepts this token. */
  private fun signedOut() {
    ShellPrefs.of(this).edit().remove("token").apply()
    stopSelf()
  }

  private fun appInForeground(): Boolean =
    ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

  private fun handle(text: String) {
    val message = try {
      JSONObject(text)
    } catch (_: Exception) {
      return
    }
    if (message.optString("type") != "notification") return
    val notice = message.optJSONObject("notification") ?: return
    val kind = notice.optString("kind")
    if (kind == "info") return
    // On screen, the page shows it itself (same id, so it would only replace this one).
    if (appInForeground()) return
    Notifier.post(this, Notifier.titleFor(kind, notice.optString("title")), notice.optString("body"), notice.optInt("chatId", 0))
  }

  companion object {
    private const val FOREGROUND_ID = 4102

    fun start(context: Context) {
      try {
        androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, NotifyService::class.java))
      } catch (_: Exception) {
        // not allowed to start from the background right now; the next sign-in or app start retries
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, NotifyService::class.java))
    }
  }
}
