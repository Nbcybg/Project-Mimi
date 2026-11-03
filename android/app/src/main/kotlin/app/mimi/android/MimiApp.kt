package app.mimi.android

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import app.mimi.android.push.MimiMessagingService
import app.mimi.android.push.NotificationWorker
import app.mimi.android.widget.WidgetSync
import app.mimi.core.data.SessionStore
import app.mimi.core.data.di.AppScope
import app.mimi.core.data.net.MimiSocket
import app.mimi.core.data.repo.ChatRepository
import app.mimi.core.data.repo.PushRepository
import app.mimi.feature.mimiamp.MimiampCommands
import app.mimi.feature.mimiamp.PlayerConnection
import coil.ImageLoader
import coil.ImageLoaderFactory
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import javax.inject.Inject

@HiltAndroidApp
class MimiApp : Application(), Configuration.Provider, ImageLoaderFactory {
    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var client: OkHttpClient
    @Inject lateinit var sessions: SessionStore
    @Inject lateinit var socket: MimiSocket
    @Inject lateinit var chats: ChatRepository
    @Inject lateinit var push: PushRepository
    @Inject lateinit var mimiamp: MimiampCommands
    @Inject lateinit var player: PlayerConnection
    @Inject lateinit var widget: WidgetSync
    @Inject @field:AppScope lateinit var scope: CoroutineScope

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()

    /** Pictures load through the same HTTP client, so the token goes with them (and only to the server). */
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this).okHttpClient(client).crossfade(true).build()

    private var parking: Job? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        mimiamp.start(scope)
        if (sessions.session.value.token != null) signedIn()
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                parking?.cancel()
                if (sessions.session.value.token != null) socket.wake()
            }

            override fun onStop(owner: LifecycleOwner) {
                // Off screen: tell the core (so it notifies), then let the socket go after a minute;
                // notifications come by push or the poll, and Mimiamp keeps playing by itself.
                chats.presence(null, false)
                parking = scope.launch {
                    delay(60_000)
                    socket.stop()
                    widget.refresh()
                }
            }
        })
        // A token the core turned down (signed out elsewhere, expired) is forgotten here too.
        scope.launch {
            socket.state.distinctUntilChangedBy { it::class }.collect { state ->
                if (state is app.mimi.core.data.net.SocketState.SignedOut) {
                    sessions.signOut()
                    widget.clear()
                }
            }
        }
    }

    /** After sign-in (or at start when signed in): socket, push token, notification poll, widget. */
    fun signedIn() {
        socket.start()
        NotificationWorker.schedule(this)
        MimiMessagingService.init(this, push)
        scope.launch { runCatching { push.newNotifications() } ; widget.refresh() }
    }

    fun signedOut() {
        NotificationWorker.cancel(this)
        widget.clear()
        scope.launch { runCatching { player.stop() } }
    }
}
