package app.mimi.feature.chat

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.mimi.core.data.SessionStore
import app.mimi.core.data.net.MimiSocket
import app.mimi.core.data.net.SocketState
import app.mimi.core.data.repo.ChatRepository
import app.mimi.core.data.repo.FileRepository
import app.mimi.core.model.AgentView
import app.mimi.core.model.AttachmentView
import app.mimi.core.model.ChatTimeline
import app.mimi.core.model.ChatView
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import javax.inject.Inject

/** A chat row as the list shows it. */
data class ChatRow(val chat: ChatView, val title: String, val avatarUrl: String?, val busy: Boolean)

data class ChatListState(
    val rows: List<ChatRow> = emptyList(),
    val agents: List<AgentView> = emptyList(),
    val connection: SocketState = SocketState.Idle,
    val username: String = "",
)

/** The picture of an agent, by path and version stamp (api-contract.md A.5). */
fun avatarPath(agent: AgentView?): String? = agent?.avatar?.let { "/api/agent-image/${Uri.encode(agent.name)}/avatar?v=$it" }

@HiltViewModel
class ChatListViewModel @Inject constructor(
    private val chats: ChatRepository,
    private val files: FileRepository,
    socket: MimiSocket,
    sessions: SessionStore,
) : ViewModel() {
    val state: StateFlow<ChatListState> = combine(chats.chats, chats.agents, chats.busyChats, socket.state, sessions.session) { list, agents, busy, connection, session ->
        val byName = agents.associateBy { it.name }
        ChatListState(
            rows = list.sortedByDescending { it.lastMessageAt.orEmpty() }.map { chat ->
                val first = byName[chat.agents.firstOrNull()]
                val title = chat.title.ifBlank {
                    if (chat.kind == "direct") first?.shownName ?: chat.agents.firstOrNull().orEmpty()
                    else chat.agents.joinToString(", ") { byName[it]?.shownName ?: it }
                }
                ChatRow(chat, title, avatarPath(first)?.let(files::url), chat.id in busy)
            },
            agents = agents.filter { it.name != "overseer" },
            connection = connection,
            username = session.username,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ChatListState())

    /** Opens (or creates) the direct chat with an agent; null when the core did not answer. */
    suspend fun directChat(agent: String): Long? = chats.directChat(agent)
}

/** A file picked for the next message: uploading, ready, or failed. */
data class Staged(val key: String, val name: String, val attachment: AttachmentView? = null, val error: String? = null)

data class ChatUiState(
    val timeline: ChatTimeline,
    val title: String = "",
    val agents: Map<String, AgentView> = emptyMap(),
    val staged: List<Staged> = emptyList(),
    val recording: Boolean = false,
    val toast: String? = null,
    val connection: SocketState = SocketState.Idle,
)

@HiltViewModel
class ChatViewModel @Inject constructor(
    saved: SavedStateHandle,
    private val chats: ChatRepository,
    private val files: FileRepository,
    socket: MimiSocket,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    val chatId: Long = checkNotNull(saved.get<Long>("chatId"))
    private val extra = MutableStateFlow(ChatUiState(ChatTimeline(chatId)))
    private val recorder = WavRecorder()

    val state: StateFlow<ChatUiState> = combine(chats.open(chatId), chats.agents, socket.state, extra) { timeline, agents, connection, local ->
        val byName = agents.associateBy { it.name }
        val chat = timeline.chat ?: chats.chats.value.firstOrNull { it.id == chatId }
        val title = chat?.title?.ifBlank { null } ?: chat?.agents?.joinToString(", ") { byName[it]?.shownName ?: it }.orEmpty()
        local.copy(timeline = timeline, title = title, agents = byName, connection = connection)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, extra.value)

    fun fileUrl(attachment: AttachmentView): String = files.fileUrl(attachment)
    fun url(path: String): String = files.url(path)

    fun onScreen(visible: Boolean) = chats.presence(if (visible) chatId else null, visible)

    fun loadOlder() = chats.loadOlder(chatId)

    fun send(text: String) {
        val ready = extra.value.staged.filter { it.attachment != null }
        if (text.isBlank() && ready.isEmpty()) return
        if (extra.value.staged.any { it.attachment == null && it.error == null }) {
            extra.update { it.copy(toast = "รอให้อัปโหลดไฟล์เสร็จก่อน") }
            return
        }
        chats.send(chatId, text.trim(), ready.map { it.attachment!!.id }, ready.map { it.name })
        extra.update { it.copy(staged = emptyList()) }
    }

    fun abort() = chats.abort(chatId)

    fun answerPermission(requestId: String, allow: Boolean, scope: String) = chats.answerPermission(requestId, allow, scope)

    fun decideApproval(id: Long, approved: Boolean) = chats.decideApproval(id, approved)

    fun unstage(key: String) = extra.update { state -> state.copy(staged = state.staged.filterNot { it.key == key }) }

    fun consumeToast() = extra.update { it.copy(toast = null) }

    /** Uploads picked files right away, so sending is instant. */
    fun stage(uris: List<Uri>) {
        for (uri in uris) {
            val key = uri.toString() + System.nanoTime()
            val name = displayName(uri)
            extra.update { it.copy(staged = it.staged + Staged(key, name)) }
            viewModelScope.launch {
                val result = runCatching {
                    val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
                    val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)!!.use { it.readBytes() } }
                    if (bytes.size > 25 * 1024 * 1024) error("ไฟล์ใหญ่เกิน 25 MB")
                    files.upload(name, mime, bytes)
                }
                extra.update { state ->
                    state.copy(staged = state.staged.map {
                        if (it.key != key) it else result.fold({ done -> it.copy(attachment = done) }, { error -> it.copy(error = error.message ?: "อัปโหลดไม่ได้") })
                    })
                }
            }
        }
    }

    fun startRecording() {
        runCatching { recorder.start() }.onSuccess { extra.update { it.copy(recording = true) } }
            .onFailure { error -> extra.update { it.copy(toast = "อัดเสียงไม่ได้: ${error.message}") } }
    }

    fun recordLevel(): Float = recorder.level

    /** Stops recording; `send` uploads the WAV and sends it as a voice message at once. */
    fun stopRecording(send: Boolean) {
        val wav = recorder.stop(keep = send)
        extra.update { it.copy(recording = false) }
        if (wav == null) {
            if (send) extra.update { it.copy(toast = "เสียงสั้นเกินไป") }
            return
        }
        viewModelScope.launch {
            runCatching { files.upload("voice-${System.currentTimeMillis()}.wav", "audio/wav", wav) }
                .onSuccess { chats.send(chatId, "", listOf(it.id), listOf(it.name)) }
                .onFailure { error -> extra.update { it.copy(toast = "ส่งเสียงไม่ได้: ${error.message}") } }
        }
    }

    /** Downloads a file to the cache for viewing or sharing. */
    suspend fun download(attachment: AttachmentView): Result<File> = runCatching { files.download(attachment) }

    private fun displayName(uri: Uri): String =
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        } ?: uri.lastPathSegment ?: "file"

    override fun onCleared() {
        recorder.stop(keep = false)
        chats.presence(null, true)
    }
}
