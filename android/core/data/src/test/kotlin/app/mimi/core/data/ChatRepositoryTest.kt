package app.mimi.core.data

import app.mimi.core.data.net.MimiSocket
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.MockResponse
import okhttp3.WebSocketListener
import okhttp3.WebSocket
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.first
import app.mimi.core.data.net.SocketState
import app.mimi.core.data.repo.ChatRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatRepositoryTest {
    @Test
    fun `send adds a pending bubble with its own client id before the core echoes it`() = runBlocking {
        val sessions = MemorySessionStore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val socket = MimiSocket(OkHttpClient(), sessions, AppInfo("1.0.0", ""), scope)
        val repository = ChatRepository(socket, sessions, scope)
        try {
            val collector = launch { repository.open(7).collect { } }
            yield()

            repository.send(7, "สวัสดี", listOf("file-1"), listOf("note.txt"))

            val pending = repository.timelineOf(7)?.pending.orEmpty()
            assertEquals(1, pending.size)
            assertEquals("สวัสดี", pending.first().text)
            assertEquals(listOf("note.txt"), pending.first().attachmentNames)
            assertEquals(true, pending.first().clientId.isNotBlank())
            collector.cancel()
        } finally {
            socket.stop()
            scope.cancel()
        }
    }

    /** A core that welcomes the app and answers a search with one hit. */
    private fun fakeCore(): MockWebServer {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    when {
                        "\"type\":\"hello\"" in text -> webSocket.send("""{"type":"welcome","agents":[],"defaultAgent":"mimi","busyChats":[],"pendingPermissions":[],"api":2,"minClientApi":1}""")
                        "\"type\":\"search\"" in text -> webSocket.send("""{"type":"search-results","query":"หวัดดี","hits":[{"messageId":4,"chatId":1,"sessionId":2,"snippet":"**หวัดดี**ค่ะ","role":"assistant","agent":"mimi","createdAt":"x"}]}""")
                    }
                }
            }),
        )
        server.start()
        return server
    }

    @Test
    fun `a search waits for the answer to its own query`() = runBlocking {
        val server = fakeCore()
        val sessions = MemorySessionStore().apply { save(Session(server.url("/").toString().trimEnd('/'), "token", ""), remember = true) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val socket = MimiSocket(OkHttpClient(), sessions, AppInfo("1.0.0", ""), scope)
        val repository = ChatRepository(socket, sessions, scope)
        try {
            socket.start()
            socket.state.first { it is SocketState.Online }
            val hits = withTimeout(10_000) { repository.search("หวัดดี") }
            assertEquals(listOf(4L), hits?.map { it.messageId })
        } finally {
            socket.stop()
            scope.cancel()
            runCatching { server.shutdown() } // the open socket keeps its queue busy; the answer was already checked
        }
    }
}
