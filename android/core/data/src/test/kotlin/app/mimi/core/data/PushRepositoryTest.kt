package app.mimi.core.data

import app.mimi.core.data.repo.KeyValueStore
import app.mimi.core.data.repo.PushRepository
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PushRepositoryTest {
    private class FakeStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun getString(key: String): String? = values[key]
        override fun putString(key: String, value: String) { values[key] = value }
        override fun remove(key: String) { values.remove(key) }
    }

    private lateinit var server: MockWebServer
    private lateinit var store: FakeStore
    private lateinit var repository: PushRepository

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        store = FakeStore()
        val sessions = MemorySessionStore().apply {
            save(Session(server.url("/").toString().trimEnd('/'), "token", ""), remember = true)
        }
        repository = PushRepository(OkHttpClient(), sessions, AppInfo("1.0.0", ""), store)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `the first poll reports only unread items and remembers the highest id`() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody("""[{"id":5,"kind":"message","read":true},{"id":6,"kind":"message","read":false}]"""),
        )

        val first = repository.newNotifications()

        assertEquals(listOf(6L), first.map { it.id })
        assertEquals("/api/notifications?afterId=0", server.takeRequest().path)
        assertEquals("6", store.getString("notifications.lastId"))

        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody("""[{"id":7,"kind":"message","read":true},{"id":8,"kind":"message","read":false}]"""),
        )

        val later = repository.newNotifications()

        assertEquals(listOf(7L, 8L), later.map { it.id })
        assertTrue(later.first().read)
        assertFalse(later.last().read)
        assertEquals("/api/notifications?afterId=6", server.takeRequest().path)
        assertEquals("8", store.getString("notifications.lastId"))
    }
}
