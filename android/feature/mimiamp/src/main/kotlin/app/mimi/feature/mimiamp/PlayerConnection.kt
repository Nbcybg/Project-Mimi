package app.mimi.feature.mimiamp

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.mimi.core.data.repo.MimiampRepository
import app.mimi.core.model.MimiampTrack
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

data class NowPlaying(
    val mediaId: String? = null,
    val title: String = "",
    val artist: String = "",
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val shuffle: Boolean = false,
    /** Player.REPEAT_MODE_OFF / ONE / ALL */
    val repeat: Int = Player.REPEAT_MODE_OFF,
    val error: String? = null,
)

/**
 * The app's handle on [PlaybackService]: one MediaController shared by the screen and by the
 * agent's commands, connecting (and so starting the service) on first use.
 */
@Singleton
class PlayerConnection @Inject constructor(
    @ApplicationContext private val context: Context,
    private val library: MimiampRepository,
) {
    private var controller: CompletableDeferred<MediaController>? = null
    private val stateFlow = MutableStateFlow(NowPlaying())
    val state: StateFlow<NowPlaying> = stateFlow.asStateFlow()

    suspend fun get(): MediaController {
        controller?.let { return it.await() }
        val deferred = CompletableDeferred<MediaController>().also { controller = it }
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
            runCatching { future.get() }
                .onSuccess { player ->
                    player.addListener(object : Player.Listener {
                        override fun onEvents(player: Player, events: Player.Events) = publish(player)
                    })
                    publish(player)
                    deferred.complete(player)
                }
                .onFailure {
                    controller = null
                    deferred.completeExceptionally(it)
                }
        }, ContextCompat.getMainExecutor(context))
        return deferred.await()
    }

    /** Position moves without events: the screen asks while it is visible. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun tick() {
        val player = controller?.takeIf { it.isCompleted }?.getCompleted() ?: return
        publish(player)
    }

    private fun publish(player: Player) {
        val item = player.currentMediaItem
        stateFlow.value = NowPlaying(
            mediaId = item?.mediaId,
            title = item?.mediaMetadata?.title?.toString().orEmpty(),
            artist = item?.mediaMetadata?.artist?.toString().orEmpty(),
            playing = player.isPlaying,
            buffering = player.playbackState == Player.STATE_BUFFERING,
            positionMs = player.currentPosition.coerceAtLeast(0),
            durationMs = player.duration.takeIf { it > 0 } ?: 0,
            shuffle = player.shuffleModeEnabled,
            repeat = player.repeatMode,
            error = player.playerError?.let { "เล่นไม่ได้: ${it.errorCodeName}" },
        )
    }

    fun mediaItem(track: MimiampTrack): MediaItem = MediaItem.Builder()
        .setMediaId(track.id)
        .setUri(library.streamUrl(track))
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(track.title)
                .setArtist(track.artist ?: if (track.source == "youtube") "YouTube" else null)
                .setAlbumTitle(track.album ?: "Mimiamp")
                .apply { track.thumbnail?.let { setArtworkUri(Uri.parse(it)) } }
                .build(),
        )
        .build()

    /** Replaces the queue and plays from `index`. */
    suspend fun playQueue(tracks: List<MimiampTrack>, index: Int) {
        if (tracks.isEmpty()) return
        val player = get()
        player.setMediaItems(tracks.map(::mediaItem), index.coerceIn(0, tracks.lastIndex), 0)
        player.prepare()
        player.play()
    }

    suspend fun toggle() = get().run { if (isPlaying) pause() else { if (playbackState == Player.STATE_IDLE) prepare(); play() } }
    suspend fun next() = get().seekToNextMediaItem()
    suspend fun previous() = get().seekToPreviousMediaItem()
    suspend fun pause() = get().pause()
    suspend fun play() = get().run { if (playbackState == Player.STATE_IDLE) prepare(); play() }
    suspend fun stop() = get().run { stop(); seekTo(0) }
    suspend fun seekTo(ms: Long) = get().seekTo(ms)
    suspend fun setVolume(level: Float) = get().setVolume(level.coerceIn(0f, 1f))
    suspend fun setShuffle(on: Boolean) = get().setShuffleModeEnabled(on)
    suspend fun cycleRepeat() = get().run {
        repeatMode = when (repeatMode) {
            Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
            Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
    }
}
