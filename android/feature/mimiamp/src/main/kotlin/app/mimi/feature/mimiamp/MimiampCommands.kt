package app.mimi.feature.mimiamp

import app.mimi.core.data.net.MimiSocket
import app.mimi.core.data.repo.MimiampRepository
import app.mimi.core.model.MimiampCommand
import app.mimi.core.model.MimiampTrack
import app.mimi.core.model.ServerFrame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Finds the song an agent named (`mimiamp play {query}`), the way the web player does: an exact
 * id / title / artist / album / file / video id first, then the first one that contains the words.
 */
fun findTrack(tracks: List<MimiampTrack>, query: String): MimiampTrack? {
    val wanted = query.trim().lowercase()
    if (wanted.isEmpty()) return null
    val fields = { track: MimiampTrack -> listOfNotNull(track.id, track.title, track.artist, track.album, track.file, track.videoId).map { it.lowercase() } }
    return tracks.firstOrNull { wanted in fields(it) } ?: tracks.firstOrNull { track -> fields(track).any { wanted in it } }
}

/** What an agent asks of the player over the socket (protocol.ts MimiampCommand, media.md 1.4). */
@Singleton
class MimiampCommands @Inject constructor(
    private val socket: MimiSocket,
    private val library: MimiampRepository,
    private val player: PlayerConnection,
) {
    private val openRequests = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    /** The agent asked to show the player: the app navigates there. */
    val open: SharedFlow<Unit> = openRequests

    fun start(scope: CoroutineScope) {
        scope.launch {
            socket.frames.collect { frame ->
                if (frame is ServerFrame.Mimiamp) launch(Dispatchers.Main) { runCatching { apply(frame.command) } }
            }
        }
    }

    suspend fun apply(command: MimiampCommand) {
        when (command.action) {
            "refresh" -> library.refresh()
            "open" -> openRequests.tryEmit(Unit)
            "pause" -> player.pause()
            "stop" -> player.stop()
            "next" -> player.next()
            "previous" -> player.previous()
            "volume" -> command.level?.let { player.setVolume((it / 100).toFloat()) }
            "seek" -> command.seconds?.let { player.seekTo((it * 1000).toLong()) }
            "playlist-play" -> {
                val state = library.refresh()
                val playlist = state.playlists.firstOrNull { it.id == command.query } ?: state.playlists.firstOrNull { it.name == command.query } ?: return
                player.playQueue(playlist.items.mapNotNull(library::trackFor), 0)
            }
            "play" -> {
                val query = command.query
                if (query.isNullOrBlank()) return player.play()
                val tracks = library.state.value.tracks.ifEmpty { library.refresh().tracks }
                val found = findTrack(tracks, query) ?: findTrack(library.refresh().tracks, query) ?: return
                val all = library.state.value.tracks
                player.playQueue(all, all.indexOfFirst { it.id == found.id }.coerceAtLeast(0))
            }
        }
    }
}
