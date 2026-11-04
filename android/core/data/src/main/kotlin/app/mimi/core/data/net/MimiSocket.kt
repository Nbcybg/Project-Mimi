package app.mimi.core.data.net

import app.mimi.core.data.AppInfo
import app.mimi.core.data.SessionStore
import app.mimi.core.data.di.AppScope
import app.mimi.core.model.CloseCodes
import app.mimi.core.model.ClientFrames
import app.mimi.core.model.MIN_SUPPORTED_CORE_API
import app.mimi.core.model.ServerFrame
import app.mimi.core.model.parseServerFrame
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import javax.inject.Inject
import javax.inject.Singleton

/** What the reconnect rules do with a close code (realtime.md 7.4). */
internal enum class RetryDecision { Reconnect, Stop, WaitRateLimit }

internal fun reconnectDecision(code: Int?): RetryDecision = when (code) {
    CloseCodes.INVALID_TOKEN, CloseCodes.CLIENT_TOO_OLD -> RetryDecision.Stop
    CloseCodes.RATE_LIMITED -> RetryDecision.WaitRateLimit
    else -> RetryDecision.Reconnect
}

/**
 * The one WebSocket to `/ws` (docs/native/realtime.md): `hello` first, an app-level ping every 25 s,
 * backoff 1 s doubling to 15 s, no retry after 4003/4426, and a 15-minute wait after 4029.
 * Frames are handed to [frames]; the repositories ask for what they need after `welcome`.
 */
