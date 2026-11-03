package app.mimi.feature.mimiamp

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.mimi.core.data.repo.MimiampRepository
import app.mimi.core.model.MimiampPlaylist
import app.mimi.core.model.MimiampState
import app.mimi.core.model.MimiampTrack
import app.mimi.core.model.YoutubeSearchResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject

/** "library" or a playlist id. */
const val LIBRARY = "library"

data class MimiampUi(
    val library: MimiampState = MimiampState(),
    val active: String = LIBRARY,
    val queue: List<MimiampTrack> = emptyList(),
    /** Items of the active playlist whose song is not on this server (a file on another device). */
    val missing: Int = 0,
    val now: NowPlaying = NowPlaying(),
    val eq: EqState = EqState(),
    val loading: Boolean = true,
    val busy: Boolean = false,
    val message: String? = null,
    val search: List<YoutubeSearchResult> = emptyList(),
)

private data class Local(val active: String = LIBRARY, val loading: Boolean = true, val busy: Boolean = false, val message: String? = null, val search: List<YoutubeSearchResult> = emptyList())

@HiltViewModel
class MimiampViewModel @Inject constructor(
    private val library: MimiampRepository,
    private val player: PlayerConnection,
    private val equalizer: Equalizer10,
) : ViewModel() {
    private val local = MutableStateFlow(Local())

    val ui: StateFlow<MimiampUi> = combine(library.state, player.state, equalizer.state, local) { state, now, eq, local ->
        val playlist = state.playlists.firstOrNull { it.id == local.active }
        val queue = playlist?.items?.mapNotNull(library::trackFor) ?: state.tracks
        MimiampUi(
            library = state,
            active = if (playlist == null) LIBRARY else local.active,
            queue = queue,
            missing = (playlist?.items?.size ?: 0) - (if (playlist != null) queue.size else 0),
            now = now,
            eq = eq,
            loading = local.loading,
            busy = local.busy,
            message = local.message ?: now.error,
            search = local.search,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), MimiampUi())

    init {
        refresh()
        viewModelScope.launch {
            while (isActive) {
                player.tick()
                delay(500)
            }
        }
    }

    fun refresh() = work(loading = true) { library.refresh() }

    fun select(list: String) = local.update { it.copy(active = list) }

    fun play(index: Int) = viewModelScope.launch { player.playQueue(ui.value.queue, index) }
    fun toggle() = viewModelScope.launch { if (player.state.value.mediaId == null) player.playQueue(ui.value.queue, 0) else player.toggle() }
    fun next() = viewModelScope.launch { player.next() }
    fun previous() = viewModelScope.launch { player.previous() }
    fun seek(fraction: Float) = viewModelScope.launch { player.seekTo((player.state.value.durationMs * fraction).toLong()) }
    fun shuffle() = viewModelScope.launch { player.setShuffle(!player.state.value.shuffle) }
    fun repeat() = viewModelScope.launch { player.cycleRepeat() }

    fun eqEnabled(on: Boolean) = equalizer.setEnabled(on)
    fun eqGain(band: Int, db: Float) = equalizer.setGain(band, db)
    fun eqPreset(name: String) = equalizer.preset(name)

    fun addYoutube(link: String) = work(message = "เพิ่มเพลงแล้ว") {
        library.addYoutube(link, ui.value.active.takeIf { it != LIBRARY })
        local.update { it.copy(search = emptyList()) }
    }

    fun searchYoutube(query: String) = work {
        val reply = library.searchYoutube(query)
        local.update { it.copy(search = reply.results, message = reply.error) }
    }

    fun createPlaylist(name: String) = work(message = "สร้างเพลย์ลิสต์แล้ว") {
        val made = library.createPlaylist(name.trim())
        local.update { it.copy(active = made.id) }
    }

    fun deletePlaylist(playlist: MimiampPlaylist) = work {
        library.deletePlaylist(playlist.id)
        local.update { it.copy(active = LIBRARY) }
    }

    fun addToPlaylist(playlistId: String, track: MimiampTrack) = work(message = "เพิ่มลงเพลย์ลิสต์แล้ว") { library.addToPlaylist(playlistId, track) }

    fun removeFromActive(track: MimiampTrack) = work {
        val playlist = ui.value.library.playlists.firstOrNull { it.id == ui.value.active } ?: return@work
        val item = playlist.items.firstOrNull { library.trackFor(it)?.id == track.id } ?: return@work
        library.removeFromPlaylist(playlist.id, item.id)
    }

    fun removeYoutube(track: MimiampTrack) = work { track.videoId?.let { library.removeYoutube(it) } }

    fun consumeMessage() = local.update { it.copy(message = null) }

    private fun work(loading: Boolean = false, message: String? = null, block: suspend () -> Unit) = viewModelScope.launch {
        local.update { it.copy(busy = true, loading = loading || it.loading) }
        val result = runCatching { block() }
        local.update {
            it.copy(busy = false, loading = false, message = result.exceptionOrNull()?.let { error -> "ทำไม่ได้: ${error.message}" } ?: message ?: it.message)
        }
    }
}
