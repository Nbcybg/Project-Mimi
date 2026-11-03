package app.mimi.android.push

import android.content.Context
import android.os.Build
import app.mimi.android.BuildConfig
import app.mimi.android.Notifier
import app.mimi.core.data.repo.PushRepository
import app.mimi.core.model.NotificationSyncItem
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import javax.inject.Inject

/**
 * FCM data messages from the core (push-and-background.md 2.2). By default a push carries no
 * text ("minimal"): the text is fetched from `/api/notifications?afterId=` before it is shown.
 */
@AndroidEntryPoint
class MimiMessagingService : FirebaseMessagingService() {
    @Inject lateinit var push: PushRepository

    override fun onNewToken(token: String) {
        runBlocking { runCatching { push.register(token, Build.MODEL) } }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val fetched = runBlocking { withTimeoutOrNull(8_000) { runCatching { push.newNotifications() }.getOrNull() } }
        if (!fetched.isNullOrEmpty()) {
            fetched.forEach { Notifier.show(this, it) }
            return
        }
        // Could not fetch (offline): show what the push itself says.
        val id = data["id"]?.toLongOrNull() ?: return
        Notifier.show(this, NotificationSyncItem(id = id, kind = data["kind"].orEmpty(), title = data["title"].orEmpty(), body = data["body"].orEmpty(), chatId = data["chatId"]?.toLongOrNull()))
    }

    companion object {
        /** True when this build carries Firebase ids; then Firebase is set up by hand (no google-services.json). */
        fun configured(): Boolean = listOf(BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_APP_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_SENDER_ID).all { it.isNotBlank() }

        fun init(context: Context, push: PushRepository, onToken: suspend (String) -> Unit = { push.register(it, Build.MODEL) }) {
            if (!configured()) return
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setProjectId(BuildConfig.FCM_PROJECT_ID)
                        .setApplicationId(BuildConfig.FCM_APP_ID)
                        .setApiKey(BuildConfig.FCM_API_KEY)
                        .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                        .build(),
                )
            }
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                Thread { runBlocking { runCatching { onToken(token) } } }.start()
            }
        }
    }
}