@Singleton
class MimiSocket @Inject constructor(
    private val client: OkHttpClient,
    private val sessions: SessionStore,
    private val info: AppInfo,
    @AppScope private val scope: CoroutineScope,
) {
    private sealed interface Event {
        data class Text(val text: String) : Event
        data class Closed(val code: Int?, val reason: String?) : Event
    }

    private val lock = Any()
    private val _state = MutableStateFlow<SocketState>(SocketState.Idle)
    val state: StateFlow<SocketState> = _state.asStateFlow()

    private val _frames = MutableSharedFlow<ServerFrame>(extraBufferCapacity = 64)
    val frames: Flow<ServerFrame> = _frames.asSharedFlow()

    private val resumedFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** Emitted when `wake()` decided the socket is healthy and the screen should catch up. */
    internal val resumed: SharedFlow<Unit> = resumedFlow.asSharedFlow()

    private var job: Job? = null
    private var webSocket: WebSocket? = null
    private var generation = 0
    private var wanted = false
    private var retryMs = BASE_RETRY_MS
    private val waiting = ArrayDeque<String>()

    @Volatile
    private var lastTraffic = 0L

    @Volatile
    private var presenceChat: Long? = null

    @Volatile
    private var presenceVisible = false

    fun start() {
        val session = sessions.session.value
        if (session.token == null || session.server.isBlank()) return
        val started: Job
        synchronized(lock) {
            wanted = true
            if (job?.isActive == true) return
            generation++
            val gen = generation
            started = scope.launch(start = CoroutineStart.LAZY) { run(gen) }
            job = started
        }
        started.start()
    }

    fun stop() {
        val socket: WebSocket?
        synchronized(lock) {
            wanted = false
            generation++
            job?.cancel()
            job = null
            socket = webSocket
            webSocket = null
            waiting.clear()
            retryMs = BASE_RETRY_MS
        }
        socket?.close(NORMAL_CLOSE, "sign out")
        _state.value = SocketState.Idle
    }

    /**
     * The app came back to the foreground: a socket that heard nothing for more than 12 s is
     * presumed dead and replaced now; a healthy one just catches up (presence and the open chat).
     */
    fun wake() {
        val session = sessions.session.value
        if (session.token == null || session.server.isBlank()) return
        val current = _state.value
        if (current is SocketState.SignedOut || current is SocketState.AppTooOld || current is SocketState.CoreTooOld) return
        val socket: WebSocket?
        val running: Boolean
        synchronized(lock) {
            socket = webSocket
            running = job?.isActive == true
        }
        if (running && socket != null) {
            if (System.currentTimeMillis() - lastTraffic > WAKE_STALE_MS) {
                synchronized(lock) {
                    generation++
                    job?.cancel()
                    job = null
                    webSocket = null
                    retryMs = BASE_RETRY_MS
                }
                socket.cancel()
                start()
            } else {
                presence(presenceChat, presenceVisible)
                resumedFlow.tryEmit(Unit)
            }
        } else {
            synchronized(lock) { retryMs = BASE_RETRY_MS }
            start()
        }
    }

    /** Whether the person is looking at a chat; sent now when online and again after every welcome (realtime.md 7.2). */
    fun presence(chatId: Long?, visible: Boolean) {
        presenceChat = chatId
        presenceVisible = visible
        if (_state.value is SocketState.Online) send(ClientFrames.presence(chatId, visible))
    }

    /** Sends now, or once the next `welcome` arrives (at most 100 waiting frames). */
    fun send(json: String): Boolean {
        val socket = synchronized(lock) { webSocket }
        if (_state.value is SocketState.Online && socket != null && socket.send(json)) return true
        synchronized(lock) {
            if (!wanted || sessions.session.value.token == null) return false
            if (waiting.size >= 100) return false
            waiting.addLast(json)
            return true
        }
    }

    private suspend fun run(gen: Int) {
        val snapshot = sessions.session.value
        val token = snapshot.token ?: return
        val server = snapshot.server
        if (server.isBlank()) return
        val url = runCatching { ServerAddress.socket(server) }.getOrNull()
        if (url == null) {
            _state.value = SocketState.Offline("ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง")
            return
        }
        val events = Channel<Event>(Channel.UNLIMITED)
        val listener = object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                events.trySend(Event.Text(text))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(NORMAL_CLOSE, null)
                events.trySend(Event.Closed(code, reason))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                events.trySend(Event.Closed(code, reason))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                events.trySend(Event.Closed(NETWORK_CLOSE, t.message))
            }
        }

        _state.value = SocketState.Connecting
        // OkHttp's HttpUrl speaks http(s) and performs the WebSocket upgrade; ws(s) is the public URL.
        val httpUrl = url.replaceFirst("wss://", "https://").replaceFirst("ws://", "http://")
        val socket = runCatching { client.newWebSocket(Request.Builder().url(httpUrl).build(), listener) }.getOrElse {
            _state.value = SocketState.Offline("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
            return
        }
        synchronized(lock) { if (gen == generation) webSocket = socket }
        lastTraffic = System.currentTimeMillis()
        socket.send(ClientFrames.hello(token, info.versionName))

        val heartbeat = scope.launch {
            while (isActive) {
                delay(PING_MS)
                if (System.currentTimeMillis() - lastTraffic > DEAD_MS) {
                    socket.cancel()
                    break
                }
                socket.send(ClientFrames.simple("ping"))
            }
        }

        var closeCode: Int? = null
        try {
            for (event in events) {
                if (gen != generation) break
                when (event) {
                    is Event.Text -> {
                        lastTraffic = System.currentTimeMillis()
                        handleText(event.text, socket)
                    }
                    is Event.Closed -> {
                        closeCode = event.code
                        break
                    }
                }
            }
        } catch (cancel: CancellationException) {
            throw cancel
        } finally {
            heartbeat.cancel()
            events.close()
            synchronized(lock) { if (webSocket === socket) webSocket = null }
            socket.cancel()
        }
        if (gen != generation) return
        ended(gen, closeCode)
    }

    private suspend fun handleText(text: String, socket: WebSocket) {
        val frame = parseServerFrame(text)
        if (frame is ServerFrame.Welcome) {
            if (frame.api < MIN_SUPPORTED_CORE_API) {
                synchronized(lock) { wanted = false }
                _state.value = SocketState.CoreTooOld(frame.api)
                socket.close(NORMAL_CLOSE, "core too old")
                return
            }
            val queued: List<String>
            synchronized(lock) {
                retryMs = BASE_RETRY_MS
                queued = waiting.toList()
                waiting.clear()
            }
            _state.value = SocketState.Online(frame.version, frame.api)
            for (json in queued) socket.send(json)
            // What the chat screens need on every (re)connect (realtime.md 2.1/7.3).
            socket.send(ClientFrames.simple("chats-list"))
            socket.send(ClientFrames.simple("agents-list"))
            socket.send(ClientFrames.presence(presenceChat, presenceVisible))
        }
        _frames.emit(frame)
    }

    private fun ended(gen: Int, code: Int?) {
        var retryIn: Long? = null
        synchronized(lock) {
            if (gen != generation) return
            job = null
            if (!wanted) return
            when (reconnectDecision(code)) {
                RetryDecision.Stop -> {
                    _state.value = if (code == CloseCodes.CLIENT_TOO_OLD) SocketState.AppTooOld else SocketState.SignedOut
                    return
                }
                RetryDecision.WaitRateLimit -> {
                    _state.value = SocketState.RateLimited
                    retryIn = RATE_LIMIT_WAIT_MS
                }
                RetryDecision.Reconnect -> {
                    _state.value = SocketState.Offline(reasonFor(code))
                    retryIn = retryMs
                    retryMs = (retryMs * 2).coerceAtMost(MAX_RETRY_MS)
                }
            }
        }
        val delayMs = retryIn ?: return
        scope.launch {
            delay(delayMs)
            val go = synchronized(lock) { wanted && gen == generation }
            if (go) start()
        }
    }

    private fun reasonFor(code: Int?): String = when (code) {
        CloseCodes.HELLO_TIMEOUT -> "เซิร์ฟเวอร์ไม่ได้รับ hello"
        CloseCodes.GATEWAY_CORE_REFUSED -> "เซิร์ฟเวอร์มีปัญหา กำลังเชื่อมต่อใหม่"
        1013 -> "เซิร์ฟเวอร์ยังไม่พร้อม กำลังเชื่อมต่อใหม่"
        null, 1005, NETWORK_CLOSE -> "การเชื่อมต่อหลุด"
        else -> "การเชื่อมต่อหลุด ($code)"
    }

    private companion object {
        const val BASE_RETRY_MS = 1_000L
        const val MAX_RETRY_MS = 15_000L
        const val RATE_LIMIT_WAIT_MS = 15 * 60_000L
        const val PING_MS = 25_000L
        const val DEAD_MS = 30_000L
        const val WAKE_STALE_MS = 12_000L
        const val NORMAL_CLOSE = 1000
        const val NETWORK_CLOSE = 1006
    }
}
