package app.mimi.core.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class MessageFormatTest {
    @Test
    fun `inline formatting follows the web client`() {
        val spans = parseInline("ดู **สำคัญ** แล้ว *ยิ้ม* ที่ https://example.com/x กับ @มิมิ และ `code`")
        assertEquals(
            listOf(
                Span.Plain("ดู "), Span.Bold("สำคัญ"), Span.Plain(" แล้ว "), Span.Action("ยิ้ม"), Span.Plain(" ที่ "),
                Span.Link("https://example.com/x"), Span.Plain(" กับ "), Span.Mention("@มิมิ"), Span.Plain(" และ "), Span.Code("code"),
            ),
            spans,
        )
    }

    @Test
    fun `code blocks split paragraphs and keep their text as is`() {
        val blocks = parseBlocks("ก่อน\n```kotlin\nval x = **1**\n```\nหลัง")
        assertEquals(listOf(Block.Paragraph(listOf(Span.Plain("ก่อน"))), Block.Code("val x = **1**"), Block.Paragraph(listOf(Span.Plain("หลัง")))), blocks)
    }

    @Test
    fun `plain text and empty text are one paragraph`() {
        assertEquals(listOf(Block.Paragraph(listOf(Span.Plain("สวัสดี")))), parseBlocks("สวัสดี"))
        assertEquals(listOf(Block.Paragraph(emptyList())), parseBlocks(""))
    }
}
