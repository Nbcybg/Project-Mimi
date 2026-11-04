package app.mimi.feature.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class SearchHighlightTest {
    @Test
    fun `the match between double stars becomes a highlighted part`() {
        assertEquals(listOf("สวัสดี" to true, "ค่ะ ทดสอบ" to false), highlightParts("**สวัสดี**ค่ะ ทดสอบ"))
        assertEquals(listOf("ก่อน " to false, "คำ" to true, " หลัง " to false, "คำ" to true), highlightParts("ก่อน **คำ** หลัง **คำ**"))
        assertEquals(listOf("ไม่มีเครื่องหมาย" to false), highlightParts("ไม่มีเครื่องหมาย"))
    }
}
