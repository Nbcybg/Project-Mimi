package app.mimi.feature.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GuestSpeakerTest {
    @Test
    fun `another agent speaking in a one-to-one chat is a guest, the chat's own agent is not`() {
        assertTrue(isGuest("tim", "mimi"))
        assertFalse(isGuest("tim", "tim"))
    }

    @Test
    fun `a group chat has no owner, so nobody is a guest, and an unnamed speaker never is`() {
        assertFalse(isGuest(null, "mimi"))
        assertFalse(isGuest("tim", ""))
    }
}
