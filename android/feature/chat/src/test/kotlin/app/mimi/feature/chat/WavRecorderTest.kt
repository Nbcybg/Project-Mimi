package app.mimi.feature.chat

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class WavRecorderTest {
    @Test
    fun `a recording is 16-bit mono PCM WAV the core can transcribe`() {
        val pcm = ByteArray(32_000) { (it % 7).toByte() }
        val wav = WavRecorder.wav(pcm, 16_000)
        val header = ByteBuffer.wrap(wav, 0, 44).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(wav, 0, 4))
        assertEquals(36 + pcm.size, header.getInt(4))
        assertEquals("WAVE", String(wav, 8, 4))
        assertEquals(1, header.getShort(20).toInt()) // PCM
        assertEquals(1, header.getShort(22).toInt()) // mono
        assertEquals(16_000, header.getInt(24))
        assertEquals(16, header.getShort(34).toInt())
        assertEquals(pcm.size, header.getInt(40))
        assertEquals(44 + pcm.size, wav.size)
    }
}
