package app.mimi.core.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Frames as a core sent them (recorded from a local core, docs/native/realtime.md 4.2). */
class ChatTimelineTest {
    private fun frames(vararg json: String) = json.map(::parseServerFrame)

    private val turn = frames(
        """{"type":"busy","chatId":1}""",
        """{"type":"chat-session","chatId":1,"session":{"id":1,"chatId":1,"title":"","summary":"","auto":true,"createdAt":"x","lastMessageAt":"x","readAt":"x","unread":false},"started":true}""",
        """{"type":"chat-message","chatId":1,"sessionId":1,"message":{"id":1,"role":"user","agent":"","text":"สวัสดี","createdAt":"x","attachments":[],"tools":[],"replyTo":null,"forwardedFrom":null,"clientId":"c-1"}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-start","traceId":"t","agent":"mimi","model":"mock/m1","userMessageId":1}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"สวัสดี"}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"ค่ะ "}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"tool-call","call":{"id":"k1","name":"web_search","input":{"q":"x"}},"risk":"read"}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"tool-result","result":{"callId":"k1","name":"web_search","ok":true,"output":"found"}}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"text-delta","text":"**ทดสอบ**"}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"usage","round":1,"usage":{"inputTokens":1,"outputTokens":1,"cachedTokens":0,"costUsd":0}}}""",
        """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-finish","traceId":"t","reason":"stop","rounds":1,"usage":{},"contextTokens":1,"text":"**ทดสอบ**","speech":{"emotion":"ยินดี"}}}""",
    )

    @Test
    fun `a streamed turn becomes a bubble with tools, then the stored messages replace it`() {
        var state = ChatTimeline(chatId = 1).addPending(PendingMessage("c-1", "สวัสดี", emptyList()))
        for (frame in turn) state = state.reduce(frame)
        assertTrue(state.busy)
        assertTrue("the echo replaces the pending bubble", state.pending.isEmpty())
        assertEquals(listOf(1L), state.messages.map { it.id })
        val live = state.live!!
        assertEquals("mimi", live.agent)
        assertTrue(live.finished)
        assertEquals("ยินดี", live.speech?.emotion)
        val kinds = live.segments.map { it::class.simpleName }
        assertEquals(listOf("Text", "Tool", "Text"), kinds)
        assertEquals("สวัสดีค่ะ ", (live.segments[0] as LiveSegment.Text).raw)
        assertEquals(true, (live.segments[1] as LiveSegment.Tool).ok)
        assertEquals("**ทดสอบ**", (live.segments[2] as LiveSegment.Text).raw)

        state = state.reduce(parseServerFrame("""{"type":"chat-turn-messages","chatId":1,"sessionId":1,"afterId":1,"messages":[{"id":2,"role":"assistant","agent":"mimi","text":"**ทดสอบ**","speech":{"emotion":"ยินดี"},"createdAt":"x","attachments":[],"tools":[{"name":"web_search","summary":"x"}]}]}"""))
        state = state.reduce(parseServerFrame("""{"type":"busy","chatId":1,"done":true}"""))
        assertNull(state.live)
        assertEquals(listOf(1L, 2L), state.messages.map { it.id })
        assertEquals(false, state.busy)
    }

    @Test
    fun `frames of another chat or an older session change nothing`() {
        val start = ChatTimeline(chatId = 1, session = SessionView(id = 5, chatId = 1))
        val other = start.reduce(parseServerFrame("""{"type":"chat-event","chatId":2,"sessionId":9,"agent":"a","event":{"type":"text-delta","text":"x"}}"""))
        val older = start.reduce(parseServerFrame("""{"type":"chat-event","chatId":1,"sessionId":4,"agent":"a","event":{"type":"text-delta","text":"x"}}"""))
        assertEquals(start, other)
        assertEquals(start, older)
    }

    @Test
    fun `a failed send marks the pending bubble and a turn error becomes a note`() {
        var state = ChatTimeline(chatId = 1).addPending(PendingMessage("c-9", "x", emptyList()))
        state = state.reduce(parseServerFrame("""{"type":"error","message":"Chat #1 does not exist.","code":"E-CONFIG","clientId":"c-9","requestType":"chat-send"}"""))
        assertEquals("Chat #1 does not exist.", state.pending.single().failed)
        state = state.reduce(parseServerFrame("""{"type":"error","message":"rate","code":"E-RATE-429","chatId":1}"""))
        assertEquals("[E-RATE-429] rate", state.notes.single().text)
    }

    @Test
    fun `afterId adds only newer messages and an older page goes in front`() {
        val history = """{"type":"chat-history","chat":{"id":1,"kind":"direct","agents":["mimi"]},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":5,"role":"user","text":"a"},{"id":6,"role":"assistant","text":"b"}],"hasMore":true}"""
        var state = ChatTimeline(chatId = 1).reduce(parseServerFrame(history))
        state = state.reduce(parseServerFrame("""{"type":"chat-history","chat":{"id":1,"kind":"direct"},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":7,"role":"user","text":"c"}],"hasMore":false,"afterId":6}"""))
        assertEquals(listOf(5L, 6L, 7L), state.messages.map { it.id })
        state = state.reduce(parseServerFrame("""{"type":"chat-history","chat":{"id":1,"kind":"direct"},"session":{"id":1,"chatId":1},"sessions":[],"messages":[{"id":3,"role":"user","text":"z"}],"hasMore":false,"beforeId":5}"""))
        assertEquals(listOf(3L, 5L, 6L, 7L), state.messages.map { it.id })
        assertEquals(false, state.hasMore)
    }

    @Test
    fun `a handoff keeps the first answer until the turn's messages come`() {
        var state = ChatTimeline(chatId = 1, session = SessionView(id = 1, chatId = 1))
        for (json in listOf(
            """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"run-start","agent":"a","model":"m"}}""",
            """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"text-delta","text":"ส่งต่อนะ"}}""",
            """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"a","event":{"type":"run-finish","reason":"handoff","text":"ส่งต่อนะ","handoff":{"messageId":3,"to":"b"}}}""",
            """{"type":"chat-event","chatId":1,"sessionId":1,"agent":"b","event":{"type":"run-start","agent":"b","model":"m"}}""",
        )) state = state.reduce(parseServerFrame(json))
        assertEquals(listOf("a"), state.earlier.map { it.agent })
        assertEquals("b", state.live?.agent)
        assertEquals("↪ ส่งต่อให้ b", state.notes.single().text)
    }

    @Test
    fun `permission requests, also from a sub-agent, wait until resolved`() {
        var state = ChatTimeline(chatId = 1)
        val ask = """{"type":"chat-event","chatId":1,"sessionId":0,"agent":"a","event":{"type":"agent-activity","agent":"helper","messageId":1,"event":{"type":"permission-request","request":{"id":"p1","traceId":"t","agent":"helper","tool":"write_file","risk":"write","input":{"path":"x"},"summary":"เขียนไฟล์","timeoutMs":900000,"createdAt":"x"}}}}"""
        state = state.reduce(parseServerFrame(ask))
        assertEquals("write_file", state.permissions.single().tool)
        state = state.reduce(parseServerFrame("""{"type":"permission-resolved","requestId":"p1","decision":{"allow":true,"via":"user"}}"""))
        assertTrue(state.permissions.isEmpty())
    }
}
