package app.mimi.feature.mimiamp

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import app.mimi.core.data.SessionStore
import dagger.hilt.android.AndroidEntryPoint
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject

/**
 * Mimiamp's player, alive while music plays even with the app closed: Media3 ExoPlayer in a
 * MediaSessionService (media notification, lock screen, headset buttons). Songs stream from the
 * core with the token and Range requests (media.md 1.3); a YouTube song is first downloaded to
 * the core's cache by `POST …/prepare`, done here on the loader thread right before it plays.
 */
@AndroidEntryPoint
class PlaybackService : MediaSessionService() {
    @Inject lateinit var client: OkHttpClient
    @Inject lateinit var sessions: SessionStore
    @Inject lateinit var equalizer: Equalizer10

    private var session: MediaSession? = null

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        val http = OkHttpDataSource.Factory(client)
        val prepared = HashSet<String>()
        val source = ResolvingDataSource.Factory(http) { spec: DataSpec ->
            youtubeId(spec.uri)?.let { id ->
                if (prepared.add(id)) {
                    val server = sessions.session.value.server
                    runCatching {
                        client.newCall(Request.Builder().url("$server/api/mimiamp/youtube/$id/prepare").post(ByteArray(0).toRequestBody()).build()).execute().close()
                    }.onFailure { prepared.remove(id) }
                }
            }
            spec
        }
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(source))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(object : Player.Listener {
            override fun onAudioSessionIdChanged(audioSessionId: Int) = equalizer.attach(audioSessionId)
        })
        equalizer.attach(player.audioSessionId)
        val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            putExtra("open", "mimiamp")
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        session = MediaSession.Builder(this, player)
            .apply { open?.let { setSessionActivity(PendingIntent.getActivity(this@PlaybackService, 7, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)) } }
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Swiped away from recents: keep playing if it plays, else stop the service. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        equalizer.release()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    companion object {
        private val YOUTUBE = Regex("/mimiamp/youtube/([A-Za-z0-9_-]{11})\\.audio$")
        fun youtubeId(uri: Uri): String? = uri.path?.let { YOUTUBE.find(it)?.groupValues?.get(1) }
    }
}
