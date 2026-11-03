package app.mimi.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckerTest {
    @Test
    fun `versions compare by number, ignoring a v prefix and anything after a dash`() {
        assertTrue(newerVersion("v1.2.10", "1.2.9"))
        assertTrue(newerVersion("v0.9.0-prototype", "0.8.1-prototype"))
        assertFalse(newerVersion("v0.8.1", "0.8.1-prototype"))
        assertFalse(newerVersion("v0.8.0", "0.8.1"))
        assertTrue(newerVersion("1.0", "0.99.99"))
    }
}
