package app.mimi.core.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EmojiKeyTest {
    @Test
    fun `the key is the code points in hex without the emoji selector`() {
        assertEquals("2764", emojiKey("❤️"))
        assertEquals("1f60a", emojiKey("😊"))
        assertEquals("1f468-200d-1f4bb", emojiKey("👨‍💻"))
    }

    @Test
    fun `the last emoji of a reply is its mood`() {
        assertEquals("1f60a", lastEmojiKey("สวัสดีค่ะ 😊"))
        assertEquals("1f602", lastEmojiKey("😊 ดีใจจัง 😂 ขำมาก"))
        assertEquals("2764", lastEmojiKey("รักนะ ❤️"))
        assertNull(lastEmojiKey("ไม่มีอีโมจิ 123 ABC"))
        assertNull(lastEmojiKey(""))
    }
}
