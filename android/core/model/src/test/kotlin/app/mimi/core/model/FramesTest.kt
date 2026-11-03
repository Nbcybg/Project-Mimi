package app.mimi.core.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FramesTest {
    @Test
    fun `welcome carries the core's API version and an old core reads as 0`() {
        val new = parseServerFrame("""{"type":"welcome","agents":[{"name":"mimi"}],"defaultAgent":"mimi","pcOnline":false,"busy":false,"busyChats":[3],"pendingPermissions":[],"version":"0.8.1","api":1,"minClientApi":1}""") as ServerFrame.Welcome
        assertEquals(1, new.api)
        assertEquals(1, new.minClientApi)
        assertEquals(listOf(3L), new.busyChats)
        val old = parseServerFrame("""{"type":"welcome","agents":[],"defaultAgent":"","pendingPermissions":[]}""") as ServerFrame.Welcome
        assertEquals(0, old.api)
    }

    @Test
    fun `unknown and broken frames never throw`() {
        assertEquals(ServerFrame.Unknown("from-the-future"), parseServerFrame("""{"type":"from-the-future","x":1}"""))
        assertEquals(ServerFrame.Unknown(""), parseServerFrame("not json"))
        assertEquals(ServerFrame.Unknown("chat-message"), parseServerFrame("""{"type":"chat-message"}"""))
    }

    @Test
    fun `client frames - hello names the platform and the client API`() {
        val hello = MimiJson.parseToJsonElement(ClientFrames.hello("tok", "1.0.0")).toString()
        assertTrue(hello.contains(""""client":{"platform":"android","version":"1.0.0","api":$CLIENT_API}"""))
        assertEquals("""{"type":"presence","chatId":null,"visible":false}""", ClientFrames.presence(null, false))
        assertEquals("""{"type":"permission-response","requestId":"p","allow":false}""", ClientFrames.permissionResponse("p", false, "always"))
    }

    @Test
    fun `speech direction lines are held back while streaming and parsed at the end`() {
        assertEquals("", parseSpeech("[emotion: ดีใจ", live = true).text)
        val done = parseSpeech("[emotion: ดีใจ][speed: 3]\nสวัสดี")
        assertEquals("สวัสดี", done.text)
        assertEquals(2.0, done.speech?.speed)
        assertEquals("[1] ไม่ใช่", parseSpeech("[1] ไม่ใช่").text)
    }
}
