package app.mimi.core.data

import app.mimi.core.data.net.MimiSocket
import app.mimi.core.data.net.ServerAddress
import app.mimi.core.data.repo.AuthRepository
import app.mimi.core.data.repo.ProbeResult
import app.mimi.core.data.repo.SignInResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AuthRepositoryTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var sessions: MemorySessionStore
    private lateinit var scope: CoroutineScope
    private lateinit var socket: MimiSocket
    private lateinit var repository: AuthRepository

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient()
        sessions = MemorySessionStore()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        socket = MimiSocket(client, sessions, AppInfo("1.0.0", ""), scope)
        repository = AuthRepository(client, sessions, socket)
    }

    @After
    fun tearDown() {
        socket.stop()
        scope.cancel()
        server.shutdown()
    }

    private val origin: String get() = server.url("/").toString().trimEnd('/')

    private fun health(minClientApi: Int = 0, accounts: Boolean = false): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody("""{"ok":true,"version":"0.8.1","api":1,"minClientApi":$minClientApi,"accounts":$accounts}""")

    private fun login(token: String = "tok", username: String = "alice"): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody("""{"token":"$token","username":"$username","expiresAt":"2026-12-02T11:00:02.162Z","webhookBase":""}""")

    @Test
    fun `a bare host becomes https and a typed path is dropped`() {
        assertEquals("https://mimi.example.com", ServerAddress.normalize("  mimi.example.com/chat?x=1  "))
        assertEquals("http://10.0.2.2:8787", ServerAddress.normalize("http://10.0.2.2:8787/"))
        assertEquals("ws://10.0.2.2:8787/ws", ServerAddress.socket("http://10.0.2.2:8787"))
        assertEquals("wss://mimi.example.com/ws", ServerAddress.socket("https://mimi.example.com"))
    }

    @Test
    fun `probe keeps explicit http and asks health on the origin only`() = runBlocking {
        server.enqueue(health())
        val result = repository.probe("$origin/deep/path")
        assertTrue(result is ProbeResult.Ok)
        assertEquals(origin, (result as ProbeResult.Ok).server)
        assertEquals("/health", server.takeRequest().path)
    }

    @Test
    fun `probe reports a core that needs a newer app`() = runBlocking {
        server.enqueue(health(minClientApi = 2))
        val result = repository.probe(origin)
        assertTrue(result is ProbeResult.AppTooOld)
        assertEquals(origin, (result as ProbeResult.AppTooOld).server)
    }

    @Test
    fun `a gateway login succeeds and remembers the session`() = runBlocking {
        server.enqueue(health(accounts = true))
        server.enqueue(login())
        assertTrue(repository.probe(origin) is ProbeResult.Ok)
        val result = repository.signInWithPassword("alice", "pw", null, remember = true)
        assertEquals(SignInResult.Success, result)
        assertEquals(origin, sessions.session.value.server)
        assertEquals("tok", sessions.session.value.token)
        assertEquals("alice", sessions.session.value.username)
    }

    @Test
    fun `401 with twoFactor asks for the authenticator code`() = runBlocking {
        server.enqueue(health(accounts = true))
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Enter the code from your authenticator app.","twoFactor":true}"""),
        )
        assertTrue(repository.probe(origin) is ProbeResult.Ok)
        val result = repository.signInWithPassword("alice", "pw", null, remember = true)
        assertTrue(result is SignInResult.NeedsCode)
        assertEquals("Enter the code from your authenticator app.", (result as SignInResult.NeedsCode).message)
    }

    @Test
    fun `a wrong password is a readable failure`() = runBlocking {
        server.enqueue(health(accounts = true))
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Wrong username or password."}"""),
        )
        assertTrue(repository.probe(origin) is ProbeResult.Ok)
        val result = repository.signInWithPassword("alice", "wrong", null, remember = true)
        assertTrue(result is SignInResult.Failed)
        assertTrue((result as SignInResult.Failed).message.contains("ชื่อผู้ใช้"))
    }

    @Test
    fun `too many wrong attempts is a readable failure`() = runBlocking {
        server.enqueue(health(accounts = true))
        server.enqueue(
            MockResponse()
                .setResponseCode(429)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Too many wrong attempts. Try again later."}"""),
        )
        assertTrue(repository.probe(origin) is ProbeResult.Ok)
        val result = repository.signInWithPassword("alice", "wrong", null, remember = true)
        assertTrue(result is SignInResult.Failed)
        assertTrue((result as SignInResult.Failed).message.contains("หลายครั้ง"))
    }
}
