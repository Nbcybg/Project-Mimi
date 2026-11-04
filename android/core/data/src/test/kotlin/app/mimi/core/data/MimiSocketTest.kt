package app.mimi.core.data

import app.mimi.core.data.net.MimiSocket
import app.mimi.core.data.net.RetryDecision
import app.mimi.core.data.net.SocketState
import app.mimi.core.data.net.reconnectDecision
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Test

class MimiSocketTest {
    @Test
    fun `4003 and 4426 stop, 4029 waits, the rest reconnect`() {
        assertEquals(RetryDecision.Stop, reconnectDecision(4003))
        assertEquals(RetryDecision.Stop, reconnectDecision(4426))
        assertEquals(RetryDecision.WaitRateLimit, reconnectDecision(4029))
        assertEquals(RetryDecision.Reconnect, reconnectDecision(4502))
        assertEquals(RetryDecision.Reconnect, reconnectDecision(1013))
        assertEquals(RetryDecision.Reconnect, reconnectDecision(1006))
    }

    @Test
    fun `close 4003 signs out and does not reconnect`() = runBlocking {
        checkNoReconnect(4003, SocketState.SignedOut)
    }

    @Test
    fun `close 4029 waits instead of reconnecting`() = runBlocking {
        checkNoReconnect(4029, SocketState.RateLimited)
    }

    private suspend fun checkNoReconnect(closeCode: Int, expected: SocketState) {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    webSocket.close(closeCode, "test")
                }
            }),
        )
        server.start()
        val sessions = MemorySessionStore().apply {
            save(Session(server.url("/").toString().trimEnd('/'), "token", ""), remember = true)
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val socket = MimiSocket(OkHttpClient(), sessions, AppInfo("1.0.0", "mimi.example.com"), scope)
        try {
            socket.start()
            withTimeout(10_000) {
                socket.state.first { it::class == expected::class }
            }
            delay(700)
            assertEquals(1, server.requestCount)
        } finally {
            socket.stop()
            scope.cancel()
            server.shutdown()
        }
    }
}
