package app.mimi.core.data.repo

import app.mimi.core.data.SessionStore
import app.mimi.core.data.di.AppScope
import app.mimi.core.data.net.MimiSocket
import app.mimi.core.data.net.SocketState
import app.mimi.core.model.ChatTimeline
import app.mimi.core.model.ChatView
import app.mimi.core.model.ClientFrames
import app.mimi.core.model.PendingMessage
import app.mimi.core.model.ServerFrame
import app.mimi.core.model.addPending
import app.mimi.core.model.reduce
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import app.mimi.core.model.SearchHit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The chat screens' state, fed by [MimiSocket] (docs/native/realtime.md 4 and 7.3): the chat list,
 * the agents, who is busy, and one folded [ChatTimeline] per open chat.
 */
@Singleton
class ChatRepository @Inject constructor(
    private val socket: MimiSocket,
    private val sessions: SessionStore,
    @AppScope private val scope: CoroutineScope,
) {
    private val _chats = MutableStateFlow<List<ChatView>>(emptyList())
    val chats: StateFlow<List<ChatView>> = _chats.asStateFlow()

    private val _agents = MutableStateFlow<List<app.mimi.core.model.AgentView>>(emptyList())
    val agents: Flow<List<app.mimi.core.model.AgentView>> = _agents.asStateFlow()

    private val _busyChats = MutableStateFlow<Set<Long>>(emptySet())
    val busyChats: Flow<Set<Long>> = _busyChats.asStateFlow()

    private val _rewound = MutableSharedFlow<ServerFrame.Rewound>(extraBufferCapacity = 4)

    /** The text of a message taken back by `rewind` (to edit and send again), with the files restored. */
    val rewound: SharedFlow<ServerFrame.Rewound> = _rewound.asSharedFlow()

    private val timelines = ConcurrentHashMap<Long, MutableStateFlow<ChatTimeline>>()
    private val active = ConcurrentHashMap.newKeySet<Long>()
    private val references = ConcurrentHashMap<Long, Int>()
    private val waitingDirect = ConcurrentHashMap<String, CompletableDeferred<Long>>()
    private val nextClient = AtomicInteger()

    @Volatile
    private var coreApi = 0

    init {
        // UNDISPATCHED so the subscriptions exist before the app starts the socket.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            socket.frames.collect(::onFrame)
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            socket.resumed.collect { catchUp() }
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            socket.state.collect { state ->
                if (state is SocketState.Online) coreApi = state.api
            }
        }
    }

    /** The timeline of an open chat; collecting it opens the chat on the socket. */
    fun open(chatId: Long): Flow<ChatTimeline> = flow {
        val timeline = retain(chatId)
        try {
            socket.send(ClientFrames.chatOpen(chatId))
            emitAll(timeline)
        } finally {
            release(chatId)
        }
    }

    /** Opens (or creates) the direct chat with an agent; null when the core did not answer. */
    suspend fun directChat(agent: String): Long? {
        val answer = CompletableDeferred<Long>()
        waitingDirect[agent] = answer
        return try {
            socket.send(ClientFrames.chatCreateDirect(agent))
            withTimeoutOrNull(DIRECT_CHAT_TIMEOUT_MS) { answer.await() }
        } finally {
            waitingDirect.remove(agent, answer)
        }
    }

    fun presence(chatId: Long?, visible: Boolean) = socket.presence(chatId, visible)

    /** Searches every session of every chat; null when the core did not answer in time. */
    suspend fun search(query: String): List<SearchHit>? = coroutineScope {
        // The answer must not slip past before this listens, so the listener starts first.
        val answer = async(start = CoroutineStart.UNDISPATCHED) {
            socket.frames.filterIsInstance<ServerFrame.SearchResults>().first { it.query == query }
        }
        socket.send(ClientFrames.search(query))
        withTimeoutOrNull(SEARCH_TIMEOUT_MS) { answer.await() }?.hits.also { if (it == null) answer.cancel() }
    }

    /** Shows another session of the chat on screen (null = the newest). */
    fun openSession(chatId: Long, sessionId: Long?) {
        socket.send(ClientFrames.chatOpen(chatId, sessionId))
        askContext(chatId, sessionId)
    }

    /** Starts a new session; from an older one the screen goes to the newest first so the turn lands there. */
    fun newSession(chatId: Long) {
        if (timelines[chatId]?.value?.latest == false) socket.send(ClientFrames.chatOpen(chatId))
        socket.send(ClientFrames.sessionNew(chatId))
    }

    /** Takes back a message and what followed it; the core answers with `rewound` and reopens the chat. */
    fun rewind(chatId: Long, messageId: Long) {
        val session = timelines[chatId]?.value?.session ?: return
        socket.send(ClientFrames.rewind(session.id, messageId))
    }

    /** The size of the session on screen, for the meter. */
    fun askContext(chatId: Long, sessionId: Long? = timelines[chatId]?.value?.session?.id) {
        socket.send(ClientFrames.sessionContext(chatId, sessionId))
    }

    fun loadOlder(chatId: Long) {
        val timeline = timelines[chatId]?.value ?: return
        val first = timeline.messages.firstOrNull()?.id ?: return
        socket.send(ClientFrames.chatOpen(chatId, timeline.session?.id, beforeId = first))
    }

    fun send(chatId: Long, text: String, attachmentIds: List<String>, attachmentNames: List<String>, replyTo: Long? = null) {
        val clientId = "a-${System.currentTimeMillis().toString(16)}-${nextClient.incrementAndGet()}"
        timeline(chatId).update { it.addPending(PendingMessage(clientId, text, attachmentNames)) }
        socket.send(ClientFrames.chatSend(chatId, text, attachmentIds, clientId, replyTo))
    }

    /** Pins or unpins a message; the core answers with `message-marks` to every device. */
    fun pin(messageId: Long, pinned: Boolean) {
        socket.send(ClientFrames.messagePin(messageId, pinned))
    }

    /** Adds the emoji to a message, or removes it when it is already there. */
    fun react(messageId: Long, emoji: String) {
        socket.send(ClientFrames.messageReact(messageId, emoji))
    }

    /** pause | resume | cancel of a task card. */
    fun taskControl(taskId: String, action: String) {
        socket.send(ClientFrames.taskControl(taskId, action))
    }

    /** Puts back the files a finished task moved. */
    fun taskUndo(taskId: String) {
        socket.send(ClientFrames.taskUndo(taskId))
    }

    fun abort(chatId: Long) {
        socket.send(ClientFrames.abort(chatId))
    }

    fun answerPermission(requestId: String, allow: Boolean, scope: String) {
        socket.send(ClientFrames.permissionResponse(requestId, allow, scope))
    }

    fun decideApproval(id: Long, approved: Boolean) {
        socket.send(ClientFrames.approvalDecide(id, approved))
    }

    /** The latest folded timeline of a chat, for tests and diagnostics. */
    internal fun timelineOf(chatId: Long): ChatTimeline? = timelines[chatId]?.value

    private fun retain(chatId: Long): MutableStateFlow<ChatTimeline> {
        val timeline = timeline(chatId)
        active.add(chatId)
        references.merge(chatId, 1) { old, add -> old + add }
        return timeline
    }

    private fun release(chatId: Long) {
        val left = references.merge(chatId, -1) { old, remove -> old + remove } ?: 0
        if (left <= 0) {
            references.remove(chatId)
            active.remove(chatId)
            timelines.remove(chatId)
        }
    }

    private fun timeline(chatId: Long): MutableStateFlow<ChatTimeline> =
        timelines.computeIfAbsent(chatId) { MutableStateFlow(ChatTimeline(chatId)) }

    private suspend fun onFrame(frame: ServerFrame) {
        when (frame) {
            is ServerFrame.Welcome -> {
                coreApi = frame.api
                _busyChats.value = frame.busyChats.toSet()
                if (_agents.value.isEmpty() && frame.agents.isNotEmpty()) {
                    _agents.value = frame.agents.map {
                        app.mimi.core.model.AgentView(it.name, it.displayName, it.description)
                    }
                }
                for (chatId in active) reopen(chatId)
            }
            is ServerFrame.Rewound -> {
                _rewound.emit(frame)
                // The taken-back messages are hidden on the core: a full reload (not `afterId`, which only adds) drops them here too.
                if (frame.chatId in active) socket.send(ClientFrames.chatOpen(frame.chatId))
            }
            is ServerFrame.Chats -> _chats.value = frame.chats
            is ServerFrame.Agents -> _agents.value = frame.agents
            is ServerFrame.Busy -> updateBusy(frame)
            is ServerFrame.ChatHistory -> completeDirectChat(frame)
            is ServerFrame.ChatChanged -> {
                val timeline = timelines[frame.chatId]?.value
                if (frame.chatId in active && timeline != null && !timeline.busy) reopen(frame.chatId)
            }
            else -> Unit
        }
        for (chatId in active) {
            timelines[chatId]?.update { it.reduce(frame) }
        }
    }

    private fun updateBusy(frame: ServerFrame.Busy) {
        val chatId = frame.chatId
        if (chatId == null) {
            _busyChats.value = emptySet()
            return
        }
        _busyChats.update { if (frame.done) it - chatId else it + chatId }
        // A core before api 1 has no chat-turn-messages: the stored answer comes with chat-open.
        if (frame.done && coreApi < 1 && chatId in active) reopen(chatId)
    }

    private fun completeDirectChat(frame: ServerFrame.ChatHistory) {
        if (frame.chat.kind != "direct") return
        for (agent in frame.chat.agents) {
            waitingDirect.remove(agent)?.complete(frame.chat.id)
        }
    }

    private fun reopen(chatId: Long) {
        val timeline = timelines[chatId]?.value ?: return
        val sessionId = timeline.session?.id
        val last = timeline.lastMessageId
        val frame = if (coreApi >= 1 && sessionId != null && last != null) {
            ClientFrames.chatOpen(chatId, sessionId, afterId = last)
        } else {
            ClientFrames.chatOpen(chatId)
        }
        socket.send(frame)
    }

    /** Back on screen with a healthy socket: re-fetch every open chat. */
    private fun catchUp() {
        for (chatId in active) reopen(chatId)
    }

    private companion object {
        const val DIRECT_CHAT_TIMEOUT_MS = 15_000L
        const val SEARCH_TIMEOUT_MS = 10_000L
    }
}
